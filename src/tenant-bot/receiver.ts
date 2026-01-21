import WebSocket from 'ws';
import type { App, Receiver } from '@slack/bolt';

type ProxyReceiverOptions = {
  url: string;
  jwt: string;
  reconnectDelayMs?: number;
};

type SocketModeEnvelope = {
  envelope_id?: string;
  type?: string;
  payload?: any;
  retry_attempt?: number;
  retry_reason?: string;
};

export class ProxyReceiver implements Receiver {
  private app?: App;
  private ws?: WebSocket;
  private readonly url: string;
  private readonly jwt: string;
  private readonly reconnectDelayMs: number;
  private stopped = false;

  constructor(options: ProxyReceiverOptions) {
    this.url = options.url;
    this.jwt = options.jwt;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  }

  init(app: App) {
    this.app = app;
  }

  async start() {
    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'shutdown');
    }
  }

  private connect() {
    if (this.stopped) {
      return;
    }

    this.ws = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.jwt}` },
    });

    this.ws.on('open', () => {
      console.log(`Proxy WS connected: ${this.url}`);
    });

    this.ws.on('message', async (buf) => {
      const raw = buf.toString();
      let envelope: SocketModeEnvelope | null = null;
      try {
        envelope = JSON.parse(raw);
      } catch {
        console.warn('Proxy WS message parse failed');
        return;
      }

      if (envelope?.type === 'hello' || envelope?.type === 'ping') {
        return;
      }

      const envelopeType =
        envelope?.type ?? envelope?.payload?.type ?? (envelope as any)?.body?.type;
      const messageText =
        envelope?.payload?.event?.text ??
        (envelope as any)?.body?.event?.text ??
        (envelope as any)?.event?.text ??
        envelope?.payload?.text ??
        (envelope as any)?.body?.text;
      console.log('Proxy WS received envelope', {
        envelopeId: envelope?.envelope_id,
        type: envelopeType,
        text: messageText,
      });

      try {
        await this.handleEnvelope(envelope);
      } catch (error) {
        console.error('Proxy WS handle failed', error);
      }
    });

    this.ws.on('close', (code, reason) => {
      const detail = reason ? ` (${code} ${reason.toString()})` : ` (${code})`;
      console.warn(`Proxy WS disconnected${detail}. Reconnecting in ${this.reconnectDelayMs}ms`);
      if (this.stopped) {
        return;
      }
      setTimeout(() => this.connect(), this.reconnectDelayMs);
    });

    this.ws.on('error', (error) => {
      console.error('Proxy WS error', error);
      this.ws?.close();
    });
  }

  private async handleEnvelope(envelope: SocketModeEnvelope | null) {
    if (!this.app || !envelope) {
      return;
    }

    const body = envelope.payload ?? (envelope as any).body ?? envelope;
    const responseUrl =
      body?.response_url || body?.response_urls?.[0]?.response_url || body?.payload?.response_url;

    const respond =
      responseUrl && typeof responseUrl === 'string'
        ? async (response: any) => {
            try {
              const res = await fetch(responseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(response),
              });
              if (!res.ok) {
                let errorBody: string | undefined;
                try {
                  errorBody = await res.text();
                } catch {
                  // ignore body read errors
                }
                console.error('Failed to send response to Slack', {
                  responseUrl,
                  status: res.status,
                  statusText: res.statusText,
                  body: errorBody,
                });
              }
            } catch (error) {
              console.error('Error sending response to Slack', { responseUrl, error });
            }
          }
        : undefined;

    const envelopeType =
      envelope.type ?? (envelope as any).payload?.type ?? (envelope as any).body?.type;
    console.log('Dispatching envelope to Bolt', {
      envelopeId: envelope.envelope_id,
      type: envelopeType,
    });

    try {
      await this.app.processEvent({
        body,
        ack: async () => {},
        retryNum: envelope.retry_attempt,
        retryReason: envelope.retry_reason,
        customProperties: {
          envelope_id: envelope.envelope_id,
          envelope_type: envelopeType,
        },
        ...(respond ? { respond } : {}),
      } as any);
    } catch (error) {
      console.error('Bolt processEvent failed', error);
    }
  }
}

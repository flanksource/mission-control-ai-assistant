import { SocketModeClient } from '@slack/socket-mode';
import { LogLevel } from '@slack/logger';

export type SocketModeEnvelope = {
  envelope_id: string;
  type: string;
  payload: any;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
};

export async function startSocketMode({
  appToken,
  onEnvelope,
  onConnected,
  onDisconnected,
}: {
  appToken: string;
  onEnvelope: (envelope: SocketModeEnvelope) => Promise<void>;
  onConnected?: () => void;
  onDisconnected?: () => void;
}) {
  const client = new SocketModeClient({
    appToken,
    logLevel: LogLevel.INFO,
  });

  client.on('slack_event', async (event: any) => {
    try {
      await event.ack?.();
    } catch {
      // Slack will retry if ack is missed; we still proceed best-effort.
    }

    await onEnvelope({
      envelope_id: event.envelope_id,
      type: event.type,
      payload: event.body,
      accepts_response_payload: event.accepts_response_payload,
      retry_attempt: event.retry_num,
      retry_reason: event.retry_reason,
    });
  });

  client.on('connected', () => {
    console.log('Socket Mode connected');
    onConnected?.();
  });

  client.on('disconnected', () => {
    console.log('Socket Mode disconnected');
    onDisconnected?.();
  });

  client.on('error', (error) => {
    console.error('Socket Mode error', error);
  });

  await client.start();
  return client;
}

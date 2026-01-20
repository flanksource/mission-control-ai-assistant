import WebSocket, { WebSocketServer } from 'ws';
import { verifyTenantJwt, type TenantClaims } from './auth';

type TenantSocket = {
  tenantId: string;
  claims: TenantClaims;
  ws: WebSocket;
};

export type TenantSocketServer = {
  getTenantSocket: (tenantId: string) => WebSocket | undefined;
  tenantCount: () => number;
  close: () => Promise<void>;
};

export function startTenantSocketServer({
  port,
  jwtSecret,
}: {
  port: number;
  jwtSecret: string;
}): TenantSocketServer {
  const tenants = new Map<string, TenantSocket>();
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws, req) => {
    const authHeader = (req.headers['authorization'] || '').toString();
    const token = authHeader.replace(/^Bearer\s+/i, '');

    let claims: TenantClaims;
    try {
      claims = verifyTenantJwt(token, jwtSecret);
    } catch (error) {
      console.warn('Tenant WS auth failed', error);
      ws.close(1008, 'unauthorized');
      return;
    }

    const tenantId = claims.tenant_id;
    console.log(`Tenant WS connected: ${tenantId}`);
    const existing = tenants.get(tenantId);
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(4001, 'replaced');
    }

    tenants.set(tenantId, { tenantId, claims, ws });

    ws.on('close', (code, reason) => {
      const detail = reason ? ` (${code} ${reason.toString()})` : ` (${code})`;
      console.log(`Tenant WS disconnected: ${tenantId}${detail}`);
      const current = tenants.get(tenantId);
      if (current?.ws === ws) {
        tenants.delete(tenantId);
      }
    });
  });

  return {
    getTenantSocket: (tenantId: string) => tenants.get(tenantId)?.ws,
    tenantCount: () => tenants.size,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}

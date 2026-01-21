import WebSocket, { WebSocketServer } from 'ws';
import { verifyTenantJwt, type TenantClaims } from './auth';
import { buildRoutingKeys, type RoutingIds } from './router';

type TenantSocket = {
  routingKeys: string[];
  claims: TenantClaims;
  ws: WebSocket;
};

export type TenantSocketServer = {
  getTenantSocket: (ids: RoutingIds) => WebSocket | undefined;
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

    const routingKeys = buildRoutingKeys({
      teamId: claims.team_id,
      enterpriseId: claims.enterprise_id,
    });
    if (routingKeys.length === 0) {
      console.warn('Tenant WS missing routing IDs');
      ws.close(1008, 'missing routing ids');
      return;
    }

    console.log(`Tenant WS connected: ${routingKeys.join(', ')}`);
    const replaced = new Set<WebSocket>();
    for (const key of routingKeys) {
      const existing = tenants.get(key);
      if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
        replaced.add(existing.ws);
      }
      tenants.set(key, { routingKeys, claims, ws });
    }
    for (const existingWs of replaced) {
      existingWs.close(4001, 'replaced');
    }

    ws.on('close', (code, reason) => {
      const detail = reason ? ` (${code} ${reason.toString()})` : ` (${code})`;
      console.log(`Tenant WS disconnected: ${routingKeys.join(', ')}${detail}`);
      for (const key of routingKeys) {
        const current = tenants.get(key);
        if (current?.ws === ws) {
          tenants.delete(key);
        }
      }
    });
  });

  return {
    getTenantSocket: (ids: RoutingIds) => {
      for (const key of buildRoutingKeys(ids)) {
        const ws = tenants.get(key)?.ws;
        if (ws) {
          return ws;
        }
      }
      return undefined;
    },
    tenantCount: () => {
      const unique = new Set<WebSocket>();
      for (const tenant of tenants.values()) {
        unique.add(tenant.ws);
      }
      return unique.size;
    },
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}

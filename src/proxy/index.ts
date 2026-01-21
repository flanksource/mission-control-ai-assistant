import 'dotenv/config';
import http from 'http';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import { SQL } from 'bun';
import { extractRoutingIds, lookupTenantId } from './router';
import { startSocketMode } from './slack';
import { startTenantSocketServer } from './ws';
import { runMigrations } from './migrations';
import { requireEnv } from '../shared/env';
import { isUserActionEvent } from '../shared/slack';

requireEnv(['SLACK_APP_TOKEN', 'PROXY_JWT_SECRET']);

const wsPort = Number(process.env.PROXY_WS_PORT ?? 12000);
const httpPort = Number(process.env.PROXY_HTTP_PORT ?? 11000);

const dbPath = process.env.SQLITE_DB_PATH ?? './database.db';
const dbDir = path.dirname(dbPath);
if (dbDir && dbDir !== '.' && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`Opening SQLite database at: ${dbPath}`);
const db = new SQL({ adapter: 'sqlite', filename: dbPath });
await runMigrations(db);

const tenantServer = startTenantSocketServer({
  port: wsPort,
  jwtSecret: process.env.PROXY_JWT_SECRET!,
});

const metrics = {
  eventsIn: 0,
  eventsForwarded: 0,
  eventsDropped: 0,
};

let slackConnected = false;
let shuttingDown = false;

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const slackClient = await startSocketMode({
  appToken: process.env.SLACK_APP_TOKEN!,
  onEnvelope: async (envelope) => {
    metrics.eventsIn += 1;

    const payload = (envelope as any).payload ?? (envelope as any).body ?? envelope;
    const ids = extractRoutingIds(payload);
    const tenantId = await lookupTenantId(db, ids);
    if (!tenantId) {
      metrics.eventsDropped += 1;
      console.warn('No mapping found for routing IDs', ids);
      return;
    }

    const ws = tenantServer.getTenantSocket(tenantId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      metrics.eventsDropped += 1;
      console.warn('Tenant offline', { tenantId, ...ids });
      return;
    }

    ws.send(JSON.stringify(envelope));
    if (isUserActionEvent(payload)) {
      console.debug('Forwarded envelope', {
        envelope_id: envelope.envelope_id,
        team_id: ids.teamId,
      });
    }
    metrics.eventsForwarded += 1;
  },
  onConnected: () => {
    slackConnected = true;
  },
  onDisconnected: () => {
    slackConnected = false;
  },
});

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const body = JSON.stringify({
      ok: true,
      slackConnected,
      tenantsOnline: tenantServer.tenantCount(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (req.url === '/metrics') {
    const lines = [
      `proxy_events_in ${metrics.eventsIn}`,
      `proxy_events_forwarded ${metrics.eventsForwarded}`,
      `proxy_events_dropped ${metrics.eventsDropped}`,
      `proxy_tenants_online ${tenantServer.tenantCount()}`,
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(httpPort, () => {
  console.log(`Proxy HTTP server listening on :${httpPort}`);
  console.log(`Proxy WS server listening on :${wsPort}`);
});

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Shutting down on ${signal}`);
  const forceExitTimer = setTimeout(() => {
    console.warn('Forcing shutdown');
    process.exit(0);
  }, 2000);

  try {
    (slackClient as any)?.disconnect?.();
  } catch {
    // ignore
  }

  try {
    await tenantServer.close();
  } catch {
    // ignore
  }

  server.close();

  try {
    (db as any)?.close?.();
  } catch {
    // ignore
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

# Project Agent Notes

## Entry points

- Proxy: `src/proxy/index.ts`
- Tenant bot: `src/tenant-bot/index.ts`

## Runtime

- Bun (latest)

## Env (minimum)

### Proxy

- `SLACK_APP_TOKEN`
- `PROXY_JWT_SECRET`

### Tenant

- `SLACK_BOT_TOKEN`
- `PROXY_WS_URL` (default proxy WS: `ws://localhost:12000`)
- `PROXY_JWT`

## Ports (defaults)

- Proxy HTTP: `11000`
- Proxy WS: `12000`

## Auth

- Proxy uses HS256 JWT for tenant auth.
- JWT payload must include `team_id` and/or `enterprise_id`.

## Run

- `bun run start:proxy`
- `bun run start:tenant`

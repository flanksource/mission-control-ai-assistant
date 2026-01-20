# Mission Control Assistant Slack Bot

Multi-tenant Slack bot setup with a **Socket Mode proxy** and **tenant bots**. Built with TypeScript and Bun. The proxy holds the **app token** (`xapp-...`) and forwards Socket Mode envelopes to tenant bots over WebSocket. Tenant bots hold only **bot tokens** (`xoxb-...`) and process events via Bolt with a custom receiver.

## Features

- 🤖 AI-powered responses using Claude or OpenAI models
- 💬 Responds to direct messages and @mentions
- 🔌 MCP integration for extended functionality (catalog search, health checks, playbooks, etc.)
- ✅ Tool approval workflow for sensitive operations
- ⚡ Proxy uses Socket Mode; tenants run Bolt with a custom receiver

## Setup

### 1. Create and Configure Slack App

1. Create a new Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** under Settings → Basic Information → Socket Mode
3. Add the following **Bot Token Scopes** under OAuth & Permissions:
   - `app_mentions:read` - View messages that mention the app
   - `chat:write` - Send messages
   - `groups:history` - View messages in private channels
   - `im:history` - View messages in DMs
   - `im:read` - View basic info about DMs
   - `im:write` - Start direct messages
   - `reactions:read` - View emoji reactions
   - `reactions:write` - Add emoji reactions
4. Enable **Event Subscriptions** under Features → Event Subscriptions
5. Add the following **Bot Events** under Subscribe to bot events:
   - `app_mention` - Subscribe to message events that mention your app
   - `message.im` - Subscribe to messages in direct message channels
6. Install the app to your workspace under OAuth & Permissions
7. Create an **app-level token** from Settings → Basic Information → App-Level Tokens with the `connections:write` scope (required for Socket Mode)

### 2. Environment Configuration

Copy the service-specific example file and configure:

```bash
cp .env.proxy.example .env.proxy
cp .env.tenant.example .env.tenant
```

The `start:proxy` and `start:tenant` scripts automatically load these files via `DOTENV_CONFIG_PATH`. If you run the entry points directly, set `DOTENV_CONFIG_PATH` yourself.

#### Proxy (`.env.proxy`)

```bash
# Proxy
SLACK_APP_TOKEN=xapp-...
PROXY_JWT_SECRET=super-secret

# Optional: Storage
SQLITE_DB_PATH=./data/slack.db

# Optional: Ports
PROXY_HTTP_PORT=11000
PROXY_WS_PORT=12000
```

#### Tenant bot (`.env.tenant`)

```bash
# Tenant bot
SLACK_BOT_TOKEN=xoxb-...
PROXY_WS_URL=ws://proxy:12000
PROXY_JWT=your-tenant-jwt

# Required: At least one LLM provider
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_GENERATIVE_AI_API_KEY=...

# Optional: Model selection (defaults: claude-haiku-4-5, gpt-5.2-chat-latest, gemini-3-flash-preview)
LLM_MODEL=claude-haiku-4-5

# Optional: Logging level (DEBUG, INFO, WARN, ERROR)
LOG_LEVEL=INFO

# Optional: MCP server integration
MCP_URL=http://localhost:8080/mcp
MCP_BEARER_TOKEN=your-bearer-token
```

### 3. Install Dependencies

```bash
bun install
```

## Run

```bash
bun run start:proxy
bun run start:tenant
```

## Helm Charts

This repo ships two charts:

- `charts/proxy` → `mission-control-ai-assistant-proxy`
- `charts/tenant` → `mission-control-ai-assistant-tenant`

Images are published separately:

- `ghcr.io/flanksource/mission-control-ai-assistant-proxy`
- `ghcr.io/flanksource/mission-control-ai-assistant-tenant`

The proxy connects to Slack via Socket Mode. The tenant bot receives forwarded events and responds to:

- Direct messages sent to the bot
- @mentions in channels and groups

The proxy runs an idempotent SQLite migration on startup to ensure the
`slack_installations` table exists.

## Generate Tenant JWT

Use the helper script (HS256) to mint a tenant JWT:

```bash
PROXY_JWT_SECRET=super-secret bun run scripts/gen-tenant-jwt.ts --tenant tenant-123
```

Optional flags:

- `--iss` / `--aud` to set issuer/audience
- `--exp` to set expiry (default: `30d`)

## Logging

Control log verbosity with the `LOG_LEVEL` environment variable:

```bash
LOG_LEVEL=DEBUG bun start
```

Available log levels (from most to least verbose):

- `DEBUG` - Detailed debug information
- `INFO` - General informational messages (default)
- `WARN` - Warning messages only
- `ERROR` - Error messages only

The log level can be set in your `.env` file or passed as an environment variable when starting the bot.

## MCP Integration

The bot supports connecting to an MCP server to extend its capabilities with custom tools. Configure `MCP_URL` and optionally `MCP_BEARER_TOKEN` to enable this feature.

Tools are automatically wrapped with an approval workflow - read-only operations like searching and viewing are auto-approved, while write operations require user approval in Slack.

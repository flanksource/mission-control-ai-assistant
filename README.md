# Mission Control Assistant Slack Bot

A Slack bot that responds to direct messages (DMs) and mentions using Slack Bolt in Socket Mode, built with TypeScript and Bun. The bot uses Anthropic Claude or OpenAI models via Vercel AI SDK and supports MCP (Model Context Protocol) integration for extended tool capabilities.

## Features

- 🤖 AI-powered responses using Claude or OpenAI models
- 💬 Responds to direct messages and @mentions
- 🔌 MCP integration for extended functionality (catalog search, health checks, playbooks, etc.)
- ✅ Tool approval workflow for sensitive operations
- ⚡ Built with Slack Bolt in Socket Mode

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

Copy `.env.example` to `.env` and configure:

```bash
# Required: Slack credentials
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Required: At least one LLM provider
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Optional: Model selection (defaults to claude-haiku-4-5)
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
bun start
```

The bot will connect to Slack via Socket Mode and respond to:

- Direct messages sent to the bot
- @mentions in channels and groups

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

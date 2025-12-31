# Slack Echo Bot

A minimal Slack bot that echoes direct messages (DMs) using Slack Bolt in Socket Mode.

## Setup

1. Create a Slack app and enable Socket Mode.
2. Add the **bot** token scopes: `app_mentions:read`, `chat:write`, `im:history`.
3. Install the app to your workspace.
4. Create an app-level token with the `connections:write` scope.

Copy `.env.example` to `.env` and fill in the tokens:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

## Run

```
npm install
npm start
```

The bot responds to direct messages (channel type `im`) and mentions in channels.

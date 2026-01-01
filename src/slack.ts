import { App, LogLevel, StringIndexed } from '@slack/bolt';
import { LanguageModelV3 } from '@ai-sdk/provider';
import { type ToolSet } from 'ai';
import { AppMentionEvent } from '@slack/types';
import { respondWithLLM } from './slack/respond';
import { isGenericMessageEvent, buildMessagesFromSlack } from './slack/messages';
import {
  decodeApprovalPayload,
  extractApprovalPayloadFromBlocks,
  handleApprovalDecision,
} from './slack/approvals';

function getLogLevel(level?: string): LogLevel {
  switch (level?.toUpperCase()) {
    case 'DEBUG':
      return LogLevel.DEBUG;
    case 'INFO':
      return LogLevel.INFO;
    case 'WARN':
      return LogLevel.WARN;
    case 'ERROR':
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
}

export async function slackApp(
  botToken: string,
  appToken: string,
  model: LanguageModelV3,
  tools?: ToolSet,
): Promise<App<StringIndexed>> {
  const app = new App({
    token: botToken,
    appToken: appToken,
    socketMode: true,
    logLevel: getLogLevel(process.env.LOG_LEVEL),
  });
  app.use(async ({ body, logger, next }) => {
    console.log(JSON.stringify(body, null, 2));
    if ('event' in body) {
      const eventLog: Record<string, any> = {
        type: body.event.type,
        text: body.event.text,
      };

      if (body.event.channel_type) {
        eventLog['channel_type'] = body.event.channel_type;
        eventLog['thread_ts'] = body.event.thread_ts;
      }

      logger.info(`New event ${JSON.stringify(eventLog)}`);
    }

    await next();
  });

  app.message(async ({ message, say, client, logger }) => {
    if (message.subtype || message.bot_id) {
      return;
    }

    if (message.channel_type !== 'im') {
      return;
    }

    if (!isGenericMessageEvent(message)) {
      return;
    }

    await respondWithLLM({ message, say, client, logger }, model, tools);
  });

  app.event('app_mention', async ({ event, say, client, logger }) => {
    const message = event as AppMentionEvent;
    await respondWithLLM({ message, say, client, logger }, model, tools);
  });

  app.action('tool_approval_approve', async ({ ack, body, client, logger }) => {
    await ack();

    const actionValue =
      'actions' in body && body.actions?.[0] && 'value' in body.actions[0]
        ? body.actions[0].value
        : undefined;
    const channel = 'channel' in body ? body.channel?.id : undefined;
    const message = 'message' in body ? body.message : undefined;
    const threadTs = message?.thread_ts ?? undefined;
    if (!channel) {
      logger.warn('Approval action missing channel');
      return;
    }

    const payload =
      (actionValue ? decodeApprovalPayload(actionValue) : null) ??
      extractApprovalPayloadFromBlocks(message?.blocks);
    if (!payload || payload.approvals.length === 0) {
      await client.chat.postMessage({
        channel,
        text: 'No pending tool approvals found for this thread.',
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    const messages = await buildMessagesFromSlack({
      client,
      channel,
      threadTs,
      botUserId: (await client.auth.test()).user_id,
    });
    await handleApprovalDecision({
      messages,
      approvals: payload.approvals,
      approved: true,
      model,
      tools,
      logger,
      post: async ({ text, blocks }) =>
        client.chat.postMessage({
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(blocks ? { blocks } : {}),
        }),
      update: async (message) => {
        await client.chat.update(message);
      },
      channel,
    });
  });

  app.action('tool_approval_deny', async ({ ack, body, client, logger }) => {
    await ack();

    const actionValue =
      'actions' in body && body.actions?.[0] && 'value' in body.actions[0]
        ? body.actions[0].value
        : undefined;
    const channel = 'channel' in body ? body.channel?.id : undefined;
    const message = 'message' in body ? body.message : undefined;
    const threadTs = message?.thread_ts ?? undefined;
    if (!channel) {
      logger.warn('Approval action missing channel');
      return;
    }

    const payload =
      (actionValue ? decodeApprovalPayload(actionValue) : null) ??
      extractApprovalPayloadFromBlocks(message?.blocks);
    if (!payload || payload.approvals.length === 0) {
      await client.chat.postMessage({
        channel,
        text: 'No pending tool approvals found for this thread.',
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    const messages = await buildMessagesFromSlack({
      client,
      channel,
      threadTs,
      botUserId: (await client.auth.test()).user_id,
    });
    await handleApprovalDecision({
      messages,
      approvals: payload.approvals,
      approved: false,
      reason: 'Denied by user',
      model,
      tools,
      logger,
      post: async ({ text, blocks }) =>
        client.chat.postMessage({
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(blocks ? { blocks } : {}),
        }),
      update: async (message) => {
        await client.chat.update(message);
      },
      channel,
    });
  });

  return app;
}

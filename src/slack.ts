import { App, LogLevel, SayFn, StringIndexed } from '@slack/bolt';
import { LanguageModelV3 } from '@ai-sdk/provider';
import type { AppMentionEvent, GenericMessageEvent } from '@slack/types';
import type { WebClient, Logger } from '@slack/web-api';
import {
  decodeApprovalPayload,
  extractApprovalPayloadFromBlocks,
  handleApprovalDecision,
  collectToolApprovalRequests,
  encodeApprovalPayload,
  formatApprovalPrompt,
  systemPrompt,
} from './slack/approvals';
import { generateText, ModelMessage, stepCountIs, type ToolSet } from 'ai';
import {
  buildApprovalBlocks,
  buildTextBlocks,
  extractTextFromBlocks,
  mergeMessageText,
} from './slack/blocks';
import { collectToolCalls, logToolCalls, postWithToolStatus } from './slack/tool_calls';

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

  const authTest = await app.client.auth.test({ token: botToken });
  if (!authTest.user_id) {
    throw new Error('Slack auth.test did not return a bot user id');
  }
  const botUserId = authTest.user_id;

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

    if (message.type !== 'message') {
      return;
    }

    client.reactions.add({
      channel: message.channel,
      name: 'eyes',
      timestamp: message.ts,
    });

    await respondWithLLM({ message, say, client, logger }, botUserId, model, tools);
  });

  app.event('app_mention', async ({ event, say, client, logger }) => {
    client.reactions.add({
      channel: event.channel,
      name: 'eyes',
      timestamp: event.ts,
    });

    const message = event as AppMentionEvent;
    await respondWithLLM({ message, say, client, logger }, botUserId, model, tools);
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

    const messages = await buildConversationFromSlackThread({
      client,
      channel,
      threadTs,
      botUserId,
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

    const messages = await buildConversationFromSlackThread({
      client,
      channel,
      threadTs,
      botUserId,
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

export async function buildConversationFromSlackThread({
  client,
  channel,
  threadTs,
  botUserId,
}: {
  client: WebClient;
  channel: string;
  threadTs: string;
  botUserId: string;
}): Promise<ModelMessage[]> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: 150, // to prevent high token usage for long threads
  });
  const slackMessages = result.messages ?? [];

  const messages: ModelMessage[] = [];
  for (const msg of slackMessages) {
    const blockText = extractTextFromBlocks(msg.blocks || []);
    const baseText = (msg.text ?? '').trim();
    const content = mergeMessageText(blockText, baseText);
    if (!content) continue;

    const isBot = msg.user === botUserId;
    messages.push({
      role: isBot ? 'assistant' : 'user',
      content: replaceBotMention(content, botUserId),
    });
  }

  return messages;
}

function replaceBotMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, '@assistant');
}

export type SlackMessage = AppMentionEvent | GenericMessageEvent;

export type SlackHandlerContext = {
  message: SlackMessage;
  say: SayFn;
  client: WebClient;
  logger: Logger;
};

export async function respondWithLLM(
  { message, say, client, logger }: SlackHandlerContext,
  botUserId: string,
  model: LanguageModelV3,
  tools?: ToolSet,
) {
  const blocks = 'blocks' in message ? (message.blocks ?? []) : [];
  const text = extractTextFromBlocks(blocks);
  const { channel } = message;
  const messageTs = message.ts;
  const threadTs = 'thread_ts' in message ? message.thread_ts : undefined;

  try {
    let messages: ModelMessage[] = [];
    if (!threadTs) {
      messages = [
        {
          role: 'user',
          content: (message.text || text).replaceAll(`<@${botUserId}>`, '@assistant'),
        },
      ];
    } else {
      messages = await buildConversationFromSlackThread({
        client,
        channel,
        threadTs,
        botUserId,
      });
    }

    console.log({ messages });

    const result = await generateText({
      model,
      messages,
      stopWhen: stepCountIs(20),
      system: systemPrompt,
      ...(tools ? { tools } : {}),
    });

    const responseMessages = result.response.messages ?? [];
    logToolCalls(responseMessages, logger);
    const toolCalls = collectToolCalls(responseMessages);

    const pendingApprovals = collectToolApprovalRequests(responseMessages);
    if (pendingApprovals.length > 0) {
      const prompt = formatApprovalPrompt(pendingApprovals);
      const replyText = result.text?.trim();
      const combinedText = replyText ? `${replyText}\n\n${prompt}` : prompt;
      const payloadValue = encodeApprovalPayload(pendingApprovals);
      await postWithToolStatus({
        post: async ({ text: responseText, blocks }) =>
          (await say({
            text: responseText,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            ...(blocks ? { blocks } : {}),
          })) as { ts?: string; channel?: string } | undefined,
        update: async (response) => {
          await client.chat.update(response);
        },
        channel,
        text: combinedText,
        blocks: buildApprovalBlocks(combinedText, payloadValue),
        toolCalls,
      });
      return;
    }

    await postWithToolStatus({
      post: async ({ text: responseText, blocks }) =>
        (await say({
          text: responseText,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(blocks ? { blocks } : {}),
        })) as { ts?: string; channel?: string } | undefined,
      update: async (response) => {
        await client.chat.update(response);
      },
      channel,
      text: result.text ?? '',
      blocks: buildTextBlocks(result.text ?? ''),
      toolCalls,
    });
  } finally {
    await client.reactions.remove({
      channel,
      name: 'eyes',
      timestamp: messageTs,
    });
  }
}

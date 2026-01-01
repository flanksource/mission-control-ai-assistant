import { App, SayFn, StringIndexed } from '@slack/bolt';
import { LanguageModelV3 } from '@ai-sdk/provider';
import type { AppMentionEvent, GenericMessageEvent } from '@slack/types';
import type { WebClient, Logger } from '@slack/web-api';
import {
  decodeApprovalPayload,
  extractApprovalPayloadFromBlocks,
  collectToolApprovalRequests,
  encodeApprovalPayload,
  formatApprovalPrompt,
  PendingApproval,
} from './approvals';
import { generateText, ModelMessage, stepCountIs, type ToolSet } from 'ai';
import { ToolApprovalRequest, ToolCallPart } from '@ai-sdk/provider-utils';
import {
  buildApprovalBlocks,
  appendToolStatusToBlocks,
  buildTextBlocks,
  mergeMessageText,
  extractTextFromBlocks,
} from './blocks';
import {
  appendToolStatusToText,
  collectToolCalls,
  formatToolCallStatus,
  getLogLevel,
} from './utils';
import { systemPrompt } from '../llm/llm';

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

    await respondWithLLM({ message, say, client, logger }, botUserId, model, tools);
  });

  app.event('app_mention', async ({ event, say, client, logger }) => {
    const message = event as AppMentionEvent;
    await respondWithLLM({ message, say, client, logger }, botUserId, model, tools);
  });

  app.action('tool_approval_approve', async ({ ack, body, client, logger }) => {
    await ack();
    await handleToolApprovalAction({
      body,
      client,
      logger,
      botUserId,
      model,
      tools,
      approved: true,
    });
  });

  app.action('tool_approval_deny', async ({ ack, body, client, logger }) => {
    await ack();
    await handleToolApprovalAction({
      body,
      client,
      logger,
      botUserId,
      model,
      tools,
      approved: false,
      reason: 'Denied by user',
    });
  });

  return app;
}

async function handleToolApprovalAction({
  body,
  client,
  logger,
  botUserId,
  model,
  tools,
  approved,
  reason,
}: {
  body: unknown;
  client: WebClient;
  logger: Logger;
  botUserId: string;
  model: LanguageModelV3;
  tools?: ToolSet;
  approved: boolean;
  reason?: string;
}) {
  const actionValue =
    typeof body === 'object' &&
    body !== null &&
    'actions' in body &&
    Array.isArray((body as { actions?: unknown[] }).actions) &&
    (body as { actions?: Array<{ value?: string }> }).actions?.[0]?.value
      ? (body as { actions: Array<{ value?: string }> }).actions[0].value
      : undefined;
  const channel =
    typeof body === 'object' && body !== null && 'channel' in body
      ? (body as { channel?: { id?: string } }).channel?.id
      : undefined;
  const message =
    typeof body === 'object' && body !== null && 'message' in body
      ? (body as { message?: { thread_ts?: string; text?: string; blocks?: unknown[] } }).message
      : undefined;
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

  const messages: ModelMessage[] = await buildConveration({
    client,
    channel,
    threadTs,
    botUserId,
    text: message?.text || '',
  });

  await handleApprovalDecision({
    messages,
    approvals: payload.approvals,
    approved,
    reason,
    model,
    tools,
    post: async ({ text, blocks }) =>
      client.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(blocks ? { blocks } : {}),
      }),
  });
}

async function handleApprovalDecision({
  messages,
  approvals,
  approved,
  reason,
  model,
  tools,
  post,
}: {
  messages: ModelMessage[];
  approvals: PendingApproval[];
  approved: boolean;
  reason?: string;
  model: LanguageModelV3;
  tools?: ToolSet;
  post: (message: {
    text: string;
    blocks?: unknown[];
  }) => Promise<{ ts?: string; channel?: string } | undefined>;
}) {
  const approvalContent: Array<ToolCallPart | ToolApprovalRequest> = approvals.flatMap(
    (approval) => [
      {
        type: 'tool-call',
        toolCallId: approval.toolCall.toolCallId,
        toolName: approval.toolCall.toolName,
        input: approval.toolCall.input,
      },
      {
        type: 'tool-approval-request',
        approvalId: approval.approvalId,
        toolCallId: approval.toolCall.toolCallId,
      },
    ],
  );

  const toolApprovalMessages: ModelMessage[] = [
    { role: 'assistant', content: approvalContent },
    {
      role: 'tool',
      content: approvals.map((approval) => ({
        type: 'tool-approval-response',
        approvalId: approval.approvalId,
        approved,
        reason,
      })),
    },
  ];

  const result = await generateText({
    model,
    messages: [...messages, ...toolApprovalMessages],
    stopWhen: stepCountIs(20),
    system: systemPrompt,
    ...(tools ? { tools } : {}),
  });

  const response = renderToolResponse({
    responseMessages: result.response.messages ?? [],
    replyText: result.text ?? '',
    includeReplyTextWithApprovals: false,
  });

  await post({ text: response.text, blocks: response.blocks });
}

interface SlackHandlerContext {
  message: AppMentionEvent | GenericMessageEvent;
  say: SayFn;
  client: WebClient;
  logger: Logger;
}

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
    client.reactions.add({
      channel: message.channel,
      name: 'eyes',
      timestamp: message.ts,
    });

    const messages: ModelMessage[] = await buildConveration({
      client,
      channel,
      threadTs,
      botUserId,
      text: message.text || text,
    });

    const result = await generateText({
      model,
      messages,
      stopWhen: stepCountIs(20),
      system: systemPrompt,
      ...(tools ? { tools } : {}),
    });

    const response = renderToolResponse({
      responseMessages: result.response.messages ?? [],
      replyText: result.text?.trim() ?? '',
      includeReplyTextWithApprovals: true,
    });

    await say({
      text: response.text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(response.blocks ? { blocks: response.blocks } : {}),
    });
  } finally {
    await client.reactions.remove({
      channel,
      name: 'eyes',
      timestamp: messageTs,
    });
  }
}

export async function buildConveration({
  client,
  channel,
  threadTs,
  botUserId,
  text,
}: {
  client: WebClient;
  channel: string;
  threadTs?: string;
  botUserId: string;
  text: string;
}): Promise<ModelMessage[]> {
  if (!threadTs) {
    return [
      {
        role: 'user',
        content: replaceBotMention(text, botUserId),
      },
    ];
  }
  return await buildConversationFromSlackThread({
    client,
    channel,
    threadTs,
    botUserId,
  });
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

export function replaceBotMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, '@assistant');
}

function renderToolResponse({
  responseMessages,
  replyText,
  includeReplyTextWithApprovals,
}: {
  responseMessages: ModelMessage[];
  replyText: string;
  includeReplyTextWithApprovals: boolean;
}): { text: string; blocks?: unknown[] } {
  const toolCalls = collectToolCalls(responseMessages);
  const status = toolCalls.length > 0 ? formatToolCallStatus(toolCalls) : '';
  const pendingApprovals = collectToolApprovalRequests(responseMessages);
  if (pendingApprovals.length > 0) {
    const prompt = formatApprovalPrompt(pendingApprovals);
    const payloadValue = encodeApprovalPayload(pendingApprovals);
    const combinedText =
      includeReplyTextWithApprovals && replyText ? `${replyText}\n\n${prompt}` : prompt;
    const approvalBlocks = buildApprovalBlocks(combinedText, payloadValue);
    const finalText = status ? appendToolStatusToText(combinedText, status) : combinedText;
    const finalBlocks = status ? appendToolStatusToBlocks(approvalBlocks, status) : approvalBlocks;

    return { text: finalText, blocks: finalBlocks };
  }

  const replyBlocks = buildTextBlocks(replyText);
  const finalText = status ? appendToolStatusToText(replyText, status) : replyText;
  const finalBlocks = status ? appendToolStatusToBlocks(replyBlocks, status) : replyBlocks;

  return { text: finalText, blocks: finalBlocks };
}

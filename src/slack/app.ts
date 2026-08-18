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
  mergeMessageText,
  extractTextFromBlocks,
} from './blocks';
import { systemPrompt } from '../llm/llm';
import { LogLevel } from '@slack/bolt';

type ToolDisplayInfo = {
  providerLabel?: string;
};

const buildToolDisplayInfo = (tools?: ToolSet): Record<string, ToolDisplayInfo> | undefined => {
  if (!tools) {
    return undefined;
  }
  const entries = Object.entries(tools).map(([name, tool]) => {
    const meta = (tool as { _meta?: Record<string, unknown> })._meta;
    const isMcp = Boolean(meta) || Boolean(process.env.MCP_URL);
    if (!isMcp) {
      return [name, {} satisfies ToolDisplayInfo] as const;
    }
    return [
      name,
      {
        providerLabel: 'MCP',
      } satisfies ToolDisplayInfo,
    ] as const;
  });
  return Object.fromEntries(entries);
};

export function getLogLevel(level?: string): LogLevel {
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
  mcpUnavailable = false,
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

  const respond = mcpUnavailable
    ? async ({ message, say }: SlackHandlerContext) => {
        const threadTs = 'thread_ts' in message ? message.thread_ts : undefined;
        await say({
          text: "Mission Control is temporarily unavailable because I couldn't connect to the MCP server. Please contact an administrator.",
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      }
    : (context: SlackHandlerContext) => respondWithLLM(context, botUserId, model, tools);

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

    await respond({ message, say, client, logger });
  });

  app.event('app_mention', async ({ event, say, client, logger }) => {
    const message = event as AppMentionEvent;
    await respond({ message, say, client, logger });
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
    client,
    channel,
    threadTs,
    logger,
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
  client,
  channel,
  threadTs,
  logger,
  post,
}: {
  messages: ModelMessage[];
  approvals: PendingApproval[];
  approved: boolean;
  reason?: string;
  model: LanguageModelV3;
  tools?: ToolSet;
  client: WebClient;
  channel: string;
  threadTs?: string;
  logger: Logger;
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

  const stepReporter = await createStepProgressReporter({
    client,
    channel,
    threadTs,
    logger,
    toolDisplayInfo: buildToolDisplayInfo(tools),
  });

  try {
    const result = await generateText({
      model,
      messages: [...messages, ...toolApprovalMessages],
      stopWhen: stepCountIs(20),
      system: systemPrompt,
      onStepFinish: stepReporter.onStepFinish,
      ...(tools ? { tools } : {}),
    });

    const response = renderToolResponse({
      responseMessages: result.response.messages ?? [],
      replyText: result.text ?? '',
      includeReplyTextWithApprovals: false,
    });

    await post({ text: response.text, blocks: response.blocks });
    await stepReporter.finalize('done');
  } catch (error) {
    await stepReporter.finalize('error');
    throw error;
  }
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
    const stepReporter = await createStepProgressReporter({
      client,
      channel,
      threadTs,
      logger,
      toolDisplayInfo: buildToolDisplayInfo(tools),
    });

    const messages: ModelMessage[] = await buildConveration({
      client,
      channel,
      threadTs,
      botUserId,
      text: message.text || text,
    });

    try {
      const result = await generateText({
        model,
        messages,
        stopWhen: stepCountIs(20),
        system: systemPrompt,
        onStepFinish: stepReporter.onStepFinish,
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
      await stepReporter.finalize('done');
    } catch (error) {
      await stepReporter.finalize('error');
      throw error;
    }
  } finally {
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
  const pendingApprovals = collectToolApprovalRequests(responseMessages);
  if (pendingApprovals.length > 0) {
    const prompt = formatApprovalPrompt(pendingApprovals);
    const payloadValue = encodeApprovalPayload(pendingApprovals);
    const combinedText =
      includeReplyTextWithApprovals && replyText ? `${replyText}\n\n${prompt}` : prompt;
    const approvalBlocks = buildApprovalBlocks(combinedText, payloadValue);
    return { text: combinedText, blocks: approvalBlocks };
  }

  // Prefer plain text for regular LLM replies to avoid Block Kit validation/length issues.
  // Plain text responses are the default to keep replies reliable and simple.
  // Slack's text field supports ~40k chars, and block-kit adds stricter limits
  // (3k per section, block count limits) plus the risk of invalid JSON from the model.
  // We only use blocks when we need interactive UI (tool approvals) or structured
  // progress updates; everything else stays as plain text for robustness.
  return { text: replyText };
}

async function createStepProgressReporter({
  client,
  channel,
  threadTs,
  logger,
  toolDisplayInfo,
}: {
  client: WebClient;
  channel: string;
  threadTs?: string;
  logger: Logger;
  toolDisplayInfo?: Record<string, { sourceLabel?: string; providerLabel?: string }>;
}): Promise<{
  onStepFinish: (stepResult: {
    toolCalls: Array<{ toolName: string; input?: unknown }>;
    toolResults: Array<{ toolName: string }>;
  }) => Promise<void>;
  finalize: (status: 'done' | 'error') => Promise<void>;
}> {
  const toolLines: string[] = [];
  let stepCount = 0;
  let progressMessageTs: string | undefined;
  const maxVisibleSteps = 12; // Slack message length + readability cap.
  const maxToolInputChars = 160; // Keep tool lines short to reduce Slack wrapping.

  const truncate = (value: string, maxLength: number) => {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  };

  // Format: `toolName(key: value, ...) (MCP)` for Slack monospace display.
  const formatToolCallLine = (toolCall: { toolName: string; input?: unknown }) => {
    const rawInput = JSON.stringify(toolCall.input);
    const renderedInput = truncate(rawInput, maxToolInputChars);
    const inputSuffix = renderedInput ? `(${renderedInput})` : '()';
    const info = toolDisplayInfo?.[toolCall.toolName];
    const suffix = info?.providerLabel ? ` (${info.providerLabel})` : '';
    return `\`${toolCall.toolName}${inputSuffix}${suffix}\``;
  };

  const buildProgressText = (status?: 'done' | 'error') => {
    if (toolLines.length === 0) {
      const base = 'Progress updates:';
      if (status === 'done') {
        return `${base}\n\nDone.`;
      }
      if (status === 'error') {
        return `${base}\n\nStopped due to an error.`;
      }
      return base;
    }

    const body = toolLines.map((line) => `- ${line}`).join('\n');
    if (status === 'done') {
      return `Progress updates:\n${body}\n\nDone.`;
    }
    if (status === 'error') {
      return `Progress updates:\n${body}\n\nStopped due to an error.`;
    }
    return `Progress updates:\n${body}`;
  };

  const buildProgressBlocks = (status?: 'done' | 'error') => {
    const statusLine =
      status === 'done'
        ? ':white_check_mark: Done'
        : status === 'error'
          ? ':warning: Stopped due to an error'
          : '🗯️ Thinking ...';
    const visibleSteps = toolLines.slice(-maxVisibleSteps);
    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${statusLine}*`,
        },
      },
    ];

    if (visibleSteps.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: visibleSteps.map((line) => `• ${line}`).join('\n'),
        },
      });
    }

    return blocks;
  };

  const updateProgressMessage = async (status?: 'done' | 'error') => {
    if (!progressMessageTs) {
      return;
    }
    await client.chat.update({
      channel,
      ts: progressMessageTs,
      text: buildProgressText(status),
      blocks: buildProgressBlocks(status),
    });
  };

  try {
    const progressMessage = await client.chat.postMessage({
      channel,
      text: buildProgressText(),
      blocks: buildProgressBlocks(),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    progressMessageTs = progressMessage.ts;
  } catch (error) {
    logger.warn({ error }, 'Failed to post progress message');
  }

  return {
    onStepFinish: async (stepResult) => {
      stepCount += 1;
      if (stepResult.toolCalls.length === 0) {
        return;
      }

      for (const toolCall of stepResult.toolCalls) {
        console.log(JSON.stringify(toolCall, null, 2));
        toolLines.push(formatToolCallLine(toolCall));
      }

      updateProgressMessage().catch((error) => {
        logger.warn({ error }, 'Failed to update progress message');
      });
    },
    finalize: async (status) => {
      try {
        if (!progressMessageTs) {
          return;
        }
        if (toolLines.length === 0 || stepCount <= 1) {
          await client.chat.delete({
            channel,
            ts: progressMessageTs,
          });
          return;
        }
        await updateProgressMessage(status);
      } catch (error) {
        logger.warn({ error }, 'Failed to finalize progress message');
      }
    },
  };
}

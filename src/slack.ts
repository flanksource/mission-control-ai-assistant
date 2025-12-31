import { App, StringIndexed } from '@slack/bolt';
import { LanguageModelV3 } from '@ai-sdk/provider';
import { ModelMessage, generateId, generateText, stepCountIs, type ToolSet } from 'ai';
import type { ToolApprovalRequest, ToolCallPart } from '@ai-sdk/provider-utils';
import { AppMentionEvent, GenericMessageEvent, MessageEvent } from '@slack/types';
import { SlackHandlerContext } from './types';
import { mergeMessageText, extractTextFromBlocks } from './utils/slack_blocks';

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

type PendingApproval = {
  approvalId: string;
  toolCall: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
};

type ApprovalPayload = {
  approvals: PendingApproval[];
};

const systemPrompt = `You are a Slack bot assigned to work as a customer service for Flanksource's Mission Control customers.
  Flanksource Mission Control is an Internal Developer Platform that helps teams improve developer productivity and operational resilience

  Format responses using Slack mrkdwn.
  "Avoid Markdown features Slack doesn't support, like # headers.`;

function parseApprovalDecision(text: string): { approved: boolean; reason?: string } | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const approved =
    normalized === 'approve' ||
    normalized === 'approve all' ||
    normalized === 'yes' ||
    normalized === 'y' ||
    normalized === 'ok' ||
    normalized === 'okay' ||
    normalized === 'allow' ||
    normalized === 'run' ||
    normalized === 'go ahead';
  if (approved) {
    return { approved: true };
  }

  const denied =
    normalized === 'deny' ||
    normalized === 'deny all' ||
    normalized === 'no' ||
    normalized === 'n' ||
    normalized === 'reject' ||
    normalized === 'stop' ||
    normalized === 'cancel';
  if (denied) {
    return { approved: false, reason: text.trim() };
  }

  return null;
}

function buildTextBlocks(text: string) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
  ];
}

function encodeApprovalPayload(approvals: PendingApproval[]): string {
  return JSON.stringify({ approvals } satisfies ApprovalPayload);
}

function decodeApprovalPayload(value: string): ApprovalPayload | null {
  try {
    const parsed = JSON.parse(value) as ApprovalPayload;
    if (!parsed.approvals || !Array.isArray(parsed.approvals)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function buildApprovalBlocks(text: string, payloadValue: string) {
  return [
    ...buildTextBlocks(text),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Approve',
          },
          style: 'primary',
          action_id: 'tool_approval_approve',
          value: payloadValue,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Deny',
          },
          style: 'danger',
          action_id: 'tool_approval_deny',
          value: payloadValue,
        },
      ],
    },
  ];
}

function formatApprovalPrompt(pending: PendingApproval[]): string {
  const lines = pending.map((approval, index) => {
    const input = safeStringify(approval.toolCall.input);
    return `\`${approval.toolCall.toolName}\`\n\`\`\`${input}\`\`\``;
  });

  return ['Tool approval required:', ...lines].join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function collectToolApprovalRequests(messages: ModelMessage[]): PendingApproval[] {
  const toolCallsById = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  >();
  const approvals: PendingApproval[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        toolCallsById.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
      }
      if (part.type === 'tool-approval-request') {
        const toolCall = toolCallsById.get(part.toolCallId) ?? {
          toolCallId: part.toolCallId,
          toolName: 'unknown',
          input: { toolCallId: part.toolCallId },
        };
        approvals.push({
          approvalId: part.approvalId,
          toolCall,
        });
      }
    }
  }
  return approvals;
}

function extractApprovalPayloadFromBlocks(blocks: unknown[] | undefined): ApprovalPayload | null {
  if (!blocks) return null;
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const typedBlock = block as { type?: string; elements?: unknown[] };
    if (typedBlock.type !== 'actions' || !Array.isArray(typedBlock.elements)) {
      continue;
    }
    for (const element of typedBlock.elements) {
      if (typeof element !== 'object' || element === null) {
        continue;
      }
      const typedElement = element as { action_id?: string; value?: string };
      if (
        (typedElement.action_id === 'tool_approval_approve' ||
          typedElement.action_id === 'tool_approval_deny') &&
        typeof typedElement.value === 'string'
      ) {
        const payload = decodeApprovalPayload(typedElement.value);
        if (payload) {
          return payload;
        }
      }
    }
  }
  return null;
}

function dropTrailingUserMessage(messages: ModelMessage[], text: string): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && last.content === text) {
    return messages.slice(0, -1);
  }
  return messages;
}

async function findLatestApprovalPayload({
  client,
  channel,
  threadTs,
}: {
  client: SlackHandlerContext['client'];
  channel: string;
  threadTs: string | undefined;
}): Promise<ApprovalPayload | null> {
  if (threadTs) {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });
    const messages = result.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const payload = extractApprovalPayloadFromBlocks(messages[i].blocks);
      if (payload) return payload;
    }
    return null;
  }

  const history = await client.conversations.history({
    channel,
    limit: 50,
  });
  const messages = history.messages ?? [];
  for (const message of messages) {
    const payload = extractApprovalPayloadFromBlocks(message.blocks);
    if (payload) return payload;
  }
  return null;
}

function logToolCalls(messages: ModelMessage[], logger: SlackHandlerContext['logger']) {
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        logger.info(
          {
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            input: part.input,
          },
          'Tool call requested',
        );
      }
    }
  }
}

function collectToolCalls(messages: ModelMessage[]): ToolCallPart[] {
  const toolCalls: ToolCallPart[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        toolCalls.push(part);
      }
    }
  }
  return toolCalls;
}

function formatToolCallStatus(toolCalls: ToolCallPart[]): string {
  const names = Array.from(new Set(toolCalls.map((call) => call.toolName)));
  return `Tool called: ${names.join(', ')}`;
}

function appendToolStatusToText(text: string, status: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return `_${status}_`;
  }
  return `${text}\n\n_${status}_`;
}

function appendToolStatusToBlocks(blocks: unknown[] | undefined, status: string): unknown[] {
  const statusBlock = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_${status}_`,
      },
    ],
  };

  if (!blocks || blocks.length === 0) {
    return buildTextBlocks(`_${status}_`);
  }

  const updatedBlocks = [...blocks];
  const lastBlock = updatedBlocks[updatedBlocks.length - 1] as { type?: string } | undefined;
  if (lastBlock?.type === 'actions') {
    updatedBlocks.splice(updatedBlocks.length - 1, 0, statusBlock);
    return updatedBlocks;
  }

  updatedBlocks.push(statusBlock);
  return updatedBlocks;
}

async function postWithToolStatus({
  post,
  update,
  channel,
  text,
  blocks,
  toolCalls,
}: {
  post: (message: {
    text: string;
    blocks?: unknown[];
  }) => Promise<{ ts?: string; channel?: string } | undefined>;
  update: (message: {
    channel: string;
    ts: string;
    text: string;
    blocks?: unknown[];
  }) => Promise<void>;
  channel: string;
  text: string;
  blocks?: unknown[];
  toolCalls: ToolCallPart[];
}) {
  const response = await post({ text, blocks });
  if (toolCalls.length === 0) {
    return response;
  }

  const status = formatToolCallStatus(toolCalls);
  const updatedText = appendToolStatusToText(text, status);
  const updatedBlocks = appendToolStatusToBlocks(blocks, status);
  const updateChannel = response?.channel ?? channel;
  const ts = response?.ts;
  if (updateChannel && ts) {
    await update({ channel: updateChannel, ts, text: updatedText, blocks: updatedBlocks });
  }

  return response;
}

async function handleApprovalDecision({
  messages,
  approvals,
  approved,
  reason,
  model,
  tools,
  logger,
  post,
  update,
  channel,
}: {
  messages: ModelMessage[];
  approvals: PendingApproval[];
  approved: boolean;
  reason?: string;
  model: LanguageModelV3;
  tools?: ToolSet;
  logger: SlackHandlerContext['logger'];
  post: (message: {
    text: string;
    blocks?: unknown[];
  }) => Promise<{ ts?: string; channel?: string } | undefined>;
  update: (message: {
    channel: string;
    ts: string;
    text: string;
    blocks?: unknown[];
  }) => Promise<void>;
  channel: string;
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

  const responseMessages = result.response.messages ?? [];
  logToolCalls(responseMessages, logger);
  const toolCalls = collectToolCalls(responseMessages);
  const pendingApprovals = collectToolApprovalRequests(responseMessages);
  if (pendingApprovals.length > 0) {
    const prompt = formatApprovalPrompt(pendingApprovals);
    const payloadValue = encodeApprovalPayload(pendingApprovals);
    await postWithToolStatus({
      post,
      update,
      channel,
      text: prompt,
      blocks: buildApprovalBlocks(prompt, payloadValue),
      toolCalls,
    });
    return;
  }

  const replyText = result.text ?? '';
  await postWithToolStatus({
    post,
    update,
    channel,
    text: replyText,
    blocks: buildTextBlocks(replyText),
    toolCalls,
  });
}

export async function respondWithLLM(
  { message, say, client, logger }: SlackHandlerContext,
  model: LanguageModelV3,
  tools?: ToolSet,
) {
  const text = message.text ?? '';
  const { channel, user } = message;
  const messageTs = message.ts;
  const threadTs = 'thread_ts' in message ? message.thread_ts : undefined;
  const requestId = generateId();

  logger.info({ requestId, channel, user }, 'New message');

  await client.reactions.add({
    channel,
    name: 'eyes',
    timestamp: messageTs,
  });

  try {
    if (!text.trim()) {
      await say({
        text: 'Please send some text.',
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    const botUserId = (await client.auth.test()).user_id;
    const decision = parseApprovalDecision(text);
    if (decision) {
      const payload = await findLatestApprovalPayload({ client, channel, threadTs });
      if (payload) {
        const messages = await buildMessagesFromSlack({
          client,
          channel,
          threadTs,
          botUserId,
        });
        const trimmedMessages = dropTrailingUserMessage(messages, text);
        await handleApprovalDecision({
          messages: trimmedMessages,
          approvals: payload.approvals,
          approved: decision.approved,
          reason: decision.reason,
          model,
          tools,
          logger,
          post: async ({ text: responseText, blocks }) =>
            (await say({
              text: responseText,
              ...(threadTs ? { thread_ts: threadTs } : {}),
              ...(blocks ? { blocks } : {}),
            })) as { ts?: string; channel?: string } | undefined,
          update: async (message) => {
            await client.chat.update(message);
          },
          channel,
        });
        return;
      }
    }

    const messages = await buildMessagesFromSlack({
      client,
      channel,
      threadTs,
      currentText: text,
      botUserId,
    });

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
        update: async (message) => {
          await client.chat.update(message);
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
      update: async (message) => {
        await client.chat.update(message);
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

function isGenericMessageEvent(message: MessageEvent): message is GenericMessageEvent {
  return message.type === 'message' && message.subtype === undefined;
}

async function buildMessagesFromSlack({
  client,
  channel,
  threadTs,
  currentText,
  botUserId,
  includeCurrentText = true,
}: {
  client: SlackHandlerContext['client'];
  channel: string;
  threadTs: string | undefined;
  currentText?: string;
  botUserId: string | undefined;
  includeCurrentText?: boolean;
}): Promise<ModelMessage[]> {
  let slackMessages: Array<{ text?: string; blocks?: unknown[]; bot_id?: string; user?: string }> =
    [];

  if (threadTs) {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
    });
    slackMessages = result.messages ?? [];
  } else {
    const result = await client.conversations.history({
      channel,
      limit: 20,
    });
    slackMessages = (result.messages ?? []).slice().reverse();
  }

  if (!slackMessages.length) {
    if (includeCurrentText && currentText) {
      return [{ role: 'user', content: currentText }];
    }
    return [];
  }

  const messages: ModelMessage[] = [];
  for (const msg of slackMessages) {
    const blockText = extractTextFromBlocks(msg.blocks);
    const baseText = (msg.text ?? '').trim();
    const content = mergeMessageText(blockText, baseText);
    if (!content) continue;

    // Determine if message is from the bot or a user
    const isBot = msg.bot_id || msg.user === botUserId;
    messages.push({
      role: isBot ? 'assistant' : 'user',
      content,
    });
  }

  if (includeCurrentText && currentText) {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || last.content !== currentText) {
      messages.push({ role: 'user', content: currentText });
    }
  }

  return messages;
}

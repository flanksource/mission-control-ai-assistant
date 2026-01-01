import { LanguageModelV3 } from '@ai-sdk/provider';
import { ToolApprovalRequest, ToolCallPart } from '@ai-sdk/provider-utils';
import { ModelMessage, generateText, stepCountIs, type ToolSet } from 'ai';
import { buildApprovalBlocks, buildTextBlocks } from './blocks';
import { collectToolCalls, logToolCalls, postWithToolStatus } from './tool_calls';
import { Logger, WebClient } from '@slack/web-api';

export type PendingApproval = {
  approvalId: string;
  toolCall: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
};

export type ApprovalPayload = {
  approvals: PendingApproval[];
};

export const systemPrompt = `You are a Slack bot assigned to work as a customer service for Flanksource's Mission Control customers.
  Flanksource Mission Control is an Internal Developer Platform that helps teams improve developer productivity and operational resilience

  Format responses using Slack mrkdwn.
  "Avoid Markdown features Slack doesn't support, like # headers.`;

export function encodeApprovalPayload(approvals: PendingApproval[]): string {
  return JSON.stringify({ approvals } satisfies ApprovalPayload);
}

export function decodeApprovalPayload(value: string): ApprovalPayload | null {
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

export function formatApprovalPrompt(pending: PendingApproval[]): string {
  const lines = pending.map((approval) => {
    const input = safeStringify(approval.toolCall.input);
    return `\`${approval.toolCall.toolName}\`\n\`\`\`${input}\`\`\``;
  });

  return ['Tool approval required:', ...lines].join('\n');
}

export function collectToolApprovalRequests(messages: ModelMessage[]): PendingApproval[] {
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

export function extractApprovalPayloadFromBlocks(
  blocks: unknown[] | undefined,
): ApprovalPayload | null {
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

export async function handleApprovalDecision({
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
  logger: Logger;
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

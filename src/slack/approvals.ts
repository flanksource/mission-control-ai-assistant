import { ModelMessage } from 'ai';

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

export function formatApprovalPrompt(pending: PendingApproval[]): string {
  const lines = pending.map((approval) => {
    const input = JSON.stringify(approval.toolCall.input, null, 2);
    return `\`${approval.toolCall.toolName}\`\n\`\`\`${input}\`\`\``;
  });

  return ['Tool approval required:', ...lines].join('\n');
}

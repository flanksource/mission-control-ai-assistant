import { ModelMessage } from 'ai';
import { ToolCallPart } from '@ai-sdk/provider-utils';
import { SlackHandlerContext } from '../slack';
import { appendToolStatusToBlocks } from './blocks';

export function logToolCalls(messages: ModelMessage[], logger: SlackHandlerContext['logger']) {
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

export function collectToolCalls(messages: ModelMessage[]): ToolCallPart[] {
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

export function formatToolCallStatus(toolCalls: ToolCallPart[]): string {
  const names = Array.from(new Set(toolCalls.map((call) => call.toolName)));
  return `Tool called: ${names.join(', ')}`;
}

export function appendToolStatusToText(text: string, status: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return `_${status}_`;
  }
  return `${text}\n\n_${status}_`;
}

export async function postWithToolStatus({
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

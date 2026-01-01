import { ModelMessage } from 'ai';
import { ToolCallPart } from '@ai-sdk/provider-utils';
import { LogLevel } from '@slack/bolt';

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

import { ModelMessage } from 'ai';
import { MessageEvent, GenericMessageEvent } from '@slack/types';
import { SlackHandlerContext } from '../types';
import { mergeMessageText, extractTextFromBlocks } from './blocks';

export function dropTrailingUserMessage(messages: ModelMessage[], text: string): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && last.content === text) {
    return messages.slice(0, -1);
  }
  return messages;
}

export function isGenericMessageEvent(message: MessageEvent): message is GenericMessageEvent {
  return message.type === 'message' && message.subtype === undefined;
}

export async function buildMessagesFromSlack({
  client,
  channel,
  threadTs,
  currentBlocks,
  botUserId,
  includeCurrentBlocks = true,
}: {
  client: SlackHandlerContext['client'];
  channel: string;
  threadTs: string | undefined;
  currentBlocks?: unknown[];
  botUserId: string | undefined;
  includeCurrentBlocks?: boolean;
}): Promise<ModelMessage[]> {
  let slackMessages: Array<{ text?: string; blocks?: unknown[]; bot_id?: string; user?: string }> =
    [];
  if (threadTs) {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 150, // to prevent high token usage
    });
    slackMessages = result.messages ?? [];
  }

  if (!slackMessages.length) {
    if (includeCurrentBlocks && currentBlocks?.length) {
      const blockText = extractTextFromBlocks(currentBlocks);
      if (blockText) {
        return [{ role: 'user', content: blockText }];
      }
    }
    return [];
  }

  const messages: ModelMessage[] = [];
  for (const msg of slackMessages) {
    const blockText = extractTextFromBlocks(msg.blocks || []);
    const baseText = (msg.text ?? '').trim();
    const content = mergeMessageText(blockText, baseText);
    if (!content) continue;

    const isBot = msg.bot_id || msg.user === botUserId;
    messages.push({
      role: isBot ? 'assistant' : 'user',
      content,
    });
  }

  if (includeCurrentBlocks && currentBlocks?.length) {
    const blockText = extractTextFromBlocks(currentBlocks);
    if (blockText) {
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user' || last.content !== blockText) {
        messages.push({ role: 'user', content: blockText });
      }
    }
  }

  return messages;
}

import { ModelMessage } from 'ai';
import { MessageEvent, GenericMessageEvent } from '@slack/types';
import { SlackHandlerContext } from '../types';
import { mergeMessageText, extractTextFromBlocks } from '../utils/slack_blocks';

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

import { App } from '@slack/bolt';
import { LanguageModelV3 } from '@ai-sdk/provider';
import { ModelMessage, generateId, generateText } from 'ai';
import { AppMentionEvent, GenericMessageEvent, MessageEvent } from '@slack/types';
import { SlackHandlerContext } from './types';

export async function startSlack(botToken: string, appToken: string, model: LanguageModelV3) {
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

    await respondWithLLM({ message, say, client, logger }, model);
  });

  app.event('app_mention', async ({ event, say, client, logger }) => {
    const message = event as AppMentionEvent;
    await respondWithLLM({ message, say, client, logger }, model);
  });

  await app.start();
  console.log('Slack echo bot running in socket mode');
}

const systemPrompt = `You are a Slack bot assigned to work as a customer service for Flanksource's Mission Control customers.
  Flanksource Mission Control is an Internal Developer Platform that helps teams improve developer productivity and operational resilience

  Format responses using Slack mrkdwn.
  "Avoid Markdown features Slack doesn't support, like # headers.`;

export async function respondWithLLM(
  { message, say, client, logger }: SlackHandlerContext,
  model: LanguageModelV3,
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

    // Build messages array from thread history or single message
    const messages = await buildMessagesFromThread({
      client,
      channel,
      threadTs,
      currentText: text,
      botUserId: (await client.auth.test()).user_id,
    });

    console.log(messages);

    const { text: replyText } = await generateText({
      model,
      messages,
      system: systemPrompt,
    });

    await say({
      text: replyText,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: replyText,
          },
        },
      ],
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

async function buildMessagesFromThread({
  client,
  channel,
  threadTs,
  currentText,
  botUserId,
}: {
  client: SlackHandlerContext['client'];
  channel: string;
  threadTs: string | undefined;
  currentText: string;
  botUserId: string | undefined;
}): Promise<ModelMessage[]> {
  // If not in a thread, just return the current message
  if (!threadTs) {
    return [{ role: 'user', content: currentText }];
  }

  // Fetch thread history
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
  });

  if (!result.messages || result.messages.length === 0) {
    return [{ role: 'user', content: currentText }];
  }

  // Convert thread messages to LLM message format
  const messages: ModelMessage[] = [];
  for (const msg of result.messages) {
    if (!msg.text) continue;

    // Determine if message is from the bot or a user
    const isBot = msg.bot_id || msg.user === botUserId;
    messages.push({
      role: isBot ? 'assistant' : 'user',
      content: msg.text,
    });
  }

  return messages;
}

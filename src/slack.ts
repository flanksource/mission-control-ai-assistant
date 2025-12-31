import { App } from '@slack/bolt';
import { LanguageModelV3 } from '@ai-sdk/provider';
import { generateId, generateText } from 'ai';
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
  model: LanguageModelV3
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

    const { text: replyText } = await generateText({
      model,
      prompt: text,
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

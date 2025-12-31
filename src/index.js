import 'dotenv/config';
import { App } from '@slack/bolt';
import { generateId } from 'ai';

const requiredEnv = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.message(async ({ message, say, logger }) => {
  if (message.subtype || message.bot_id) {
    return;
  }

  if (message.channel_type !== 'im') {
    return;
  }

  const text = message.text ?? '';
  const requestId = generateId();
  logger.info({ requestId, channel: message.channel, user: message.user }, 'Echo DM');

  if (!text.trim()) {
    await say('I can only echo text messages for now.');
    return;
  }

  await say(text);
});

app.event('app_mention', async ({ event, say, logger }) => {
  const text = event.text ?? '';
  const requestId = generateId();
  logger.info({ requestId, channel: event.channel, user: event.user }, 'Echo mention');

  if (!text.trim()) {
    await say('I can only echo text messages for now.');
    return;
  }

  await say(text);
});

(async () => {
  await app.start();
  console.log('Slack echo bot running in socket mode');
})();

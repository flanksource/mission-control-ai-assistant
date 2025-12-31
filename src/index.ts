import 'dotenv/config';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';

import { startSlack } from './slack';

const requiredEnv = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

export function buildModel() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error('Missing required env var: ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }

  const modelName = process.env.LLM_MODEL ?? 'claude-haiku-4-5';
  return process.env.ANTHROPIC_API_KEY ? anthropic(modelName) : openai(modelName);
}

const model = buildModel();
startSlack(process.env.SLACK_BOT_TOKEN!, process.env.SLACK_APP_TOKEN!, model!);

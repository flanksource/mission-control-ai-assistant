import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export const systemPrompt = [
  "You are a Slack bot assigned to work as a customer service for Flanksource's Mission Control customers.",
  "Flanksource Mission Control is an internal developer platform that helps teams improve developer productivity and operational resilience.",
  '',
  'Format responses using Slack mrkdwn.',
  "Avoid Markdown features Slack doesn't support, like # headers.",
].join('\n');

export function buildModel(): LanguageModelV3 {
  if (
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.OPENAI_API_KEY &&
    !process.env.GOOGLE_GENERATIVE_AI_API_KEY
  ) {
    throw new Error(
      'Missing required env var: ANTHROPIC_API_KEY or OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY',
    );
  }

  const modelName = process.env.LLM_MODEL;
  if (process.env.ANTHROPIC_API_KEY) {
    return anthropic(modelName || 'claude-haiku-4-5');
  }
  if (process.env.OPENAI_API_KEY) {
    return openai(modelName || 'gpt-5.2-chat-latest');
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return google(modelName || 'gemini-3-flash-preview');
  }

  throw new Error('No supported LLM provider configured.');
}

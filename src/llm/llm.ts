import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';

export const systemPrompt = `You are a Slack bot assigned to work as a customer service for Flanksource's Mission Control customers.
  Flanksource Mission Control is an Internal Developer Platform that helps teams improve developer productivity and operational resilience

  Format responses using Slack mrkdwn.
  "Avoid Markdown features Slack doesn't support, like # headers.`;

export function buildModel() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error('Missing required env var: ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }

  const modelName = process.env.LLM_MODEL ?? 'claude-haiku-4-5';
  return process.env.ANTHROPIC_API_KEY ? anthropic(modelName) : openai(modelName);
}

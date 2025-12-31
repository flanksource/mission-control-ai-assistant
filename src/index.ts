import 'dotenv/config';
import { anthropic } from '@ai-sdk/anthropic';
import { experimental_createMCPClient as createMCPClient, MCPClient } from '@ai-sdk/mcp';
import { openai } from '@ai-sdk/openai';
import { slackApp } from './slack';

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

async function getMCPClient(): Promise<MCPClient | undefined> {
  const mcpUrl = process.env.MCP_URL;
  if (!mcpUrl) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  const token = process.env.MCP_BEARER_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return await createMCPClient({
    transport: {
      type: 'http',
      url: mcpUrl,
      headers,
    },
  });
}

const model = buildModel();
const mcpClient = await getMCPClient();
const tools = await mcpClient?.tools();
const app = await slackApp(
  process.env.SLACK_BOT_TOKEN!,
  process.env.SLACK_APP_TOKEN!,
  model!,
  tools,
);
app.start();

process.on('SIGINT', onEventClose);
process.on('SIGTERM', onEventClose);
async function onEventClose(eventName: string) {
  console.log('stopping on' + eventName);

  await mcpClient?.close();
  console.log('MCP Client closed');

  await app.stop();
  console.log('slack bot stopped');
}

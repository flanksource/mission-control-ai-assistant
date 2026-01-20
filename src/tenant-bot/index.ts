import 'dotenv/config';
import { slackApp } from '../slack/app';
import { buildModel } from '../llm/llm';
import { getMCPClient, wrapMcpToolsWithApproval } from '../llm/mcp';
import { ProxyReceiver } from './receiver';
import { requireEnv } from '../shared/env';

async function run() {
  requireEnv(['SLACK_BOT_TOKEN', 'PROXY_WS_URL', 'PROXY_JWT']);

  const model = buildModel();
  const mcpClient = await getMCPClient();
  const tools = await mcpClient?.tools();
  const toolsWithApproval = tools ? wrapMcpToolsWithApproval(tools) : undefined;

  const receiver = new ProxyReceiver({
    url: process.env.PROXY_WS_URL!,
    jwt: process.env.PROXY_JWT!,
  });

  const app = await slackApp({
    botToken: process.env.SLACK_BOT_TOKEN!,
    receiver,
    model,
    tools: toolsWithApproval,
  });

  await app.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Stopping on ${signal}`);

    await mcpClient?.close();
    console.log('MCP Client closed');

    await app.stop();
    console.log('slack bot stopped');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

run();

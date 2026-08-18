import 'dotenv/config';
import { slackApp } from './slack/app';
import { buildModel } from './llm/llm';
import { getMCPClient, wrapMcpToolsWithApproval } from './llm/mcp';

async function run() {
  const requiredEnv = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
  for (const name of requiredEnv) {
    if (!process.env[name]) {
      throw new Error(`Missing required env var: ${name}`);
    }
  }

  const model = buildModel();
  let mcpClient: Awaited<ReturnType<typeof getMCPClient>>;
  let toolsWithApproval: ReturnType<typeof wrapMcpToolsWithApproval> | undefined;
  let mcpUnavailable = false;
  try {
    mcpClient = await getMCPClient();
    const tools = await mcpClient?.tools();
    toolsWithApproval = tools ? wrapMcpToolsWithApproval(tools) : undefined;
  } catch (error) {
    mcpUnavailable = true;
    console.error(
      'Failed to connect to the MCP server; starting in degraded mode:',
      error instanceof Error ? error.message : error,
    );
  }

  const app = await slackApp(
    process.env.SLACK_BOT_TOKEN!,
    process.env.SLACK_APP_TOKEN!,
    model!,
    toolsWithApproval,
    mcpUnavailable,
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
}

run();

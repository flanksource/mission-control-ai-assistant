import 'dotenv/config';
import { slackApp } from './slack/app';
import { buildModel } from './llm/llm';
import { getMCPClient, wrapMcpToolsWithApproval } from './llm/mcp';

const MCP_RETRY_INITIAL_DELAY_MS = 5_000;
const MCP_MAX_RETRIES = 5;

async function connectMCP() {
  let retryCount = 0;

  while (true) {
    let client: Awaited<ReturnType<typeof getMCPClient>> = undefined;
    try {
      client = await getMCPClient();
      const tools = await client?.tools();
      return {
        client,
        tools: tools ? wrapMcpToolsWithApproval(tools) : undefined,
      };
    } catch (error) {
      await client?.close().catch(() => {});
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (retryCount >= MCP_MAX_RETRIES) {
        console.error(
          `Failed to connect to the MCP server after ${retryCount + 1} attempts:`,
          message,
        );
        throw error;
      }

      const retryDelay = Math.round(
        MCP_RETRY_INITIAL_DELAY_MS * 2 ** retryCount * (0.5 + Math.random() * 0.5),
      );
      retryCount += 1;
      console.error(
        `Failed to connect to the MCP server; retrying ${retryCount}/${MCP_MAX_RETRIES} in ${Math.ceil(retryDelay / 1_000)}s:`,
        message,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

async function run() {
  const requiredEnv = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
  for (const name of requiredEnv) {
    if (!process.env[name]) {
      throw new Error(`Missing required env var: ${name}`);
    }
  }

  const model = buildModel();
  const { client: mcpClient, tools: toolsWithApproval } = await connectMCP();

  const app = await slackApp(
    process.env.SLACK_BOT_TOKEN!,
    process.env.SLACK_APP_TOKEN!,
    model!,
    toolsWithApproval,
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

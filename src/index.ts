import 'dotenv/config';
import { anthropic } from '@ai-sdk/anthropic';
import { experimental_createMCPClient as createMCPClient, MCPClient } from '@ai-sdk/mcp';
import { openai } from '@ai-sdk/openai';
import { slackApp } from './slack';
import type { ToolSet } from 'ai';

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

const TOOLS_WITH_NO_APPROVAL_REQUIRED = [
  'search_catalog',
  'read_artifact_content',
  'search_catalog_changes',
  'describe_catalog',
  'list_catalog_types',
  'get_related_configs',
  'list_connections',
  'search_health_checks',
  'get_check_status',
  'list_all_checks',
  'get_playbook_run_steps',
  'get_playbook_failed_runs',
  'get_playbook_recent_runs',
  'get_all_playbooks',
  'get_notifications_for_resource',
  'get_notification_detail',
  'read_artifact_metadata',
] as const;

function wrapMcpToolsWithApproval(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const noApproval =
        TOOLS_WITH_NO_APPROVAL_REQUIRED.includes(
          name as (typeof TOOLS_WITH_NO_APPROVAL_REQUIRED)[number],
        ) || name.startsWith('view_');

      return [
        name,
        {
          ...tool,
          needsApproval: !noApproval,
        },
      ];
    }),
  );
}

const model = buildModel();
const mcpClient = await getMCPClient();
const tools = (await mcpClient?.tools()) ?? undefined;
const toolsWithApproval = tools ? wrapMcpToolsWithApproval(tools) : undefined;
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

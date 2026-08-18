import { experimental_createMCPClient as createMCPClient, MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';

export async function getMCPClient(): Promise<MCPClient | undefined> {
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

export function wrapMcpToolsWithApproval(tools: ToolSet): ToolSet {
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

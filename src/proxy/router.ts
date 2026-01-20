import type { SQL } from 'bun';

export type RoutingIds = {
  teamId?: string | null;
  enterpriseId?: string | null;
};

export async function lookupTenantId(db: SQL, ids: RoutingIds): Promise<string | null> {
  if (ids.enterpriseId) {
    const rows = await db`SELECT tenant_id FROM slack_installations WHERE enterprise_id = ${ids.enterpriseId} LIMIT 1`;
    return rows[0]?.tenant_id ?? null;
  }

  if (ids.teamId) {
    const rows = await db`SELECT tenant_id FROM slack_installations WHERE team_id = ${ids.teamId} LIMIT 1`;
    return rows[0]?.tenant_id ?? null;
  }

  return null;
}

export function extractRoutingIds(payload: any): RoutingIds {
  if (!payload) {
    return { teamId: undefined, enterpriseId: undefined };
  }

  const teamId =
    payload?.team_id ||
    payload?.context_team_id ||
    payload?.team?.id ||
    payload?.authorizations?.[0]?.team_id ||
    payload?.event?.team;
  const enterpriseId =
    payload?.enterprise_id ||
    payload?.context_enterprise_id ||
    payload?.enterprise?.id ||
    payload?.authorizations?.[0]?.enterprise_id;
  return { teamId, enterpriseId };
}

export type RoutingIds = {
  teamId?: string | null;
  enterpriseId?: string | null;
};

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

export function buildRoutingKeys(ids: RoutingIds): string[] {
  const keys: string[] = [];
  if (ids.enterpriseId) {
    keys.push(`enterprise:${ids.enterpriseId}`);
  }
  if (ids.teamId) {
    keys.push(`team:${ids.teamId}`);
  }
  return keys;
}

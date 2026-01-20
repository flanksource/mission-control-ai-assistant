import type { SQL } from 'bun';

export async function runMigrations(db: SQL) {
  await db`CREATE TABLE IF NOT EXISTS slack_installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    team_id TEXT,
    enterprise_id TEXT,
    is_enterprise_install INTEGER NOT NULL DEFAULT 0
  )`;

  await db`CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_enterprise_unique
    ON slack_installations (enterprise_id)
    WHERE is_enterprise_install = 1`;

  await db`CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_team_unique
    ON slack_installations (team_id)
    WHERE is_enterprise_install = 0`;
}

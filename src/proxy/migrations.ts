import type { SQL } from 'bun';

export async function runMigrations(db: SQL) {
  // Slack includes enterprise_id for Enterprise Grid workspaces even on workspace-only installs,
  // so we track whether the install is enterprise-scoped.
  await db`CREATE TABLE IF NOT EXISTS slack_installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    team_id TEXT,
    enterprise_id TEXT,
    is_enterprise_install INTEGER NOT NULL DEFAULT 0,
    CHECK (
      (is_enterprise_install = 1 AND enterprise_id IS NOT NULL) OR
      (is_enterprise_install = 0 AND team_id IS NOT NULL)
    )
  )`;

  await db`CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_enterprise_unique
    ON slack_installations (enterprise_id)
    WHERE is_enterprise_install = 1`;

  await db`CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_team_unique
    ON slack_installations (team_id)
    WHERE is_enterprise_install = 0`;

  await db`CREATE TRIGGER IF NOT EXISTS slack_installations_validate_insert
    BEFORE INSERT ON slack_installations
    BEGIN
      SELECT
        CASE
          WHEN NEW.is_enterprise_install = 1 AND NEW.enterprise_id IS NULL THEN
            RAISE(ABORT, 'enterprise_id required for enterprise install')
          WHEN NEW.is_enterprise_install = 0 AND NEW.team_id IS NULL THEN
            RAISE(ABORT, 'team_id required for team install')
        END;
    END`;

  await db`CREATE TRIGGER IF NOT EXISTS slack_installations_validate_update
    BEFORE UPDATE ON slack_installations
    BEGIN
      SELECT
        CASE
          WHEN NEW.is_enterprise_install = 1 AND NEW.enterprise_id IS NULL THEN
            RAISE(ABORT, 'enterprise_id required for enterprise install')
          WHEN NEW.is_enterprise_install = 0 AND NEW.team_id IS NULL THEN
            RAISE(ABORT, 'team_id required for team install')
        END;
    END`;
}

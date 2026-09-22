-- Write migration SQL here.
CREATE TABLE suplex_github_trigger_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES suplex_companies(id),
  project_id TEXT NOT NULL REFERENCES suplex_projects(id),
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES suplex_workflows(id),
  delivery_target TEXT NOT NULL,
  protected_paths_json TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  repository_name TEXT NOT NULL,
  authority_user_id TEXT NOT NULL REFERENCES suplex_users(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  last_successful_check_at TEXT,
  next_retry_at TEXT,
  latest_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  recent_activity_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (enabled IN (0, 1)),
  CHECK (archived_at IS NULL OR enabled = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_github_trigger_rules_enabled_repository_unique
  ON suplex_github_trigger_rules(repository_id)
  WHERE enabled = 1 AND archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX suplex_github_trigger_rules_company_id_idx ON suplex_github_trigger_rules(company_id, archived_at, name);

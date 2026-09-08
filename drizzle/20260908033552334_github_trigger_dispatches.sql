-- Write migration SQL here.
CREATE TABLE forge_github_trigger_dispatches (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES forge_github_trigger_rules(id),
  company_id TEXT NOT NULL REFERENCES forge_companies(id),
  project_id TEXT NOT NULL REFERENCES forge_projects(id),
  repository_id INTEGER NOT NULL,
  repository_name TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  authority_user_id TEXT NOT NULL REFERENCES forge_users(id),
  request_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  preset_json TEXT NOT NULL,
  profiles_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT UNIQUE REFERENCES forge_tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(rule_id, repository_id, pull_request_number)
);
--> statement-breakpoint
CREATE INDEX forge_github_trigger_dispatches_rule_idx ON forge_github_trigger_dispatches(company_id, rule_id);

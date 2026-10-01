CREATE TABLE suplex_moves (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES suplex_companies(id),
  project_id TEXT NOT NULL REFERENCES suplex_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  runner TEXT NOT NULL,
  confirm INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES suplex_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name),
  CHECK (runner IN ('task', 'pull_request_tasks')),
  CHECK (confirm IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE suplex_move_runs (
  id TEXT PRIMARY KEY NOT NULL,
  move_id TEXT NOT NULL REFERENCES suplex_moves(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES suplex_companies(id),
  project_id TEXT NOT NULL REFERENCES suplex_projects(id) ON DELETE CASCADE,
  move_name TEXT NOT NULL,
  runner TEXT NOT NULL,
  prompt TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  excluded_pull_requests_json TEXT NOT NULL DEFAULT '[]',
  outcomes_json TEXT NOT NULL DEFAULT '[]',
  started_by_user_id TEXT REFERENCES suplex_users(id),
  started_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (move_id, idempotency_key)
);
--> statement-breakpoint
CREATE INDEX suplex_move_runs_move_started ON suplex_move_runs(move_id, started_at DESC);

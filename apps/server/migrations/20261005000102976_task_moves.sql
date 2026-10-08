CREATE TABLE suplex_moves_task (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES suplex_companies(id),
  project_id TEXT NOT NULL REFERENCES suplex_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  runner TEXT NOT NULL,
  profile_id TEXT REFERENCES suplex_profiles(id) ON DELETE SET NULL,
  confirm INTEGER NOT NULL DEFAULT 0,
  workflow TEXT NOT NULL DEFAULT 'standard',
  delivery_target TEXT NOT NULL DEFAULT 'pull_request_ready',
  run_project_tests INTEGER NOT NULL DEFAULT 1,
  visual_evidence TEXT NOT NULL DEFAULT 'off',
  created_by_user_id TEXT REFERENCES suplex_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name),
  CHECK (runner IN ('prompt', 'script', 'pull_request_tasks', 'task')),
  CHECK (confirm IN (0, 1)),
  CHECK (run_project_tests IN (0, 1))
);
--> statement-breakpoint
INSERT INTO suplex_moves_task (id, company_id, project_id, name, prompt, runner, profile_id, confirm, created_by_user_id, created_at, updated_at) SELECT id, company_id, project_id, name, prompt, runner, profile_id, confirm, created_by_user_id, created_at, updated_at FROM suplex_moves;
--> statement-breakpoint
DROP TABLE suplex_moves;
--> statement-breakpoint
ALTER TABLE suplex_moves_task RENAME TO suplex_moves;

CREATE TABLE suplex_prompt_overrides (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id TEXT REFERENCES suplex_projects(id),
  scope_key TEXT NOT NULL,
  template_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('inherit','append','replace')),
  content TEXT NOT NULL DEFAULT '',
  base_template_sha256 TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  updated_by_user_id TEXT NOT NULL REFERENCES suplex_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'global' AND project_id IS NULL AND scope_key = 'global')
      OR (scope = 'project' AND project_id IS NOT NULL AND scope_key = project_id))
);
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_prompt_overrides_scope_template_idx ON suplex_prompt_overrides(scope_key, template_id);
--> statement-breakpoint
CREATE TABLE suplex_prompt_override_revisions (
  id TEXT PRIMARY KEY,
  override_id TEXT NOT NULL REFERENCES suplex_prompt_overrides(id),
  revision INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('inherit','append','replace')),
  content TEXT NOT NULL,
  base_template_sha256 TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES suplex_users(id),
  note TEXT,
  restored_from_revision INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(override_id, revision)
);
--> statement-breakpoint
CREATE INDEX suplex_prompt_override_revisions_override_idx ON suplex_prompt_override_revisions(override_id, revision DESC);

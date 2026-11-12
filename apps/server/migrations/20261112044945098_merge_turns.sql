CREATE TABLE suplex_merge_turns (
  repository TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  holder_task_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (repository, base_branch)
);
--> statement-breakpoint
CREATE INDEX suplex_merge_turns_holder_idx ON suplex_merge_turns(holder_task_id);

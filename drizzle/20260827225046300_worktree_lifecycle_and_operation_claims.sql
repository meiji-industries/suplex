-- Write migration SQL here.
ALTER TABLE suplex_issue_worktrees ADD COLUMN removed_externally_at TEXT;
--> statement-breakpoint
ALTER TABLE suplex_issue_worktrees ADD COLUMN cleaned_at TEXT;
--> statement-breakpoint
CREATE TABLE suplex_operation_claims (
  operation_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX suplex_operation_claims_task_idx ON suplex_operation_claims(task_id, kind);

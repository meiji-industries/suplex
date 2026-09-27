CREATE TABLE suplex_github_trigger_delivery_operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES suplex_tasks(id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES suplex_github_trigger_dispatches(id) ON DELETE CASCADE,
  from_head_sha TEXT NOT NULL,
  to_head_sha TEXT NOT NULL,
  review_json TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE(dispatch_id, to_head_sha)
);
--> statement-breakpoint
CREATE INDEX suplex_github_trigger_delivery_operations_task_idx
  ON suplex_github_trigger_delivery_operations(task_id, confirmed_at);

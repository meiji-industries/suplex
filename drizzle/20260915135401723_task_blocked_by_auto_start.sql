ALTER TABLE suplex_tasks ADD COLUMN start_when_blocked_by_delivered INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX suplex_tasks_blocked_by_auto_start_idx ON suplex_tasks(blocked_by_task_id) WHERE start_when_blocked_by_delivered = 1;

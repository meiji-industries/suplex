ALTER TABLE suplex_task_sessions ADD COLUMN stop_requested_at text;
--> statement-breakpoint
ALTER TABLE suplex_task_sessions ADD COLUMN stopped_at text;
--> statement-breakpoint
UPDATE suplex_task_sessions SET stop_requested_at = updated_at WHERE lifecycle IN ('stopped', 'cancelled');

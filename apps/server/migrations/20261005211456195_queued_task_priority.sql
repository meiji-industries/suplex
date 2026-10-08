-- Write migration SQL here.
ALTER TABLE suplex_task_controls ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 0;

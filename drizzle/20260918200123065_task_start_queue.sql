-- The start intent of a queued task: it starts by itself when every prerequisite is complete. Rows that waited to start keep waiting; every other backlog task stays manual.
ALTER TABLE suplex_tasks RENAME COLUMN start_when_blocked_by_delivered TO start_queued;
--> statement-breakpoint
CREATE INDEX suplex_tasks_start_queued_idx ON suplex_tasks(id) WHERE start_queued = 1;

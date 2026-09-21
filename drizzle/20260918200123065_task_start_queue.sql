-- The start intent of a queued task: it starts by itself when every prerequisite is complete. Rows that waited to start keep waiting; every other backlog task stays manual.
ALTER TABLE forge_tasks RENAME COLUMN start_when_blocked_by_delivered TO start_queued;
--> statement-breakpoint
CREATE INDEX forge_tasks_start_queued_idx ON forge_tasks(id) WHERE start_queued = 1;

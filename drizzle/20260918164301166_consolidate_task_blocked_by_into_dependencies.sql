-- A Blocked by reference is a dependency edge. Existing edges stay; a self-reference or a missing target is not a dependency.
INSERT OR IGNORE INTO suplex_task_dependencies (task_id, depends_on_task_id, created_at)
SELECT t.id, t.blocked_by_task_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM suplex_tasks t JOIN suplex_tasks blocked ON blocked.id = t.blocked_by_task_id
WHERE t.blocked_by_task_id <> t.id;
--> statement-breakpoint
DROP INDEX IF EXISTS suplex_tasks_blocked_by_auto_start_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS suplex_tasks_blocked_by_task_id_idx;
--> statement-breakpoint
ALTER TABLE suplex_tasks DROP COLUMN blocked_by_task_id;

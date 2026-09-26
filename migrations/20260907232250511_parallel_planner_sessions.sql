-- Write migration SQL here.
ALTER TABLE suplex_task_sessions ADD COLUMN delegate_slot text;
--> statement-breakpoint
UPDATE suplex_task_sessions
SET delegate_slot = CASE advisor_role
  WHEN 'planner_a' THEN 'planner_a'
  WHEN 'planner_b' THEN 'planner_b'
  ELSE 'delegate'
END
WHERE kind = 'worker';
--> statement-breakpoint
DROP INDEX suplex_task_current_worker_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_task_current_delegate_slot_unique
  ON suplex_task_sessions (task_id, delegate_slot)
  WHERE is_current = 1 AND kind = 'worker';
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_task_session_generation_unique
  ON suplex_task_sessions (task_id, kind, generation);

-- Write migration SQL here.
ALTER TABLE forge_task_sessions ADD COLUMN delegate_slot text;
--> statement-breakpoint
UPDATE forge_task_sessions
SET delegate_slot = CASE advisor_role
  WHEN 'planner_a' THEN 'planner_a'
  WHEN 'planner_b' THEN 'planner_b'
  ELSE 'delegate'
END
WHERE kind = 'worker';
--> statement-breakpoint
DROP INDEX forge_task_current_worker_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX forge_task_current_delegate_slot_unique
  ON forge_task_sessions (task_id, delegate_slot)
  WHERE is_current = 1 AND kind = 'worker';
--> statement-breakpoint
CREATE UNIQUE INDEX forge_task_session_generation_unique
  ON forge_task_sessions (task_id, kind, generation);

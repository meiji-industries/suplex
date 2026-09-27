-- Write migration SQL here.
ALTER TABLE suplex_task_turns ADD COLUMN workflow_input_json text;
--> statement-breakpoint
UPDATE suplex_task_turns
SET workflow_input_json = (
  SELECT workflow_input_json
  FROM suplex_task_sessions
  WHERE suplex_task_sessions.id = suplex_task_turns.session_id
)
WHERE workflow_input_json IS NULL;

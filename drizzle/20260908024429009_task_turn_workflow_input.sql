-- Write migration SQL here.
ALTER TABLE forge_task_turns ADD COLUMN workflow_input_json text;
--> statement-breakpoint
UPDATE forge_task_turns
SET workflow_input_json = (
  SELECT workflow_input_json
  FROM forge_task_sessions
  WHERE forge_task_sessions.id = forge_task_turns.session_id
)
WHERE workflow_input_json IS NULL;

-- The person who wrote a Coordinator prompt: an answer or a note.
ALTER TABLE suplex_task_turns ADD COLUMN author_user_id text;
--> statement-breakpoint
-- An answer turn and its task_answered audit event share one timestamp.
UPDATE suplex_task_turns
SET author_user_id = (
  SELECT a.actor_user_id FROM suplex_audit_events a
  WHERE a.action = 'task_answered'
    AND a.created_at = suplex_task_turns.created_at
    AND json_extract(a.metadata_json, '$.taskId') = suplex_task_turns.task_id
  LIMIT 1
)
WHERE author_user_id IS NULL;

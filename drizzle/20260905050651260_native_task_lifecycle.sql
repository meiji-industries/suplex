CREATE TABLE forge_task_controls_native (
  task_id text PRIMARY KEY NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  objective text NOT NULL,
  delivery_target text NOT NULL,
  delivery_intent_json text NOT NULL,
  status text NOT NULL CHECK (status IN ('backlog', 'active', 'waiting_human', 'cancelled', 'delivered')),
  wake_at text,
  human_question text,
  human_question_id text,
  worktree_json text,
  pull_request_json text,
  root_session_id text,
  worker_session_id text,
  root_profile_json text NOT NULL,
  worker_profile_json text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CHECK ((status = 'waiting_human' AND human_question IS NOT NULL AND human_question_id IS NOT NULL)
    OR (status <> 'waiting_human' AND human_question IS NULL AND human_question_id IS NULL))
);
--> statement-breakpoint
INSERT INTO forge_task_controls_native
SELECT task_id, objective, delivery_target, delivery_intent_json, status, wake_at,
  CASE WHEN status = 'waiting_human' THEN human_question END,
  CASE WHEN status = 'waiting_human' THEN lower(hex(randomblob(16))) END,
  worktree_json, pull_request_json, root_session_id, worker_session_id,
  root_profile_json, worker_profile_json, created_at, updated_at
FROM forge_task_controls;
--> statement-breakpoint
DROP TABLE forge_task_controls;
--> statement-breakpoint
ALTER TABLE forge_task_controls_native RENAME TO forge_task_controls;

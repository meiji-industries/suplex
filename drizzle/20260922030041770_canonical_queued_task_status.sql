CREATE TABLE forge_task_controls_queued (
  task_id text PRIMARY KEY NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  objective text NOT NULL,
  delivery_target text NOT NULL,
  delivery_intent_json text NOT NULL,
  status text NOT NULL CHECK (status IN ('backlog', 'queued', 'active', 'waiting_human', 'cancelled', 'delivered')),
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
  updated_at text NOT NULL, recovery_turn_id TEXT REFERENCES forge_task_turns(id), human_question_options_json TEXT NOT NULL DEFAULT '[]', workflow text NOT NULL DEFAULT 'standard', advisor_profiles_json text NOT NULL DEFAULT '{}', workflow_state_json text NOT NULL DEFAULT '{"version":1,"reviews":[],"acceptedDelivery":null,"deliveryWait":null,"completion":null,"toolOwner":null}', budget_usd REAL, max_turns INTEGER, limit_pause_json TEXT, status_changed_at TEXT NOT NULL DEFAULT '', shell_pane_id TEXT,
  CHECK ((status = 'waiting_human' AND human_question IS NOT NULL AND human_question_id IS NOT NULL)
    OR (status <> 'waiting_human' AND human_question IS NULL AND human_question_id IS NULL))
);
--> statement-breakpoint
INSERT INTO forge_task_controls_queued (task_id, objective, delivery_target, delivery_intent_json, status, wake_at, human_question, human_question_id, worktree_json, pull_request_json, root_session_id, worker_session_id, root_profile_json, worker_profile_json, created_at, updated_at, recovery_turn_id, human_question_options_json, workflow, advisor_profiles_json, workflow_state_json, budget_usd, max_turns, limit_pause_json, status_changed_at, shell_pane_id) SELECT c.task_id, c.objective, c.delivery_target, c.delivery_intent_json, CASE WHEN c.status = 'backlog' AND t.start_queued = 1 AND t.archived_at IS NULL THEN 'queued' ELSE c.status END, c.wake_at, c.human_question, c.human_question_id, c.worktree_json, c.pull_request_json, c.root_session_id, c.worker_session_id, c.root_profile_json, c.worker_profile_json, c.created_at, c.updated_at, c.recovery_turn_id, c.human_question_options_json, c.workflow, c.advisor_profiles_json, c.workflow_state_json, c.budget_usd, c.max_turns, c.limit_pause_json, c.status_changed_at, c.shell_pane_id FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id;
--> statement-breakpoint
DROP TRIGGER forge_task_controls_status_changed_at;
--> statement-breakpoint
DROP TABLE forge_task_controls;
--> statement-breakpoint
ALTER TABLE forge_task_controls_queued RENAME TO forge_task_controls;
--> statement-breakpoint
CREATE TRIGGER forge_task_controls_status_changed_at
AFTER UPDATE OF status ON forge_task_controls
WHEN NEW.status IS NOT OLD.status
BEGIN
  UPDATE forge_task_controls SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE task_id = NEW.task_id;
END;
--> statement-breakpoint
UPDATE forge_hermes_task_command_receipts
SET result_json = (
  SELECT json_set(
    result_json,
    '$.status', CASE WHEN json_extract(result_json, '$.status') = 'backlog'
      AND json_extract(result_json, '$.queue.state') = 'queued'
      THEN 'queued' ELSE json_extract(result_json, '$.status') END,
    '$.queue', json_object('waitingOn', json(COALESCE((
      SELECT json_group_array(json(json_remove(json_set(wait.value, '$.status',
        CASE WHEN json_extract(wait.value, '$.status') = 'backlog'
          AND json_extract(wait.value, '$.queued') = 1
          THEN 'queued' ELSE json_extract(wait.value, '$.status') END), '$.queued')))
      FROM json_each(forge_hermes_task_command_receipts.result_json, '$.queue.waitingOn') AS wait
    ), '[]'))),
    '$.blockedBy', json(COALESCE((
      SELECT json_group_array(json(json_remove(json_set(blocker.value, '$.status',
        CASE WHEN json_extract(blocker.value, '$.status') = 'backlog'
          AND json_extract(blocker.value, '$.queued') = 1
          THEN 'queued' ELSE json_extract(blocker.value, '$.status') END), '$.queued')))
      FROM json_each(forge_hermes_task_command_receipts.result_json, '$.blockedBy') AS blocker
    ), '[]'))
  )
)
WHERE json_valid(result_json) AND json_type(result_json, '$.queue') = 'object';
--> statement-breakpoint
DROP INDEX forge_tasks_start_queued_idx;
--> statement-breakpoint
ALTER TABLE forge_tasks DROP COLUMN start_queued;

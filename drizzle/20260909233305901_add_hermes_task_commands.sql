ALTER TABLE suplex_tasks ADD COLUMN copied_from_task_id text REFERENCES suplex_tasks(id);
--> statement-breakpoint
ALTER TABLE suplex_tasks ADD COLUMN command_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE TABLE suplex_hermes_task_command_receipts (
  agent_id text NOT NULL REFERENCES suplex_external_agents(id),
  task_id text NOT NULL REFERENCES suplex_tasks(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  result_json text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (agent_id, task_id, idempotency_key)
);

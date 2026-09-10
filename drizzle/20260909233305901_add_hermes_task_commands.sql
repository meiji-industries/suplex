ALTER TABLE forge_tasks ADD COLUMN copied_from_task_id text REFERENCES forge_tasks(id);
--> statement-breakpoint
ALTER TABLE forge_tasks ADD COLUMN command_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE TABLE forge_hermes_task_command_receipts (
  agent_id text NOT NULL REFERENCES forge_external_agents(id),
  task_id text NOT NULL REFERENCES forge_tasks(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  result_json text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (agent_id, task_id, idempotency_key)
);

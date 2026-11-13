ALTER TABLE suplex_external_agents ADD COLUMN project_agents_granted_by_user_id TEXT REFERENCES suplex_users(id);
--> statement-breakpoint
ALTER TABLE suplex_external_agents ADD COLUMN project_agents_granted_at TEXT;
--> statement-breakpoint
CREATE TABLE suplex_external_agent_project_receipts (
  agent_id text NOT NULL REFERENCES suplex_external_agents(id),
  project_id text NOT NULL REFERENCES suplex_projects(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  result_json text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (agent_id, project_id, idempotency_key)
);

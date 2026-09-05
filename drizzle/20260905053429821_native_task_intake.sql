DROP TABLE forge_tasks;
--> statement-breakpoint
CREATE TABLE forge_tasks (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES forge_companies(id),
  project_id text NOT NULL REFERENCES forge_projects(id),
  issue_number integer,
  title text NOT NULL,
  description text NOT NULL,
  configuration_json text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  creator_user_id text REFERENCES forge_users(id),
  creator_agent_id text REFERENCES forge_agents(id),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  archived_at text,
  UNIQUE (id, company_id),
  UNIQUE (company_id, idempotency_key),
  UNIQUE (company_id, issue_number),
  CHECK ((creator_user_id IS NULL) <> (creator_agent_id IS NULL))
);
--> statement-breakpoint
CREATE TRIGGER forge_tasks_assign_issue_number
AFTER INSERT ON forge_tasks
WHEN NEW.issue_number IS NULL
BEGIN
  UPDATE forge_tasks SET issue_number = (SELECT next_issue_number FROM forge_companies WHERE id = NEW.company_id) WHERE id = NEW.id;
  UPDATE forge_companies SET next_issue_number = next_issue_number + 1 WHERE id = NEW.company_id;
END;
--> statement-breakpoint
ALTER TABLE forge_projects ADD COLUMN root_profile_id text NOT NULL DEFAULT 'profile_native_root';
--> statement-breakpoint
ALTER TABLE forge_projects ADD COLUMN worker_profile_id text NOT NULL DEFAULT 'profile_native_worker';

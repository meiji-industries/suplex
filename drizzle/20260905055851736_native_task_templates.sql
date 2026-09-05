DROP TABLE forge_task_templates;
--> statement-breakpoint
DROP TABLE forge_task_template_seeds;
--> statement-breakpoint
CREATE TABLE forge_task_templates (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES forge_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  configuration_json text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (project_id, name)
);

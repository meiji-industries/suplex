CREATE TABLE suplex_workflows_approval (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL UNIQUE,
  description text NOT NULL,
  engine text NOT NULL CHECK (engine IN ('standard', 'direct_build', 'independent_review', 'competing_plans', 'refine_pull_request', 'approve_then_build')),
  configuration_json text NOT NULL DEFAULT '{}',
  archived_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
INSERT INTO suplex_workflows_approval (id, name, description, engine, configuration_json, archived_at, created_at, updated_at) SELECT id, name, description, engine, configuration_json, archived_at, created_at, updated_at FROM suplex_workflows;
--> statement-breakpoint
DROP TABLE suplex_workflows;
--> statement-breakpoint
ALTER TABLE suplex_workflows_approval RENAME TO suplex_workflows;
--> statement-breakpoint
INSERT INTO suplex_workflows (id, name, description, engine, configuration_json, created_at, updated_at)
SELECT 'workflow_native_approve_then_build',
  CASE WHEN EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Approve then build') THEN 'Approve then build (Suplex)' ELSE 'Approve then build' END,
  'Coordinator writes a plan. You approve the plan or request changes before Worker builds it.', 'approve_then_build', '{}', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE id = 'workflow_native_approve_then_build');

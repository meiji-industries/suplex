CREATE TABLE forge_workflows (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL UNIQUE,
  description text NOT NULL,
  engine text NOT NULL CHECK (engine IN ('standard', 'direct_build', 'independent_review', 'competing_plans', 'refine_pull_request')),
  configuration_json text NOT NULL DEFAULT '{}',
  archived_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
INSERT INTO forge_workflows (id, name, description, engine, configuration_json, created_at, updated_at) VALUES
  ('workflow_native_standard', 'Standard', 'Coordinator plans, Worker builds, and Coordinator reviews the result.', 'standard', '{}', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
  ('workflow_native_direct_build', 'Direct build', 'Worker builds from your instructions. Coordinator reviews the result before delivery.', 'direct_build', '{}', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
  ('workflow_native_independent_review', 'Second opinion', 'A separate Reviewer checks the changes before Coordinator delivers the result.', 'independent_review', '{}', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
  ('workflow_native_competing_plans', 'Combined planning', 'Two agents write separate plans. Coordinator combines them and assigns the build to Worker.', 'competing_plans', '{}', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
  ('workflow_native_refine_pull_request', 'Pull request repair', 'Rater reviews an existing pull request. Worker applies repairs until it scores at least 9/10. Forge then pushes and merges it.', 'refine_pull_request', '{}', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');

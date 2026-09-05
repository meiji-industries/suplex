DROP TABLE IF EXISTS forge_acceptance_attempts;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_acceptances;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_agent_executions;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_ci_attempt_checks;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_ci_attempts;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_ci_checks;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_ci_repair_plans;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_ci_repairs;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_ci_runs;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_completion_receipts;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_decision_blocker_resolutions;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_delivery_decisions;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_delivery_findings;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_delivery_repairs;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_delivery_review_attempts;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_delivery_reviews;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_developer_execution_events;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_developer_executions;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_engine_activities;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_engine_commands;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_final_review_findings;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_final_reviews;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_forward_merges;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_herdr_project_workspaces;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_herdr_role_sessions;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_herdr_task_tabs;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_herdr_turns;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_issue_projections;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_issue_timeline;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_issue_worktrees;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_merge_conflict_resolutions;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_merge_observations;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_models;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_plan_blocker_responses;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_plan_decisions;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_plan_reviews;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_plan_revision_requests;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_planner_notes;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_prompt_override_revisions;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_prompt_overrides;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_provider_credentials;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_provider_operations;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_releases;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_successor_intents;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_task_configuration_backfill;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_task_creation_intents;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_task_template_seeds;
--> statement-breakpoint
DROP TABLE IF EXISTS forge_workflow_snapshots;
--> statement-breakpoint
DROP TABLE IF EXISTS worker_registrations;
--> statement-breakpoint
DELETE FROM forge_task_turns WHERE task_id NOT IN (SELECT id FROM forge_tasks);
--> statement-breakpoint
DELETE FROM forge_task_sessions WHERE task_id NOT IN (SELECT id FROM forge_tasks);
--> statement-breakpoint
DELETE FROM forge_task_controls WHERE task_id NOT IN (SELECT id FROM forge_tasks);
--> statement-breakpoint
DELETE FROM forge_artifacts WHERE task_id NOT IN (SELECT id FROM forge_tasks);
--> statement-breakpoint
DELETE FROM forge_task_command_activity WHERE task_id NOT IN (SELECT id FROM forge_tasks);
--> statement-breakpoint
ALTER TABLE forge_projects DROP COLUMN target_branch;
--> statement-breakpoint
ALTER TABLE forge_projects DROP COLUMN required_checks_json;
--> statement-breakpoint
ALTER TABLE forge_projects DROP COLUMN role_defaults_json;
--> statement-breakpoint
ALTER TABLE forge_projects DROP COLUMN status;

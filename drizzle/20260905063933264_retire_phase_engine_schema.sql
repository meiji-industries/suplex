DROP TABLE IF EXISTS suplex_acceptance_attempts;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_acceptances;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_agent_executions;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_ci_attempt_checks;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_ci_attempts;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_ci_checks;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_ci_repair_plans;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_ci_repairs;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_ci_runs;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_completion_receipts;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_decision_blocker_resolutions;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_delivery_decisions;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_delivery_findings;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_delivery_repairs;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_delivery_review_attempts;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_delivery_reviews;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_developer_execution_events;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_developer_executions;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_engine_activities;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_engine_commands;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_final_review_findings;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_final_reviews;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_forward_merges;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_herdr_project_workspaces;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_herdr_role_sessions;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_herdr_task_tabs;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_herdr_turns;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_issue_projections;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_issue_timeline;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_issue_worktrees;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_merge_conflict_resolutions;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_merge_observations;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_models;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_plan_blocker_responses;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_plan_decisions;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_plan_reviews;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_plan_revision_requests;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_planner_notes;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_prompt_override_revisions;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_prompt_overrides;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_provider_credentials;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_provider_operations;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_releases;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_successor_intents;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_task_configuration_backfill;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_task_creation_intents;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_task_template_seeds;
--> statement-breakpoint
DROP TABLE IF EXISTS suplex_workflow_snapshots;
--> statement-breakpoint
DROP TABLE IF EXISTS worker_registrations;
--> statement-breakpoint
DELETE FROM suplex_task_turns WHERE task_id NOT IN (SELECT id FROM suplex_tasks);
--> statement-breakpoint
DELETE FROM suplex_task_sessions WHERE task_id NOT IN (SELECT id FROM suplex_tasks);
--> statement-breakpoint
DELETE FROM suplex_task_controls WHERE task_id NOT IN (SELECT id FROM suplex_tasks);
--> statement-breakpoint
DELETE FROM suplex_artifacts WHERE task_id NOT IN (SELECT id FROM suplex_tasks);
--> statement-breakpoint
DELETE FROM suplex_task_command_activity WHERE task_id NOT IN (SELECT id FROM suplex_tasks);
--> statement-breakpoint
ALTER TABLE suplex_projects DROP COLUMN target_branch;
--> statement-breakpoint
ALTER TABLE suplex_projects DROP COLUMN required_checks_json;
--> statement-breakpoint
ALTER TABLE suplex_projects DROP COLUMN role_defaults_json;
--> statement-breakpoint
ALTER TABLE suplex_projects DROP COLUMN status;

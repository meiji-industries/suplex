CREATE TABLE IF NOT EXISTS `suplex_plan_authorizations` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `project_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `plan_revision` integer NOT NULL,
  `plan_artifact_id` text NOT NULL,
  `plan_sha256` text NOT NULL,
  `authorization_kind` text NOT NULL,
  `approval_decision_id` text,
  `authorized_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`project_id`) REFERENCES `suplex_projects`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`workflow_id`) REFERENCES `suplex_tasks`(`workflow_id`) ON DELETE CASCADE,
  FOREIGN KEY (`plan_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`approval_decision_id`) REFERENCES `suplex_plan_decisions`(`id`),
  CONSTRAINT `suplex_plan_authorizations_kind_check` CHECK (`authorization_kind` IN ('routine_auto', 'human_approval')),
  CONSTRAINT `suplex_plan_authorizations_decision_check` CHECK ((`authorization_kind` = 'human_approval' AND `approval_decision_id` IS NOT NULL) OR (`authorization_kind` = 'routine_auto' AND `approval_decision_id` IS NULL)),
  CONSTRAINT `suplex_plan_authorizations_sha_check` CHECK (length(`plan_sha256`) = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_plan_authorizations_workflow_revision_idx` ON `suplex_plan_authorizations` (`workflow_id`, `plan_revision`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_plan_authorizations_task_idx` ON `suplex_plan_authorizations` (`task_id`, `plan_revision`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_plan_authorizations_company_guard`
BEFORE INSERT ON `suplex_plan_authorizations`
WHEN EXISTS (SELECT 1 FROM `suplex_artifacts` a WHERE a.id = NEW.plan_artifact_id AND a.company_id <> NEW.company_id)
BEGIN SELECT RAISE(ABORT, 'plan authorization artifact company mismatch'); END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_issue_worktrees` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `project_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `repository_path` text NOT NULL,
  `worktree_root` text NOT NULL,
  `worktree_path` text NOT NULL,
  `branch_name` text NOT NULL,
  `starting_sha` text NOT NULL,
  `lease_token_hash` text NOT NULL,
  `legacy` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL,
  `reserved_at` text NOT NULL,
  `activated_at` text,
  `released_at` text,
  `failure_code` text,
  `failure_summary` text,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`project_id`) REFERENCES `suplex_projects`(`id`) ON DELETE CASCADE,
  CONSTRAINT `suplex_issue_worktrees_status_check` CHECK (`status` IN ('reserved', 'active', 'ambiguous', 'released')),
  CONSTRAINT `suplex_issue_worktrees_legacy_check` CHECK (`legacy` IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_issue_worktrees_task_active_idx` ON `suplex_issue_worktrees` (`task_id`) WHERE `status` <> 'released';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_issue_worktrees_branch_active_idx` ON `suplex_issue_worktrees` (`branch_name`) WHERE `status` <> 'released';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_issue_worktrees_path_active_idx` ON `suplex_issue_worktrees` (`worktree_path`) WHERE `status` <> 'released';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_developer_execution_truth` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `authorization_id` text NOT NULL,
  `worktree_lease_id` text NOT NULL,
  `manifest_artifact_id` text NOT NULL,
  `manifest_sha256` text NOT NULL,
  `boundary_mode` text NOT NULL DEFAULT 'owner_controlled_observed',
  `before_provider_artifact_id` text,
  `before_provider_sha256` text,
  `after_provider_artifact_id` text,
  `after_provider_sha256` text,
  `raw_report_artifact_id` text,
  `raw_report_sha256` text,
  `reconciliation_artifact_id` text,
  `reconciliation_sha256` text,
  `starting_commit` text NOT NULL,
  `starting_tree` text NOT NULL,
  `final_commit` text,
  `final_tree` text,
  FOREIGN KEY (`execution_id`) REFERENCES `suplex_developer_executions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`authorization_id`) REFERENCES `suplex_plan_authorizations`(`id`),
  FOREIGN KEY (`worktree_lease_id`) REFERENCES `suplex_issue_worktrees`(`id`),
  FOREIGN KEY (`manifest_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`before_provider_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`after_provider_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`raw_report_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`reconciliation_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  CONSTRAINT `suplex_developer_execution_truth_boundary_check` CHECK (`boundary_mode` = 'owner_controlled_observed')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_developer_execution_events` (
  `event_id` text PRIMARY KEY NOT NULL,
  `execution_id` text NOT NULL,
  `attempt` integer NOT NULL,
  `sequence` integer NOT NULL,
  `kind` text NOT NULL,
  `step_number` integer,
  `source_item_id` text,
  `occurred_at` text NOT NULL,
  `summary` text NOT NULL,
  `exit_code` integer,
  `artifact_id` text,
  `artifact_sha256` text,
  `idempotency_key` text NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `suplex_developer_executions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`artifact_id`) REFERENCES `suplex_artifacts`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_developer_execution_events_sequence_idx` ON `suplex_developer_execution_events` (`execution_id`, `sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_developer_execution_events_idempotency_idx` ON `suplex_developer_execution_events` (`execution_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_developer_execution_events_step_idx` ON `suplex_developer_execution_events` (`execution_id`, `step_number`, `sequence`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_developer_execution_events_no_update`
BEFORE UPDATE ON `suplex_developer_execution_events`
BEGIN SELECT RAISE(ABORT, 'developer execution events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_developer_execution_events_no_delete`
BEFORE DELETE ON `suplex_developer_execution_events`
BEGIN SELECT RAISE(ABORT, 'developer execution events are append-only'); END;

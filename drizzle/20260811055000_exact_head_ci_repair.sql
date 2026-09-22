ALTER TABLE `suplex_releases` ADD COLUMN `superseded_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_releases` ADD COLUMN `superseded_by_release_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `pull_request_number` integer;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `expected_base_branch` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `expected_head_branch` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `expected_head_tree` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `project_revision_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `policy_hash` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `policy_json` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `first_observed_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `propagation_deadline` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `overall_deadline` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `consecutive_provider_failures` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `completed_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `superseded_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_ci_runs` ADD COLUMN `superseded_by_run_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_ci_runs_authoritative_key_unique` ON `suplex_ci_runs` (`release_id`, `expected_head_sha`, `policy_hash`) WHERE `policy_hash` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_ci_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `attempt_number` integer NOT NULL,
  `observed_repository` text,
  `observed_pr_number` integer,
  `observed_base_branch` text,
  `observed_base_sha` text,
  `observed_head_branch` text,
  `observed_head_sha` text,
  `outcome` text NOT NULL,
  `reason` text NOT NULL,
  `owner` text,
  `repairable` integer NOT NULL DEFAULT 0,
  `retry_at` text,
  `summary` text NOT NULL,
  `evidence_artifact_id` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `suplex_ci_runs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `suplex_ci_attempts_run_number_unique` UNIQUE(`run_id`, `attempt_number`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_ci_attempts_run_idx` ON `suplex_ci_attempts` (`run_id`, `attempt_number`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_ci_attempt_checks` (
  `id` text PRIMARY KEY NOT NULL,
  `attempt_id` text NOT NULL,
  `provider_check_id` text NOT NULL,
  `name` text NOT NULL,
  `head_sha` text NOT NULL,
  `status` text NOT NULL,
  `conclusion` text,
  `details_url` text,
  `summary` text,
  `started_at` text,
  `completed_at` text,
  `selected_for_evaluation` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  FOREIGN KEY (`attempt_id`) REFERENCES `suplex_ci_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `suplex_ci_attempt_checks_attempt_provider_unique` UNIQUE(`attempt_id`, `provider_check_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_ci_attempt_checks_attempt_name_idx` ON `suplex_ci_attempt_checks` (`attempt_id`, `name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_ci_attempt_checks_head_name_idx` ON `suplex_ci_attempt_checks` (`head_sha`, `name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_ci_repair_plans` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `ci_run_id` text NOT NULL,
  `ci_attempt_id` text NOT NULL,
  `failed_head_sha` text NOT NULL,
  `lead_execution_id` text NOT NULL,
  `lead_session_ref` text NOT NULL,
  `plan_artifact_id` text NOT NULL,
  `evidence_artifact_id` text NOT NULL,
  `status` text NOT NULL,
  `summary` text NOT NULL,
  `failure_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `consumed_at` text,
  `superseded_at` text,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`ci_run_id`) REFERENCES `suplex_ci_runs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`ci_attempt_id`) REFERENCES `suplex_ci_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`plan_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `suplex_ci_repair_plans_active_unique` UNIQUE(`ci_run_id`, `ci_attempt_id`, `status`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_ci_repairs` (
  `id` text PRIMARY KEY NOT NULL,
  `repair_plan_id` text NOT NULL,
  `prior_developer_execution_id` text NOT NULL,
  `prior_developer_session_ref` text NOT NULL,
  `result_developer_execution_id` text,
  `result_developer_session_ref` text,
  `worktree_path` text NOT NULL,
  `branch_name` text NOT NULL,
  `prior_commit` text NOT NULL,
  `prior_tree` text NOT NULL,
  `new_commit` text,
  `new_tree` text,
  `delivery_artifact_id` text,
  `evidence_artifact_id` text,
  `status` text NOT NULL,
  `failure_code` text,
  `summary` text,
  `created_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`repair_plan_id`) REFERENCES `suplex_ci_repair_plans`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`delivery_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_ci_repairs_plan_idx` ON `suplex_ci_repairs` (`repair_plan_id`, `created_at`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_ci_attempts_immutable_update`
BEFORE UPDATE ON `suplex_ci_attempts`
BEGIN
  SELECT RAISE(ABORT, 'suplex_ci_attempts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_ci_attempt_checks_immutable_update`
BEFORE UPDATE ON `suplex_ci_attempt_checks`
BEGIN
  SELECT RAISE(ABORT, 'suplex_ci_attempt_checks are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_ci_repair_plans_scope_insert`
BEFORE INSERT ON `suplex_ci_repair_plans`
WHEN NOT EXISTS (
  SELECT 1
  FROM `suplex_ci_runs` c
  JOIN `suplex_releases` r ON r.id = c.release_id
  JOIN `suplex_ci_attempts` a ON a.id = NEW.ci_attempt_id AND a.run_id = c.id
  JOIN `suplex_tasks` t ON t.id = c.task_id AND t.company_id = c.company_id AND t.workflow_id = r.workflow_id
  WHERE c.id = NEW.ci_run_id
    AND c.task_id = NEW.task_id
    AND c.company_id = NEW.company_id
    AND r.workflow_id = NEW.workflow_id
)
BEGIN
  SELECT RAISE(ABORT, 'suplex_ci_repair_plans scope mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_ci_repairs_scope_insert`
BEFORE INSERT ON `suplex_ci_repairs`
WHEN NOT EXISTS (
  SELECT 1
  FROM `suplex_ci_repair_plans` p
  JOIN `suplex_developer_executions` d
    ON d.id = NEW.prior_developer_execution_id
   AND d.task_id = p.task_id
   AND d.company_id = p.company_id
   AND d.workflow_id = p.workflow_id
   AND d.session_ref = NEW.prior_developer_session_ref
  WHERE p.id = NEW.repair_plan_id
)
BEGIN
  SELECT RAISE(ABORT, 'suplex_ci_repairs prior developer scope mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_ci_repairs_scope_update`
BEFORE UPDATE OF `result_developer_execution_id`, `result_developer_session_ref` ON `suplex_ci_repairs`
WHEN NEW.result_developer_execution_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM `suplex_ci_repair_plans` p
  JOIN `suplex_developer_executions` d
    ON d.id = NEW.result_developer_execution_id
   AND d.task_id = p.task_id
   AND d.company_id = p.company_id
   AND d.workflow_id = p.workflow_id
   AND d.session_ref = NEW.result_developer_session_ref
  WHERE p.id = NEW.repair_plan_id
)
BEGIN
  SELECT RAISE(ABORT, 'suplex_ci_repairs result developer scope mismatch');
END;

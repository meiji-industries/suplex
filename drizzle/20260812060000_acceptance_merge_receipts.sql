ALTER TABLE `forge_final_reviews` ADD COLUMN `delivery_review_id` text;
--> statement-breakpoint
ALTER TABLE `forge_final_reviews` ADD COLUMN `developer_execution_id` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `workflow_id` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `operation_key` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `project_revision_id` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `pr_number` integer;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `base_sha` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `lead_session_ref` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `reason_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `ready_at` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `failure_code` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `retry_at` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_acceptances_operation_key_unique`
  ON `forge_acceptances` (`operation_key`) WHERE `operation_key` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_acceptance_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`acceptance_id` text NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`observed_state` text,
	`observed_is_draft` integer,
	`error_code` text,
	`retry_at` text,
	`evidence_artifact_id` text,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`acceptance_id`) REFERENCES `forge_acceptances`(`id`) ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON DELETE cascade,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`),
	UNIQUE (`acceptance_id`, `attempt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_merge_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`observation_key` text NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`release_id` text NOT NULL,
	`acceptance_id` text NOT NULL,
	`repository` text NOT NULL,
	`pr_number` integer NOT NULL,
	`expected_base_branch` text NOT NULL,
	`expected_head_sha` text NOT NULL,
	`observed_base_branch` text,
	`observed_base_sha` text,
	`observed_head_sha` text,
	`provider_state` text NOT NULL,
	`outcome` text NOT NULL,
	`provider_merged_at` text,
	`evidence_artifact_id` text,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `forge_releases`(`id`),
	FOREIGN KEY (`acceptance_id`) REFERENCES `forge_acceptances`(`id`),
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`),
	UNIQUE (`observation_key`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_completion_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`project_revision_id` text NOT NULL,
	`release_id` text NOT NULL,
	`acceptance_id` text NOT NULL,
	`merge_observation_id` text NOT NULL,
	`delivery_review_id` text NOT NULL,
	`final_review_id` text NOT NULL,
	`ci_run_id` text NOT NULL,
	`repository` text NOT NULL,
	`pr_number` integer NOT NULL,
	`base_branch` text NOT NULL,
	`accepted_base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`head_tree` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`accepted_at` text NOT NULL,
	`observed_at` text NOT NULL,
	`provider_merged_at` text NOT NULL,
	`deployment_status` text NOT NULL DEFAULT 'unknown',
	`receipt_artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `forge_releases`(`id`),
	FOREIGN KEY (`acceptance_id`) REFERENCES `forge_acceptances`(`id`),
	FOREIGN KEY (`merge_observation_id`) REFERENCES `forge_merge_observations`(`id`),
	FOREIGN KEY (`delivery_review_id`) REFERENCES `forge_delivery_reviews`(`id`),
	FOREIGN KEY (`final_review_id`) REFERENCES `forge_final_reviews`(`id`),
	FOREIGN KEY (`ci_run_id`) REFERENCES `forge_ci_runs`(`id`),
	FOREIGN KEY (`receipt_artifact_id`) REFERENCES `forge_artifacts`(`id`),
	CONSTRAINT `forge_completion_receipts_deployment_status_check` CHECK (`deployment_status` = 'unknown'),
	UNIQUE (`acceptance_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_acceptance_attempts_task_idx` ON `forge_acceptance_attempts` (`task_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_merge_observations_task_idx` ON `forge_merge_observations` (`task_id`, `observed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_completion_receipts_task_idx` ON `forge_completion_receipts` (`task_id`, `created_at`);

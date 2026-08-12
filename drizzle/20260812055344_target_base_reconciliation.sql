ALTER TABLE `forge_forward_merges` ADD COLUMN `workflow_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `project_revision_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `checkpoint` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `operation_key` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `prior_tree` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `result_head` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `result_tree` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `developer_execution_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `conflict_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `conflict_artifact_sha256` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `conflict_file_count` integer;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `verification_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `verification_artifact_sha256` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `delivery_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `delivery_artifact_sha256` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `supersedes_delivery_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `supersedes_evidence_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `invalidated_delivery_review_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `invalidated_ci_run_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `invalidated_final_review_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `invalidated_acceptance_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `release_id` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `pull_request_number` integer;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `failure_code` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `failure_summary` text;
--> statement-breakpoint
ALTER TABLE `forge_forward_merges` ADD COLUMN `updated_at` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_forward_merges_operation_key_unique`
  ON `forge_forward_merges` (`operation_key`)
  WHERE `operation_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `forge_developer_executions` ADD COLUMN `execution_kind` text NOT NULL DEFAULT 'agent';

ALTER TABLE `suplex_issue_outputs` ADD COLUMN `original_plan_revision` integer;
--> statement-breakpoint
ALTER TABLE `suplex_issue_outputs` ADD COLUMN `final_version` integer;
--> statement-breakpoint
ALTER TABLE `suplex_issue_outputs` ADD COLUMN `artifact_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_issue_outputs` ADD COLUMN `supersedes_output_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_issue_outputs` ADD COLUMN `evidence_manifest_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_issue_outputs` ADD COLUMN `evidence_manifest_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_issue_outputs` ADD COLUMN `materiality_evidence_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_issue_outputs` ADD COLUMN `materiality_evidence_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_issue_outputs` ADD COLUMN `legacy_unverified` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews` ADD COLUMN `original_plan_revision` integer;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews` ADD COLUMN `plan_output_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews` ADD COLUMN `plan_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews` ADD COLUMN `plan_artifact_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews` ADD COLUMN `evidence_manifest_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews` ADD COLUMN `evidence_manifest_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews` ADD COLUMN `opinion_artifact_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews` ADD COLUMN `legacy_unverified` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `original_plan_revision` integer;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `final_version` integer;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `plan_output_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `plan_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `plan_artifact_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `materiality_evidence_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `materiality_evidence_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `expected_workflow_revision` integer;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `idempotency_key` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `subject_hash` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `note_artifact_sha256` text;
--> statement-breakpoint
ALTER TABLE `suplex_plan_decisions` ADD COLUMN `legacy_unverified` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_plan_review_responses` (
  `id` text PRIMARY KEY NOT NULL,
  `review_id` text NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `original_plan_revision` integer NOT NULL,
  `lead_execution_id` text NOT NULL,
  `lead_session_ref` text NOT NULL,
  `response_artifact_id` text NOT NULL,
  `response_artifact_sha256` text NOT NULL,
  `result_output_id` text,
  `result_blocker_artifact_id` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`review_id`) REFERENCES `suplex_plan_reviews`(`id`) ON DELETE cascade,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON DELETE cascade,
  UNIQUE (`review_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_plan_blocker_responses` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `blocker_artifact_id` text NOT NULL,
  `blocker_artifact_sha256` text NOT NULL,
  `answer_artifact_id` text NOT NULL,
  `answer_artifact_sha256` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `expected_workflow_revision` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `subject_hash` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON DELETE cascade,
  FOREIGN KEY (`actor_user_id`) REFERENCES `suplex_users`(`id`) ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_plan_outputs_verified_unique` ON `suplex_issue_outputs` (`workflow_id`, `original_plan_revision`, `final_version`) WHERE `legacy_unverified` = 0 AND `final_version` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_plan_outputs_consolidated_unique` ON `suplex_issue_outputs` (`workflow_id`, `original_plan_revision`) WHERE `legacy_unverified` = 0 AND `final_version` = 2;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_plan_decisions_key_unique` ON `suplex_plan_decisions` (`workflow_id`, `idempotency_key`) WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_plan_decisions_subject_unique` ON `suplex_plan_decisions` (`workflow_id`, `plan_artifact_id`, `plan_artifact_sha256`) WHERE `legacy_unverified` = 0 AND decision = 'approve';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_plan_blocker_responses_key_unique` ON `suplex_plan_blocker_responses` (`workflow_id`, `idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_plan_blocker_responses_subject_unique` ON `suplex_plan_blocker_responses` (`workflow_id`, `blocker_artifact_id`, `blocker_artifact_sha256`);

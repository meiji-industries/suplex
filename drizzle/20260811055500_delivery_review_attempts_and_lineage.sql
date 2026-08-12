ALTER TABLE `forge_delivery_reviews` ADD COLUMN `supersedes_review_id` text REFERENCES `forge_delivery_reviews`(`id`) ON UPDATE no action ON DELETE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_delivery_reviews_supersedes_unique` ON `forge_delivery_reviews` (`supersedes_review_id`) WHERE `supersedes_review_id` IS NOT NULL;
--> statement-breakpoint

ALTER TABLE `forge_delivery_repairs` ADD COLUMN `subject_tree` text;
--> statement-breakpoint
ALTER TABLE `forge_delivery_repairs` ADD COLUMN `result_tree` text;
--> statement-breakpoint
ALTER TABLE `forge_delivery_repairs` ADD COLUMN `delivery_artifact_id` text REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action;
--> statement-breakpoint
ALTER TABLE `forge_delivery_repairs` ADD COLUMN `developer_session_ref` text;
--> statement-breakpoint
ALTER TABLE `forge_delivery_repairs` ADD COLUMN `branch_name` text;
--> statement-breakpoint
ALTER TABLE `forge_delivery_repairs` ADD COLUMN `worktree_path` text;
--> statement-breakpoint
ALTER TABLE `forge_delivery_repairs` ADD COLUMN `failure_code` text;
--> statement-breakpoint
ALTER TABLE `forge_delivery_repairs` ADD COLUMN `failure_summary` text;
--> statement-breakpoint
ALTER TABLE `forge_delivery_repairs` ADD COLUMN `finished_at` text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `forge_delivery_review_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `plan_revision` integer NOT NULL,
  `base_sha` text NOT NULL,
  `subject_commit` text NOT NULL,
  `subject_tree` text NOT NULL,
  `developer_execution_id` text,
  `delivery_artifact_id` text,
  `developer_evidence_artifact_id` text,
  `lead_execution_id` text NOT NULL,
  `lead_session_ref` text NOT NULL,
  `developer_session_ref` text,
  `status` text NOT NULL,
  `correction_attempts` integer,
  `evidence_artifact_id` text,
  `failure_code` text,
  `failure_summary` text,
  `completed_review_id` text,
  `supersedes_review_id` text,
  `created_at` text NOT NULL,
  `finished_at` text,
  FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`lead_execution_id`) REFERENCES `forge_agent_executions`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`developer_execution_id`) REFERENCES `forge_developer_executions`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`delivery_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`developer_evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`completed_review_id`) REFERENCES `forge_delivery_reviews`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`supersedes_review_id`) REFERENCES `forge_delivery_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_delivery_review_attempts_task_idx` ON `forge_delivery_review_attempts` (`task_id`, `company_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_delivery_review_attempts_subject_idx` ON `forge_delivery_review_attempts` (`workflow_id`, `subject_commit`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_delivery_review_attempts_review_idx` ON `forge_delivery_review_attempts` (`completed_review_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_delivery_review_attempts_supersedes_idx` ON `forge_delivery_review_attempts` (`supersedes_review_id`);
--> statement-breakpoint

INSERT OR IGNORE INTO `forge_delivery_review_attempts` (
  id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree,
  lead_execution_id, lead_session_ref, status, correction_attempts, evidence_artifact_id,
  completed_review_id, supersedes_review_id, created_at, finished_at
)
SELECT
  'review_attempt_backfill_' || r.id, r.task_id, r.company_id, r.workflow_id, r.plan_revision,
  r.base_sha, r.subject_commit, r.subject_tree, r.lead_execution_id, r.session_ref,
  'completed', NULL, r.evidence_artifact_id, r.id, r.supersedes_review_id, r.created_at, r.created_at
FROM forge_delivery_reviews r;

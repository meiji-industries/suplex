-- Write migration SQL here.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `forge_acceptances_next` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `release_id` text NOT NULL,
  `review_id` text,
  `ci_run_id` text,
  `repository` text NOT NULL,
  `base_branch` text NOT NULL,
  `head_sha` text NOT NULL,
  `head_tree` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `decision` text NOT NULL,
  `status` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `final_review_id` text,
  `workflow_id` text,
  `operation_key` text,
  `project_revision_id` text,
  `pr_number` integer,
  `base_sha` text,
  `lead_session_ref` text,
  `reason_artifact_id` text,
  `ready_at` text,
  `failure_code` text,
  `retry_at` text,
  FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`release_id`) REFERENCES `forge_releases`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`review_id`) REFERENCES `forge_delivery_reviews`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`ci_run_id`) REFERENCES `forge_ci_runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`actor_user_id`) REFERENCES `forge_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `forge_acceptances_next` SELECT id, task_id, company_id, release_id, review_id, ci_run_id, repository, base_branch, head_sha, head_tree, actor_user_id, decision, status, created_at, updated_at, final_review_id, workflow_id, operation_key, project_revision_id, pr_number, base_sha, lead_session_ref, reason_artifact_id, ready_at, failure_code, retry_at FROM `forge_acceptances`;
--> statement-breakpoint
DROP TABLE `forge_acceptances`;
--> statement-breakpoint
ALTER TABLE `forge_acceptances_next` RENAME TO `forge_acceptances`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_acceptances_operation_key_unique` ON `forge_acceptances` (`operation_key`) WHERE `operation_key` IS NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;

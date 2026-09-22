-- Write migration SQL here.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `suplex_plan_reviews_new` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `plan_revision` integer NOT NULL,
  `profile_id` text NOT NULL,
  `execution_id` text NOT NULL,
  `session_ref` text NOT NULL,
  `opinion_artifact_id` text NOT NULL,
  `evidence_artifact_id` text NOT NULL,
  `summary` text NOT NULL,
  `verdict` text NOT NULL DEFAULT 'approve',
  `planner_response_artifact_id` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON DELETE cascade,
  FOREIGN KEY (`execution_id`) REFERENCES `suplex_agent_executions`(`id`) ON DELETE no action,
  FOREIGN KEY (`opinion_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON DELETE no action,
  FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON DELETE no action,
  FOREIGN KEY (`planner_response_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON DELETE no action,
  UNIQUE(`workflow_id`, `plan_revision`)
);
--> statement-breakpoint
INSERT INTO `suplex_plan_reviews_new` (`id`,`task_id`,`company_id`,`workflow_id`,`plan_revision`,`profile_id`,`execution_id`,`session_ref`,`opinion_artifact_id`,`evidence_artifact_id`,`summary`,`created_at`)
SELECT `id`,`task_id`,`company_id`,`workflow_id`,`plan_revision`,`profile_id`,`execution_id`,`session_ref`,`opinion_artifact_id`,`evidence_artifact_id`,`summary`,`created_at` FROM `suplex_plan_reviews`;
--> statement-breakpoint
DROP TABLE `suplex_plan_reviews`;
--> statement-breakpoint
ALTER TABLE `suplex_plan_reviews_new` RENAME TO `suplex_plan_reviews`;
--> statement-breakpoint
CREATE INDEX `suplex_plan_reviews_task_idx` ON `suplex_plan_reviews` (`task_id`, `plan_revision`);
--> statement-breakpoint
DROP TABLE `suplex_plan_review_responses`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;

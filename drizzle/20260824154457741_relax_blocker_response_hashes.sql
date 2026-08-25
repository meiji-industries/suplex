PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `forge_plan_blocker_responses_new` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `blocker_artifact_id` text NOT NULL,
  `blocker_artifact_sha256` text,
  `answer_artifact_id` text NOT NULL,
  `answer_artifact_sha256` text,
  `actor_user_id` text NOT NULL,
  `expected_workflow_revision` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `subject_hash` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON DELETE cascade,
  FOREIGN KEY (`actor_user_id`) REFERENCES `forge_users`(`id`) ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `forge_plan_blocker_responses_new`
SELECT * FROM `forge_plan_blocker_responses`;
--> statement-breakpoint
DROP TABLE `forge_plan_blocker_responses`;
--> statement-breakpoint
ALTER TABLE `forge_plan_blocker_responses_new` RENAME TO `forge_plan_blocker_responses`;
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_plan_blocker_responses_key_unique`
ON `forge_plan_blocker_responses` (`workflow_id`, `idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_plan_blocker_responses_subject_unique`
ON `forge_plan_blocker_responses` (`workflow_id`, `blocker_artifact_id`, `blocker_artifact_sha256`);
--> statement-breakpoint
CREATE TABLE `forge_decision_blocker_resolutions_new` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `blocker_output_artifact_id` text NOT NULL,
  `blocker_output_sha256` text,
  `answer_artifact_id` text NOT NULL,
  `answer_sha256` text,
  `actor_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`blocker_output_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`answer_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`actor_user_id`) REFERENCES `forge_users`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `forge_decision_blocker_resolution_unique` UNIQUE(`workflow_id`, `blocker_output_artifact_id`)
);
--> statement-breakpoint
INSERT INTO `forge_decision_blocker_resolutions_new`
SELECT * FROM `forge_decision_blocker_resolutions`;
--> statement-breakpoint
DROP TABLE `forge_decision_blocker_resolutions`;
--> statement-breakpoint
ALTER TABLE `forge_decision_blocker_resolutions_new` RENAME TO `forge_decision_blocker_resolutions`;
--> statement-breakpoint
CREATE INDEX `forge_decision_blocker_resolutions_task_idx`
ON `forge_decision_blocker_resolutions` (`task_id`, `created_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;

ALTER TABLE `suplex_agent_executions` ADD COLUMN `turn_key` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `workflow_revision` integer;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `purpose` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `resolved_model` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `resolved_reasoning_level` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `resolved_service_priority` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `wrapper_pid` integer;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `wrapper_process_group` integer;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `wrapper_start_identity` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `spool_relative_path` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `status_relative_path` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `event_offset` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `cancellation_requested_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `cancelled_at` text;
--> statement-breakpoint
DROP INDEX IF EXISTS `suplex_agent_active_lease_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_agent_active_lease_idx` ON `suplex_agent_executions` (`task_id`, `role`) WHERE `status` IN ('starting', 'running', 'cancelling');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_agent_turn_key_unique` ON `suplex_agent_executions` (`turn_key`) WHERE `turn_key` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_decision_blocker_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`blocker_output_artifact_id` text NOT NULL,
	`blocker_output_sha256` text NOT NULL,
	`answer_artifact_id` text NOT NULL,
	`answer_sha256` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocker_output_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answer_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `suplex_decision_blocker_resolution_unique` UNIQUE(`workflow_id`, `blocker_output_artifact_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_decision_blocker_resolutions_task_idx` ON `suplex_decision_blocker_resolutions` (`task_id`, `created_at`);

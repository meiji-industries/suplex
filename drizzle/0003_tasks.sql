CREATE TABLE IF NOT EXISTS `forge_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_artifacts_storage_path_unique` UNIQUE(`storage_path`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`brief_artifact_id` text NOT NULL,
	`image_artifact_ids_json` text NOT NULL,
	`role_profiles_json` text NOT NULL,
	`supplemental_review` integer NOT NULL DEFAULT 0,
	`workflow_id` text NOT NULL,
	`project_revision_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `forge_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brief_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `forge_tasks_workflow_unique` UNIQUE(`workflow_id`),
	CONSTRAINT `forge_tasks_company_idempotency_unique` UNIQUE(`company_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_issue_projections` (
	`task_id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`revision` integer NOT NULL,
	`phase` text NOT NULL,
	`owner` text NOT NULL,
	`allowed_commands_json` text NOT NULL,
	`pending_action` text,
	`updated_at` text NOT NULL,
	`last_event_id` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_issue_projections_workflow_unique` UNIQUE(`workflow_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_issue_timeline` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`revision` integer NOT NULL,
	`event_type` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_issue_timeline_event_unique` UNIQUE(`workflow_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_artifacts_company_idx` ON `forge_artifacts` (`company_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_tasks_company_idx` ON `forge_tasks` (`company_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_issue_timeline_task_idx` ON `forge_issue_timeline` (`task_id`, `revision`);

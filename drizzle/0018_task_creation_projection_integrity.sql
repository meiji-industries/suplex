ALTER TABLE `forge_tasks` ADD COLUMN `request_hash` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_task_creation_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`project_revision_id` text NOT NULL,
	`artifact_ids_json` text NOT NULL DEFAULT '[]',
	`state` text NOT NULL,
	`attempt` integer NOT NULL DEFAULT 0,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `forge_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_task_creation_intents_state_check` CHECK (`state` IN ('staging', 'workflow_starting', 'started', 'failed_before_start')),
	CONSTRAINT `forge_task_creation_intents_company_key_unique` UNIQUE(`company_id`, `idempotency_key`),
	CONSTRAINT `forge_task_creation_intents_task_unique` UNIQUE(`task_id`),
	CONSTRAINT `forge_task_creation_intents_workflow_unique` UNIQUE(`workflow_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_task_creation_intents_state_idx` ON `forge_task_creation_intents` (`state`, `updated_at`);
--> statement-breakpoint
ALTER TABLE `forge_issue_timeline` ADD COLUMN `event_hash` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `forge_issue_projections` ADD COLUMN `event_hash` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `forge_issue_projections` ADD COLUMN `authoritative_revision` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `forge_issue_projections` ADD COLUMN `projected_at` text NOT NULL DEFAULT '';
--> statement-breakpoint
INSERT OR IGNORE INTO `forge_task_creation_intents`
	(`id`, `company_id`, `project_id`, `task_id`, `workflow_id`, `idempotency_key`, `request_hash`, `project_revision_id`, `artifact_ids_json`, `state`, `attempt`, `created_at`, `updated_at`)
SELECT
	'creation_' || `id`, `company_id`, `project_id`, `id`, `workflow_id`, `idempotency_key`, 'legacy-unknown', `project_revision_id`,
	'[]', 'started', 0, `created_at`, `updated_at`
FROM `forge_tasks`;
--> statement-breakpoint
UPDATE `forge_issue_projections`
SET `authoritative_revision` = `revision`, `projected_at` = `updated_at`
WHERE `projected_at` = '';

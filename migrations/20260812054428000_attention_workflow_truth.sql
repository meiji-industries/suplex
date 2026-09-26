ALTER TABLE `suplex_issue_projections` ADD COLUMN `blocker_json` text;
--> statement-breakpoint
ALTER TABLE `suplex_issue_projections` ADD COLUMN `state_changed_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_issue_projections` ADD COLUMN `projection_status` text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE `suplex_issue_projections` ADD COLUMN `reconciled_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_attention_items` ADD COLUMN `source_revision` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `suplex_attention_items` ADD COLUMN `activated_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_attention_items` ADD COLUMN `actions_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `suplex_attention_items` ADD COLUMN `evidence_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_attention_items` ADD COLUMN `evidence_sha256` text;
--> statement-breakpoint
CREATE TABLE `suplex_attention_items_repaired` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`task_id` text NOT NULL,
	`category` text NOT NULL,
	`summary` text NOT NULL,
	`action` text NOT NULL,
	`evidence_ref` text,
	`active` integer NOT NULL DEFAULT 1,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`source_revision` integer NOT NULL DEFAULT 0,
	`activated_at` text,
	`actions_json` text NOT NULL DEFAULT '[]',
	`evidence_artifact_id` text,
	`evidence_sha256` text,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `suplex_attention_items_repaired` (`id`, `company_id`, `task_id`, `category`, `summary`, `action`, `evidence_ref`, `active`, `created_at`, `updated_at`, `source_revision`, `activated_at`, `actions_json`, `evidence_artifact_id`, `evidence_sha256`)
SELECT `id`, `company_id`, `task_id`, `category`, `summary`, `action`, `evidence_ref`, `active`, `created_at`, `updated_at`, `source_revision`, `activated_at`, `actions_json`, `evidence_artifact_id`, `evidence_sha256`
FROM `suplex_attention_items`;
--> statement-breakpoint
DROP TABLE `suplex_attention_items`;
--> statement-breakpoint
ALTER TABLE `suplex_attention_items_repaired` RENAME TO `suplex_attention_items`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_attention_active_unique` ON `suplex_attention_items` (`company_id`, `task_id`, `category`) WHERE `active` = 1;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_attention_company_idx` ON `suplex_attention_items` (`company_id`, `active`, `updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_projection_invalidations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`task_id` text NOT NULL,
	`revision` integer NOT NULL,
	`attention_changed` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_projection_invalidations_scope_idx` ON `suplex_projection_invalidations` (`company_id`, `created_at`, `id`);

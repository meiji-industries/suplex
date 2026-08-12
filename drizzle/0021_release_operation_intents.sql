ALTER TABLE `forge_provider_operations` ADD COLUMN `workflow_id` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `project_revision_id` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `release_key` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `repository` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `head_branch` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `base_branch` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `base_sha` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `head_sha` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `head_tree` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `attempt` integer;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `started_at` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `observed_at` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `completed_at` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `failure_code` text;
--> statement-breakpoint
ALTER TABLE `forge_provider_operations` ADD COLUMN `failure_summary` text;
--> statement-breakpoint
ALTER TABLE `forge_releases` ADD COLUMN `reused` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_provider_operations_release_idx` ON `forge_provider_operations` (`release_key`, `kind`, `updated_at`);

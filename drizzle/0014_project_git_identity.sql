ALTER TABLE `forge_project_revisions` ADD COLUMN `base_sha` text;
--> statement-breakpoint
ALTER TABLE `forge_project_revisions` ADD COLUMN `target_sha` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_projects_repository_identity_unique` ON `forge_projects` (`repository_identity`) WHERE `repository_identity` IS NOT NULL;

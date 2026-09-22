ALTER TABLE `suplex_project_revisions` ADD COLUMN `base_sha` text;
--> statement-breakpoint
ALTER TABLE `suplex_project_revisions` ADD COLUMN `target_sha` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_projects_repository_identity_unique` ON `suplex_projects` (`repository_identity`) WHERE `repository_identity` IS NOT NULL;

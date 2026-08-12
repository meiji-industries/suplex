ALTER TABLE `forge_companies` ADD COLUMN `status` text NOT NULL DEFAULT 'active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`service_priority` text NOT NULL,
	`capacity` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `forge_profiles_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`repository_path` text NOT NULL,
	`worktree_root` text NOT NULL,
	`repository_identity` text,
	`base_branch` text NOT NULL,
	`target_branch` text NOT NULL,
	`setup_command` text NOT NULL,
	`verification_command` text NOT NULL,
	`required_checks_json` text NOT NULL,
	`allowed_profiles_json` text NOT NULL,
	`role_defaults_json` text NOT NULL,
	`status` text NOT NULL,
	`active_revision_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_projects_company_name_unique` UNIQUE(`company_id`, `name`),
	CONSTRAINT `forge_projects_repository_path_unique` UNIQUE(`repository_path`),
	CONSTRAINT `forge_projects_worktree_root_unique` UNIQUE(`worktree_root`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_project_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`identity` text NOT NULL,
	`normalized_json` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `forge_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `forge_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `forge_project_revisions_project_revision_unique` UNIQUE(`project_id`, `revision`),
	CONSTRAINT `forge_project_revisions_project_identity_unique` UNIQUE(`project_id`, `identity`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_projects_company_idx` ON `forge_projects` (`company_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_project_revisions_project_idx` ON `forge_project_revisions` (`project_id`, `revision`);

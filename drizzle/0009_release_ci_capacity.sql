ALTER TABLE `forge_tasks` ADD COLUMN `predecessor_task_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_tasks_predecessor_idx` ON `forge_tasks` (`predecessor_task_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`release_key` text NOT NULL,
	`repository` text NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`head_tree` text NOT NULL,
	`status` text NOT NULL,
	`pr_number` integer,
	`pr_url` text,
	`title` text NOT NULL,
	`body_artifact_id` text,
	`evidence_artifact_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`body_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `forge_releases_key_unique` UNIQUE(`release_key`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_ci_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`release_id` text NOT NULL,
	`expected_head_sha` text NOT NULL,
	`status` text NOT NULL,
	`next_poll_at` text,
	`attempt` integer NOT NULL,
	`summary` text NOT NULL,
	`evidence_artifact_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `forge_releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_ci_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`conclusion` text,
	`details_url` text,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `forge_ci_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_ci_checks_run_name_unique` UNIQUE(`run_id`, `name`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`release_id` text NOT NULL,
	`review_id` text NOT NULL,
	`ci_run_id` text NOT NULL,
	`repository` text NOT NULL,
	`base_branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`head_tree` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`decision` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `forge_releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `forge_delivery_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ci_run_id`) REFERENCES `forge_ci_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `forge_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_capacity_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`task_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`turn_kind` text NOT NULL,
	`status` text NOT NULL,
	`requested_at` text NOT NULL,
	`acquired_at` text,
	`released_at` text,
	`release_reason` text,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_capacity_active_turn_unique` UNIQUE(`task_id`, `turn_kind`, `status`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_capacity_fifo_idx` ON `forge_capacity_requests` (`status`, `requested_at`, `id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_attention_items` (
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
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_attention_active_unique` UNIQUE(`company_id`, `task_id`, `category`, `active`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_attention_company_idx` ON `forge_attention_items` (`company_id`, `active`, `updated_at`);

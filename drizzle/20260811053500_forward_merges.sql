CREATE TABLE IF NOT EXISTS `forge_forward_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`expected_base_sha` text NOT NULL,
	`current_base_sha` text NOT NULL,
	`prior_head` text NOT NULL,
	`merge_commit` text,
	`tree` text,
	`status` text NOT NULL,
	`conflict_files_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_forward_merges_task_idx` ON `forge_forward_merges` (`task_id`, `created_at`);

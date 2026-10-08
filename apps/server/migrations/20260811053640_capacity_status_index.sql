CREATE TABLE `suplex_capacity_requests_repaired` (
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
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `suplex_capacity_requests_repaired` (`id`, `company_id`, `task_id`, `workflow_id`, `turn_kind`, `status`, `requested_at`, `acquired_at`, `released_at`, `release_reason`)
SELECT `id`, `company_id`, `task_id`, `workflow_id`, `turn_kind`, `status`, `requested_at`, `acquired_at`, `released_at`, `release_reason`
FROM `suplex_capacity_requests`;
--> statement-breakpoint
DROP TABLE `suplex_capacity_requests`;
--> statement-breakpoint
ALTER TABLE `suplex_capacity_requests_repaired` RENAME TO `suplex_capacity_requests`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_capacity_active_turn_unique` ON `suplex_capacity_requests` (`task_id`, `turn_kind`) WHERE `status` IN ('queued', 'active');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_capacity_fifo_idx` ON `suplex_capacity_requests` (`status`, `requested_at`, `id`);

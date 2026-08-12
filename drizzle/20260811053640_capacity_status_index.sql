CREATE TABLE `forge_capacity_requests_repaired` (
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
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `forge_capacity_requests_repaired` (`id`, `company_id`, `task_id`, `workflow_id`, `turn_kind`, `status`, `requested_at`, `acquired_at`, `released_at`, `release_reason`)
SELECT `id`, `company_id`, `task_id`, `workflow_id`, `turn_kind`, `status`, `requested_at`, `acquired_at`, `released_at`, `release_reason`
FROM `forge_capacity_requests`;
--> statement-breakpoint
DROP TABLE `forge_capacity_requests`;
--> statement-breakpoint
ALTER TABLE `forge_capacity_requests_repaired` RENAME TO `forge_capacity_requests`;
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_capacity_active_turn_unique` ON `forge_capacity_requests` (`task_id`, `turn_kind`) WHERE `status` IN ('queued', 'active');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_capacity_fifo_idx` ON `forge_capacity_requests` (`status`, `requested_at`, `id`);

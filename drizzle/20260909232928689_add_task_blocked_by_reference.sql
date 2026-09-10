ALTER TABLE `forge_tasks` ADD COLUMN `blocked_by_task_id` text REFERENCES `forge_tasks`(`id`);

--> statement-breakpoint

CREATE INDEX `forge_tasks_blocked_by_task_id_idx` ON `forge_tasks` (`blocked_by_task_id`);

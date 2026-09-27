ALTER TABLE `suplex_tasks` ADD COLUMN `blocked_by_task_id` text REFERENCES `suplex_tasks`(`id`);

--> statement-breakpoint

CREATE INDEX `suplex_tasks_blocked_by_task_id_idx` ON `suplex_tasks` (`blocked_by_task_id`);

CREATE TABLE IF NOT EXISTS `forge_planner_notes` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `revision` integer NOT NULL,
  `actor` text NOT NULL,
  `note` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON DELETE cascade,
  FOREIGN KEY (`actor`) REFERENCES `forge_users`(`id`) ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_planner_notes_task_idx` ON `forge_planner_notes` (`task_id`, `revision`, `created_at`);

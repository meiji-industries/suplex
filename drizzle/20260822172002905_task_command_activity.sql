CREATE TABLE IF NOT EXISTS `forge_task_command_activity` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `step_id` text NOT NULL,
  `command` text NOT NULL,
  `cwd` text,
  `exit_code` integer,
  `duration_ms` integer NOT NULL,
  `stdout` text NOT NULL,
  `stderr` text NOT NULL,
  `entries_json` text NOT NULL,
  `started_at` text NOT NULL,
  `finished_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_task_command_activity_task_step_idx`
  ON `forge_task_command_activity` (`task_id`, `step_id`, `finished_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_task_command_activity_task_recent_idx`
  ON `forge_task_command_activity` (`task_id`, `finished_at` DESC);

ALTER TABLE `forge_developer_executions` ADD COLUMN `wrapper_id` text;
--> statement-breakpoint
ALTER TABLE `forge_developer_executions` ADD COLUMN `wrapper_path` text;
--> statement-breakpoint
ALTER TABLE `forge_developer_executions` ADD COLUMN `process_group_id` integer;
--> statement-breakpoint
ALTER TABLE `forge_developer_executions` ADD COLUMN `supersedes_execution_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_developer_executions_active_process_idx` ON `forge_developer_executions` (`process_group_id`, `process_start_identity`);

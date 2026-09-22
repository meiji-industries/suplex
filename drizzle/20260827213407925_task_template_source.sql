-- Write migration SQL here.
ALTER TABLE `suplex_task_templates` ADD COLUMN `source_json` text;

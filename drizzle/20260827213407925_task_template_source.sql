-- Write migration SQL here.
ALTER TABLE `forge_task_templates` ADD COLUMN `source_json` text;

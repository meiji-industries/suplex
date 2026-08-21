-- Archived agents stay referenced by existing tasks and projects; they are only
-- hidden from pickers and the default admin list.
ALTER TABLE `forge_agents` ADD COLUMN `archived_at` text;

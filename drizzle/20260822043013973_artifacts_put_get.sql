-- Write migration SQL here.
CREATE INDEX IF NOT EXISTS `forge_artifacts_task_idx` ON `forge_artifacts` (`task_id`, `kind`, `created_at`);

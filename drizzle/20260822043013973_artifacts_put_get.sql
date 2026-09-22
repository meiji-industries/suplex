-- Write migration SQL here.
CREATE INDEX IF NOT EXISTS `suplex_artifacts_task_idx` ON `suplex_artifacts` (`task_id`, `kind`, `created_at`);

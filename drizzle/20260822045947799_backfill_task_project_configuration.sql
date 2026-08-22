-- Tracks records that still need their legacy accepted revision materialized
-- as a task-owned configuration artifact by the deploy-time backfill worker.
CREATE TABLE IF NOT EXISTS `forge_task_configuration_backfill` (
  `task_id` text PRIMARY KEY NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `forge_task_configuration_backfill` (`task_id`, `created_at`)
SELECT `id`, `created_at`
FROM `forge_tasks`
WHERE `project_configuration_artifact_id` IS NULL
  AND `project_revision_id` IS NOT NULL;

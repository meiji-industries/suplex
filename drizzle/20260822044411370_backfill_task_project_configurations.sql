-- Artifact files are written by the deploy-time backfill worker; this index
-- makes its verified task scan resumable without consulting mutable projects.
CREATE INDEX IF NOT EXISTS `forge_tasks_project_configuration_artifact_idx`
  ON `forge_tasks` (`project_configuration_artifact_id`);

-- A task configuration is the sole runtime configuration authority.  The
-- deploy-time worker has already materialised files for ordinary upgrades;
-- retain the marker for any interrupted deployment so it is visible instead
-- of silently falling back to a mutable project row.
DELETE FROM `suplex_task_configuration_backfill`
WHERE `task_id` IN (
  SELECT `id` FROM `suplex_tasks`
  WHERE `project_configuration_artifact_id` IS NOT NULL
);
--> statement-breakpoint
-- Issue outputs were a second, denormalised execution ledger.  Preserve each
-- output on the execution that produced it before dropping that ledger.
ALTER TABLE `suplex_agent_executions` ADD COLUMN `output_kind` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `output_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `output_revision` integer;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `output_summary` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `original_plan_revision` integer;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `final_version` integer;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `evidence_manifest_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `materiality_evidence_artifact_id` text;
--> statement-breakpoint
UPDATE `suplex_agent_executions`
SET `output_kind` = (SELECT `kind` FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`),
    `output_artifact_id` = (SELECT `output_artifact_id` FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`),
    `output_revision` = (SELECT `revision` FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`),
    `output_summary` = (SELECT `summary` FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`),
    `original_plan_revision` = (SELECT `original_plan_revision` FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`),
    `final_version` = (SELECT `final_version` FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`),
    `evidence_manifest_artifact_id` = (SELECT `evidence_manifest_artifact_id` FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`),
    `materiality_evidence_artifact_id` = (SELECT `materiality_evidence_artifact_id` FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`)
WHERE EXISTS (SELECT 1 FROM `suplex_issue_outputs` o WHERE o.`execution_id` = `suplex_agent_executions`.`id`);
--> statement-breakpoint
CREATE INDEX `suplex_agent_executions_task_output_idx` ON `suplex_agent_executions` (`task_id`, `output_revision`) WHERE `output_artifact_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `suplex_issue_outputs`;
--> statement-breakpoint
ALTER TABLE `suplex_projects` DROP COLUMN `active_revision_id`;
--> statement-breakpoint
DROP TABLE `suplex_project_revisions`;

-- A task configuration is the sole runtime configuration authority.  The
-- deploy-time worker has already materialised files for ordinary upgrades;
-- retain the marker for any interrupted deployment so it is visible instead
-- of silently falling back to a mutable project row.
DELETE FROM `forge_task_configuration_backfill`
WHERE `task_id` IN (
  SELECT `id` FROM `forge_tasks`
  WHERE `project_configuration_artifact_id` IS NOT NULL
);
--> statement-breakpoint
-- Issue outputs were a second, denormalised execution ledger.  Preserve each
-- output on the execution that produced it before dropping that ledger.
ALTER TABLE `forge_agent_executions` ADD COLUMN `output_kind` text;
--> statement-breakpoint
ALTER TABLE `forge_agent_executions` ADD COLUMN `output_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `forge_agent_executions` ADD COLUMN `output_revision` integer;
--> statement-breakpoint
ALTER TABLE `forge_agent_executions` ADD COLUMN `output_summary` text;
--> statement-breakpoint
ALTER TABLE `forge_agent_executions` ADD COLUMN `original_plan_revision` integer;
--> statement-breakpoint
ALTER TABLE `forge_agent_executions` ADD COLUMN `final_version` integer;
--> statement-breakpoint
ALTER TABLE `forge_agent_executions` ADD COLUMN `evidence_manifest_artifact_id` text;
--> statement-breakpoint
ALTER TABLE `forge_agent_executions` ADD COLUMN `materiality_evidence_artifact_id` text;
--> statement-breakpoint
UPDATE `forge_agent_executions`
SET `output_kind` = (SELECT `kind` FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`),
    `output_artifact_id` = (SELECT `output_artifact_id` FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`),
    `output_revision` = (SELECT `revision` FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`),
    `output_summary` = (SELECT `summary` FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`),
    `original_plan_revision` = (SELECT `original_plan_revision` FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`),
    `final_version` = (SELECT `final_version` FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`),
    `evidence_manifest_artifact_id` = (SELECT `evidence_manifest_artifact_id` FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`),
    `materiality_evidence_artifact_id` = (SELECT `materiality_evidence_artifact_id` FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`)
WHERE EXISTS (SELECT 1 FROM `forge_issue_outputs` o WHERE o.`execution_id` = `forge_agent_executions`.`id`);
--> statement-breakpoint
CREATE INDEX `forge_agent_executions_task_output_idx` ON `forge_agent_executions` (`task_id`, `output_revision`) WHERE `output_artifact_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `forge_issue_outputs`;
--> statement-breakpoint
ALTER TABLE `forge_projects` DROP COLUMN `active_revision_id`;
--> statement-breakpoint
DROP TABLE `forge_project_revisions`;

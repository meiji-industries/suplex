-- Migration 0020: durable task projection provenance.
ALTER TABLE `forge_task_creation_intents` ADD COLUMN `artifact_manifest_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `forge_task_creation_intents` ADD COLUMN `lease_token` text;
--> statement-breakpoint
ALTER TABLE `forge_task_creation_intents` ADD COLUMN `lease_expires_at` text;
--> statement-breakpoint
ALTER TABLE `forge_issue_timeline` ADD COLUMN `run_id` text NOT NULL DEFAULT 'legacy-unknown';
--> statement-breakpoint
ALTER TABLE `forge_workflow_snapshots` ADD COLUMN `run_id` text NOT NULL DEFAULT 'legacy-unknown';
--> statement-breakpoint
ALTER TABLE `forge_issue_projections` ADD COLUMN `last_run_id` text NOT NULL DEFAULT 'legacy-unknown';
--> statement-breakpoint
ALTER TABLE `forge_issue_projections` ADD COLUMN `authoritative_event_hash` text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_projection_integrity_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`task_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`revision` integer,
	`event_id` text,
	`code` text NOT NULL,
	`summary` text NOT NULL,
	`detected_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_projection_integrity_findings_scope_idx` ON `forge_projection_integrity_findings` (`company_id`, `resolved_at`, `detected_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_projection_integrity_findings_task_revision_idx` ON `forge_projection_integrity_findings` (`task_id`, `revision`);
--> statement-breakpoint
UPDATE `forge_task_creation_intents`
SET `artifact_manifest_json` = (
	SELECT COALESCE(json_group_array(json_object(
		'id', a.id,
		'kind', a.kind,
		'filename', a.filename,
		'mimeType', a.mime_type,
		'byteSize', a.byte_size,
		'sha256', a.sha256,
		'storagePath', a.storage_path
	)), '[]')
	FROM `forge_artifacts` a
	WHERE a.id IN (
		SELECT value FROM json_each(`forge_task_creation_intents`.`artifact_ids_json`)
		UNION ALL
		SELECT t.brief_artifact_id FROM `forge_tasks` t WHERE t.id = `forge_task_creation_intents`.task_id
		UNION ALL
		SELECT value FROM json_each((SELECT t.image_artifact_ids_json FROM `forge_tasks` t WHERE t.id = `forge_task_creation_intents`.task_id))
	)
)
WHERE `state` = 'started' OR `artifact_ids_json` <> '[]';
--> statement-breakpoint
UPDATE `forge_task_creation_intents`
SET `error_code` = COALESCE(`error_code`, 'legacy-artifact-manifest-unknown')
WHERE `state` <> 'started' AND `artifact_manifest_json` = '[]';
--> statement-breakpoint
UPDATE `forge_issue_projections`
SET `authoritative_event_hash` = `event_hash`
WHERE `authoritative_event_hash` = '';

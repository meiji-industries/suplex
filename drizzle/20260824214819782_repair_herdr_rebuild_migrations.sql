CREATE INDEX IF NOT EXISTS `forge_issue_timeline_task_idx`
  ON `forge_issue_timeline` (`task_id`, `revision`);
--> statement-breakpoint
CREATE TABLE `forge_developer_result_conflicts_repaired` (
  `id` text PRIMARY KEY NOT NULL,
  `execution_id` text NOT NULL,
  `existing_result_hash` text,
  `conflicting_result_hash` text,
  `existing_delivery_artifact_id` text NOT NULL,
  `existing_evidence_artifact_id` text NOT NULL,
  `conflicting_delivery_artifact_id` text NOT NULL,
  `conflicting_evidence_artifact_id` text NOT NULL,
  `recorded_at` text NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `forge_developer_executions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`existing_delivery_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`existing_evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`conflicting_delivery_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`conflicting_evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  UNIQUE (`execution_id`, `conflicting_result_hash`)
);
--> statement-breakpoint
INSERT INTO `forge_developer_result_conflicts_repaired` (`id`, `execution_id`, `existing_result_hash`, `conflicting_result_hash`, `existing_delivery_artifact_id`, `existing_evidence_artifact_id`, `conflicting_delivery_artifact_id`, `conflicting_evidence_artifact_id`, `recorded_at`)
SELECT `id`, `execution_id`, `existing_result_hash`, `conflicting_result_hash`, `existing_delivery_artifact_id`, `existing_evidence_artifact_id`, `conflicting_delivery_artifact_id`, `conflicting_evidence_artifact_id`, `recorded_at`
FROM `forge_developer_result_conflicts`;
--> statement-breakpoint
DROP TABLE `forge_developer_result_conflicts`;
--> statement-breakpoint
ALTER TABLE `forge_developer_result_conflicts_repaired` RENAME TO `forge_developer_result_conflicts`;

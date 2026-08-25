PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `forge_developer_result_claims_new` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `claim_key` text NOT NULL UNIQUE,
  `result_hash` text,
  `activity_result_json` text NOT NULL,
  `delivery_artifact_id` text NOT NULL,
  `evidence_artifact_id` text NOT NULL,
  `claimed_at` text NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `forge_developer_executions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`delivery_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `forge_developer_result_claims_new`
SELECT * FROM `forge_developer_result_claims`;
--> statement-breakpoint
DROP TABLE `forge_developer_result_claims`;
--> statement-breakpoint
ALTER TABLE `forge_developer_result_claims_new` RENAME TO `forge_developer_result_claims`;
--> statement-breakpoint
CREATE TABLE `forge_developer_result_conflicts_new` (
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
  UNIQUE (`execution_id`, `conflicting_result_hash`)
);
--> statement-breakpoint
INSERT INTO `forge_developer_result_conflicts_new`
SELECT * FROM `forge_developer_result_conflicts`;
--> statement-breakpoint
DROP TABLE `forge_developer_result_conflicts`;
--> statement-breakpoint
ALTER TABLE `forge_developer_result_conflicts_new` RENAME TO `forge_developer_result_conflicts`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;

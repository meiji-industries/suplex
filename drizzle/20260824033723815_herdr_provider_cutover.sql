-- The bookkeeping migration before this cutover has already retired the old
-- lease and claim tables. Reintroduce the exactly-once boundary directly on
-- the durable execution ledger; no non-terminal execution is stranded.
CREATE TABLE `forge_developer_result_claims` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `claim_key` text NOT NULL UNIQUE,
  `result_hash` text NOT NULL,
  `activity_result_json` text NOT NULL,
  `delivery_artifact_id` text NOT NULL,
  `evidence_artifact_id` text NOT NULL,
  `claimed_at` text NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `forge_developer_executions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`delivery_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `forge_developer_result_conflicts` (
  `id` text PRIMARY KEY NOT NULL,
  `execution_id` text NOT NULL,
  `existing_result_hash` text NOT NULL,
  `conflicting_result_hash` text NOT NULL,
  `existing_delivery_artifact_id` text NOT NULL,
  `existing_evidence_artifact_id` text NOT NULL,
  `conflicting_delivery_artifact_id` text NOT NULL,
  `conflicting_evidence_artifact_id` text NOT NULL,
  `recorded_at` text NOT NULL,
  UNIQUE (`execution_id`, `conflicting_result_hash`),
  FOREIGN KEY (`execution_id`) REFERENCES `forge_developer_executions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`existing_delivery_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`existing_evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`conflicting_delivery_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`conflicting_evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

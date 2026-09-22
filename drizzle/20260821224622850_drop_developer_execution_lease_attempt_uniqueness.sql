CREATE TABLE `suplex_developer_execution_leases_reissued` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL,
  `task_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `attempt` integer NOT NULL CHECK (`attempt` > 0),
  `turn_kind` text NOT NULL CHECK (`turn_kind` IN ('implementation', 'repair', 'merge_conflict_resolution')),
  `lease_token_hash` text NOT NULL UNIQUE,
  `execution_root` text NOT NULL UNIQUE,
  `canonical_worktree_path` text NOT NULL,
  `worktree_identity_hash` text NOT NULL,
  `protocol_version` integer NOT NULL DEFAULT 1,
  `status` text NOT NULL CHECK (`status` IN ('reserved', 'supervisor_starting', 'running', 'result_ready', 'cancel_requested', 'cancelling', 'terminated', 'interrupted', 'ownership_ambiguous', 'failed')),
  `supervisor_pid` integer,
  `supervisor_process_group` integer,
  `supervisor_start_time` text,
  `supervisor_executable` text,
  `supervisor_argv_json` text,
  `supervisor_owner_uid` integer,
  `child_pid` integer,
  `child_process_group` integer,
  `child_start_time` text,
  `child_executable` text,
  `child_argv_json` text,
  `child_owner_uid` integer,
  `control_socket_path` text NOT NULL DEFAULT 'control.sock',
  `output_path` text NOT NULL DEFAULT 'events.jsonl',
  `result_path` text NOT NULL DEFAULT 'result.json',
  `heartbeat_at` text,
  `result_hash` text,
  `failure_code` text,
  `failure_summary` text,
  `exit_code` integer,
  `exit_signal` text,
  `output_truncated` integer NOT NULL DEFAULT 0,
  `cancellation_requested_at` text,
  `term_sent_at` text,
  `kill_sent_at` text,
  `confirmed_exit_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `suplex_developer_executions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `suplex_developer_execution_leases_reissued` SELECT * FROM `suplex_developer_execution_leases`;
--> statement-breakpoint
CREATE TABLE `suplex_developer_result_claims_reissued` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `claim_key` text NOT NULL UNIQUE,
  `result_hash` text NOT NULL,
  `activity_result_json` text NOT NULL,
  `delivery_artifact_id` text NOT NULL,
  `evidence_artifact_id` text NOT NULL,
  `claimed_at` text NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `suplex_developer_execution_leases_reissued`(`execution_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`delivery_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `suplex_developer_result_claims_reissued` SELECT * FROM `suplex_developer_result_claims`;
--> statement-breakpoint
CREATE TABLE `suplex_developer_result_conflicts_reissued` (
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
  FOREIGN KEY (`execution_id`) REFERENCES `suplex_developer_execution_leases_reissued`(`execution_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`existing_delivery_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`existing_evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`conflicting_delivery_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`conflicting_evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `suplex_developer_result_conflicts_reissued` SELECT * FROM `suplex_developer_result_conflicts`;
--> statement-breakpoint
DROP TABLE `suplex_developer_result_conflicts`;
--> statement-breakpoint
DROP TABLE `suplex_developer_result_claims`;
--> statement-breakpoint
DROP TABLE `suplex_developer_execution_leases`;
--> statement-breakpoint
ALTER TABLE `suplex_developer_execution_leases_reissued` RENAME TO `suplex_developer_execution_leases`;
--> statement-breakpoint
ALTER TABLE `suplex_developer_result_claims_reissued` RENAME TO `suplex_developer_result_claims`;
--> statement-breakpoint
ALTER TABLE `suplex_developer_result_conflicts_reissued` RENAME TO `suplex_developer_result_conflicts`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_developer_active_worktree_lease_idx`
  ON `suplex_developer_execution_leases` (`worktree_identity_hash`)
  WHERE `status` IN ('reserved', 'supervisor_starting', 'running', 'result_ready', 'cancel_requested', 'cancelling');
--> statement-breakpoint
CREATE INDEX `suplex_developer_execution_lease_status_heartbeat_idx`
  ON `suplex_developer_execution_leases` (`status`, `heartbeat_at`);
--> statement-breakpoint
CREATE TRIGGER `suplex_developer_execution_lease_supervisor_identity_immutable`
BEFORE UPDATE ON `suplex_developer_execution_leases`
WHEN (`OLD`.`supervisor_pid` IS NOT NULL AND `NEW`.`supervisor_pid` IS NOT `OLD`.`supervisor_pid`)
  OR (`OLD`.`supervisor_process_group` IS NOT NULL AND `NEW`.`supervisor_process_group` IS NOT `OLD`.`supervisor_process_group`)
  OR (`OLD`.`supervisor_start_time` IS NOT NULL AND `NEW`.`supervisor_start_time` IS NOT `OLD`.`supervisor_start_time`)
  OR (`OLD`.`supervisor_executable` IS NOT NULL AND `NEW`.`supervisor_executable` IS NOT `OLD`.`supervisor_executable`)
  OR (`OLD`.`supervisor_argv_json` IS NOT NULL AND `NEW`.`supervisor_argv_json` IS NOT `OLD`.`supervisor_argv_json`)
  OR (`OLD`.`supervisor_owner_uid` IS NOT NULL AND `NEW`.`supervisor_owner_uid` IS NOT `OLD`.`supervisor_owner_uid`)
BEGIN
  SELECT RAISE(ABORT, 'developer supervisor identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_developer_execution_lease_child_identity_immutable`
BEFORE UPDATE ON `suplex_developer_execution_leases`
WHEN (`OLD`.`child_pid` IS NOT NULL AND `NEW`.`child_pid` IS NOT `OLD`.`child_pid`)
  OR (`OLD`.`child_process_group` IS NOT NULL AND `NEW`.`child_process_group` IS NOT `OLD`.`child_process_group`)
  OR (`OLD`.`child_start_time` IS NOT NULL AND `NEW`.`child_start_time` IS NOT `OLD`.`child_start_time`)
  OR (`OLD`.`child_executable` IS NOT NULL AND `NEW`.`child_executable` IS NOT `OLD`.`child_executable`)
  OR (`OLD`.`child_argv_json` IS NOT NULL AND `NEW`.`child_argv_json` IS NOT `OLD`.`child_argv_json`)
  OR (`OLD`.`child_owner_uid` IS NOT NULL AND `NEW`.`child_owner_uid` IS NOT `OLD`.`child_owner_uid`)
BEGIN
  SELECT RAISE(ABORT, 'developer child identity is immutable');
END;

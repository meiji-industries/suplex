CREATE TABLE `suplex_herdr_project_workspaces` (
  `project_id` text PRIMARY KEY NOT NULL,
  `workspace_label` text NOT NULL,
  `workspace_id` text UNIQUE,
  `state` text NOT NULL CHECK (`state` IN ('creating', 'open', 'failed', 'closed')),
  `lease_token` text,
  `lease_expires_at` text,
  `failure_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `suplex_projects`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `suplex_herdr_task_tabs` (
  `task_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `tab_label` text NOT NULL,
  `tab_id` text UNIQUE,
  `shell_pane_id` text,
  `state` text NOT NULL CHECK (`state` IN ('creating', 'open', 'closing', 'closed', 'failed')),
  `lease_token` text,
  `lease_expires_at` text,
  `final_snapshot_artifact_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `closed_at` text,
  `failure_code` text,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE cascade,
  FOREIGN KEY (`project_id`) REFERENCES `suplex_projects`(`id`) ON DELETE cascade,
  FOREIGN KEY (`final_snapshot_artifact_id`) REFERENCES `suplex_artifacts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `suplex_herdr_role_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `session_role` text NOT NULL CHECK (`session_role` IN ('lead', 'developer', 'reviewer')),
  `generation` integer NOT NULL CHECK (`generation` >= 0),
  `is_current` integer NOT NULL DEFAULT 1 CHECK (`is_current` IN (0, 1)),
  `provider_kind` text NOT NULL CHECK (`provider_kind` = 'codex'),
  `codex_session_id` text UNIQUE,
  `agent_name` text,
  `pane_id` text,
  `rollout_path` text,
  `launch_fingerprint` text,
  `guard_directory` text,
  `status` text NOT NULL CHECK (`status` IN ('unbound', 'starting', 'ready', 'working', 'blocked', 'missing', 'closed', 'failed')),
  `last_agent_status` text,
  `attention_activated_at` text,
  `ensure_token` text,
  `ensure_expires_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `last_seen_at` text,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE cascade,
  UNIQUE (`task_id`, `session_role`, `generation`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_herdr_current_persistent_role_unique`
  ON `suplex_herdr_role_sessions` (`task_id`, `session_role`)
  WHERE `is_current` = 1 AND `session_role` IN ('lead', 'developer');
--> statement-breakpoint
CREATE INDEX `suplex_herdr_role_session_status_idx`
  ON `suplex_herdr_role_sessions` (`status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `suplex_herdr_turns` (
  `turn_id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `role_session_id` text NOT NULL,
  `execution_role` text NOT NULL CHECK (`execution_role` IN ('planner', 'reviewer', 'builder', 'integrator')),
  `ledger` text NOT NULL CHECK (`ledger` IN ('agent', 'developer')),
  `execution_id` text NOT NULL,
  `prompt_kind` text NOT NULL,
  `prompt_sha256` text NOT NULL,
  `result_relative_path` text NOT NULL UNIQUE,
  `rollout_path` text,
  `rollout_start_offset` integer NOT NULL DEFAULT 0 CHECK (`rollout_start_offset` >= 0),
  `rollout_cursor_offset` integer NOT NULL DEFAULT 0 CHECK (`rollout_cursor_offset` >= `rollout_start_offset`),
  `codex_turn_id` text,
  `prompt_sent_at` text,
  `task_complete_seen_at` text,
  `result_sha256` text,
  `result_artifact_id` text,
  `rollout_artifact_id` text,
  `correction_of_turn_id` text,
  `correction_index` integer NOT NULL DEFAULT 0 CHECK (`correction_index` >= 0),
  `interrupted_generation` integer,
  `interrupted_prompt_sent_at` text,
  `status` text NOT NULL CHECK (`status` IN ('created', 'dispatching', 'waiting', 'blocked', 'validating', 'correction_required', 'completed', 'interrupted', 'failed', 'cancelled')),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `finished_at` text,
  UNIQUE (`ledger`, `execution_id`, `prompt_kind`, `correction_index`),
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE cascade,
  FOREIGN KEY (`role_session_id`) REFERENCES `suplex_herdr_role_sessions`(`id`) ON DELETE cascade,
  FOREIGN KEY (`result_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`rollout_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`correction_of_turn_id`) REFERENCES `suplex_herdr_turns`(`turn_id`)
);
--> statement-breakpoint
CREATE INDEX `suplex_herdr_turn_active_idx`
  ON `suplex_herdr_turns` (`task_id`, `role_session_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `suplex_issue_timeline_herdr` (
  `stream_id` integer PRIMARY KEY AUTOINCREMENT,
  `id` text NOT NULL UNIQUE,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `run_id` text,
  `revision` integer NOT NULL,
  `source` text NOT NULL CHECK (`source` IN ('workflow', 'agent')),
  `event_type` text NOT NULL,
  `metadata_json` text NOT NULL,
  `created_at` text NOT NULL,
  `event_hash` text NOT NULL,
  `execution_id` text,
  `execution_role` text,
  `session_id` text,
  `suplex_turn_id` text,
  `source_offset` integer,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON DELETE cascade,
  CHECK (
    (`source` = 'workflow' AND `execution_id` IS NULL AND `execution_role` IS NULL AND `session_id` IS NULL AND `suplex_turn_id` IS NULL AND `source_offset` IS NULL)
    OR
    (`source` = 'agent' AND `execution_id` IS NOT NULL AND `execution_role` IN ('planner', 'reviewer', 'builder', 'integrator') AND `session_id` IS NOT NULL AND `suplex_turn_id` IS NOT NULL AND `source_offset` >= 0)
  )
);
--> statement-breakpoint
INSERT INTO `suplex_issue_timeline_herdr`
  (`id`, `task_id`, `company_id`, `workflow_id`, `run_id`, `revision`, `source`, `event_type`, `metadata_json`, `created_at`, `event_hash`)
SELECT `id`, `task_id`, `company_id`, `workflow_id`, `run_id`, `revision`, 'workflow', `event_type`, `metadata_json`, `created_at`, `event_hash`
FROM `suplex_issue_timeline`
ORDER BY `created_at`, `workflow_id`, `revision`, `id`;
--> statement-breakpoint
DROP TABLE `suplex_issue_timeline`;
--> statement-breakpoint
ALTER TABLE `suplex_issue_timeline_herdr` RENAME TO `suplex_issue_timeline`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_issue_timeline_workflow_revision_unique`
  ON `suplex_issue_timeline` (`workflow_id`, `revision`) WHERE `source` = 'workflow';
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_issue_timeline_rollout_offset_unique`
  ON `suplex_issue_timeline` (`session_id`, `source_offset`) WHERE `source` = 'agent';
--> statement-breakpoint
CREATE INDEX `suplex_issue_timeline_task_stream_idx`
  ON `suplex_issue_timeline` (`task_id`, `stream_id`);
--> statement-breakpoint
CREATE INDEX `suplex_issue_timeline_workflow_revision_idx`
  ON `suplex_issue_timeline` (`workflow_id`, `revision`) WHERE `source` = 'workflow';
--> statement-breakpoint
ALTER TABLE `suplex_planner_notes` ADD COLUMN `forward_status` text NOT NULL DEFAULT 'forwarded'
  CHECK (`forward_status` IN ('pending', 'dispatching', 'forwarded', 'blocked', 'failed'));
--> statement-breakpoint
ALTER TABLE `suplex_planner_notes` ADD COLUMN `forwarded_at` text;
--> statement-breakpoint
ALTER TABLE `suplex_planner_notes` ADD COLUMN `forward_attempt` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `suplex_planner_notes` ADD COLUMN `forward_error_code` text;

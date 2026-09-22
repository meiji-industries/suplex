CREATE TABLE `suplex_profiles_repaired` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`service_priority` text NOT NULL,
	`capacity` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `suplex_profiles_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
INSERT INTO `suplex_profiles_repaired` (`id`, `name`, `provider`, `model`, `reasoning_level`, `service_priority`, `capacity`, `created_at`, `updated_at`)
SELECT `id`, `name`, `provider`, `model`, `reasoning_level`, `service_priority`, `capacity`, `created_at`, `updated_at`
FROM `suplex_profiles`;
--> statement-breakpoint
DROP TABLE `suplex_profiles`;
--> statement-breakpoint
ALTER TABLE `suplex_profiles_repaired` RENAME TO `suplex_profiles`;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `profile_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `provider` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `model` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `reasoning_level` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `service_priority` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `capacity_request_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `wrapper_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `wrapper_path` text;
--> statement-breakpoint
ALTER TABLE `suplex_agent_executions` ADD COLUMN `process_group_id` integer;
--> statement-breakpoint
ALTER TABLE `suplex_developer_executions` ADD COLUMN `profile_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_developer_executions` ADD COLUMN `provider` text;
--> statement-breakpoint
ALTER TABLE `suplex_developer_executions` ADD COLUMN `model` text;
--> statement-breakpoint
ALTER TABLE `suplex_developer_executions` ADD COLUMN `reasoning_level` text;
--> statement-breakpoint
ALTER TABLE `suplex_developer_executions` ADD COLUMN `service_priority` text;
--> statement-breakpoint
ALTER TABLE `suplex_developer_executions` ADD COLUMN `capacity_request_id` text;
--> statement-breakpoint
CREATE TABLE `suplex_capacity_requests_repaired` (
	`id` text PRIMARY KEY NOT NULL,
	`logical_turn_key` text NOT NULL,
	`company_id` text NOT NULL,
	`task_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`project_revision_id` text NOT NULL,
	`workflow_revision` integer NOT NULL,
	`operation` text NOT NULL,
	`role` text NOT NULL,
	`profile_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`service_priority` text NOT NULL,
	`lane_key` text NOT NULL,
	`requested_capacity` integer NOT NULL,
	`status` text NOT NULL,
	`wait_reason` text,
	`skip_reason` text,
	`session_ref` text,
	`worktree_path` text,
	`execution_kind` text,
	`execution_id` text,
	`requested_at` text NOT NULL,
	`deadline_at` text NOT NULL,
	`acquired_at` text,
	`heartbeat_at` text,
	`retry_at` text,
	`cancelled_at` text,
	`released_at` text,
	`updated_at` text NOT NULL,
	`rate_limit_attempts` integer NOT NULL DEFAULT 0,
	`terminal_reason` text,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
WITH legacy AS (
  SELECT c.*, t.project_revision_id,
    CASE c.turn_kind WHEN 'lead' THEN json_extract(t.role_profiles_json, '$.lead') WHEN 'review' THEN COALESCE(json_extract(t.role_profiles_json, '$.reviewer'), json_extract(t.role_profiles_json, '$.lead')) WHEN 'developer' THEN json_extract(t.role_profiles_json, '$.developer') ELSE COALESCE(json_extract(t.role_profiles_json, '$.developer'), json_extract(t.role_profiles_json, '$.lead')) END AS selected_profile_id,
    CASE c.turn_kind WHEN 'lead' THEN 'lead_planning' WHEN 'review' THEN 'supplemental_review' WHEN 'developer' THEN 'developer_execution' ELSE 'developer_repair' END AS operation_name,
    CASE c.turn_kind WHEN 'lead' THEN 'lead' WHEN 'review' THEN 'reviewer' ELSE 'developer' END AS role_name,
    CASE WHEN c.turn_kind IN ('developer', 'ci-repair') THEN 'developer' ELSE 'agent' END AS execution_kind_name
  FROM suplex_capacity_requests c JOIN suplex_tasks t ON t.id = c.task_id
), resolved AS (
  SELECT legacy.*, p.id AS resolved_profile_id, p.provider AS resolved_provider, p.model AS resolved_model, p.reasoning_level AS resolved_reasoning, p.service_priority AS resolved_priority, COALESCE(p.capacity, 2) AS resolved_capacity
  FROM legacy LEFT JOIN suplex_profiles p ON p.id = legacy.selected_profile_id
), candidate_owners AS (
  SELECT resolved.*,
    CASE WHEN execution_kind_name = 'developer' THEN (SELECT COUNT(*) FROM suplex_developer_executions d WHERE d.task_id = resolved.task_id AND d.workflow_id = resolved.workflow_id AND d.status IN ('starting', 'running', 'cancelling')) ELSE (SELECT COUNT(*) FROM suplex_agent_executions a WHERE a.task_id = resolved.task_id AND a.workflow_id = resolved.workflow_id AND a.status IN ('starting', 'running')) END AS owner_count,
    CASE WHEN execution_kind_name = 'developer' THEN (SELECT d.id FROM suplex_developer_executions d WHERE d.task_id = resolved.task_id AND d.workflow_id = resolved.workflow_id AND d.status IN ('starting', 'running', 'cancelling') ORDER BY d.started_at, d.id LIMIT 1) ELSE (SELECT a.id FROM suplex_agent_executions a WHERE a.task_id = resolved.task_id AND a.workflow_id = resolved.workflow_id AND a.status IN ('starting', 'running') ORDER BY a.started_at, a.id LIMIT 1) END AS owner_id,
    CASE WHEN execution_kind_name = 'developer' THEN (SELECT d.session_ref FROM suplex_developer_executions d WHERE d.task_id = resolved.task_id AND d.workflow_id = resolved.workflow_id AND d.status IN ('starting', 'running', 'cancelling') ORDER BY d.started_at, d.id LIMIT 1) ELSE (SELECT a.session_ref FROM suplex_agent_executions a WHERE a.task_id = resolved.task_id AND a.workflow_id = resolved.workflow_id AND a.status IN ('starting', 'running') ORDER BY a.started_at, a.id LIMIT 1) END AS owner_session,
    CASE WHEN execution_kind_name = 'developer' THEN (SELECT d.worktree_path FROM suplex_developer_executions d WHERE d.task_id = resolved.task_id AND d.workflow_id = resolved.workflow_id AND d.status IN ('starting', 'running', 'cancelling') ORDER BY d.started_at, d.id LIMIT 1) ELSE NULL END AS owner_worktree
  FROM resolved
), owners AS (
  SELECT candidate_owners.*,
    CASE WHEN owner_count = 1 THEN owner_id ELSE NULL END AS safe_owner_id,
    CASE WHEN owner_count = 1 THEN owner_session ELSE NULL END AS safe_owner_session,
    CASE WHEN owner_count = 1 THEN owner_worktree ELSE NULL END AS safe_owner_worktree
  FROM candidate_owners
)
INSERT INTO suplex_capacity_requests_repaired (id, logical_turn_key, company_id, task_id, workflow_id, project_revision_id, workflow_revision, operation, role, profile_id, provider, model, reasoning_level, service_priority, lane_key, requested_capacity, status, wait_reason, session_ref, worktree_path, execution_kind, execution_id, requested_at, deadline_at, acquired_at, heartbeat_at, cancelled_at, released_at, updated_at, terminal_reason)
SELECT id,
  workflow_id || ':' || turn_kind || ':legacy:' || id,
  company_id, task_id, workflow_id, project_revision_id, 0, operation_name, role_name,
  COALESCE(resolved_profile_id, 'legacy-unresolved'), COALESCE(resolved_provider, 'codex'), COALESCE(resolved_model, 'legacy-unresolved'), COALESCE(resolved_reasoning, 'medium'), COALESCE(resolved_priority, 'standard'), 'codex:' || COALESCE(resolved_profile_id, 'legacy-unresolved'), resolved_capacity,
  CASE WHEN status = 'active' AND safe_owner_id IS NULL THEN 'ownership_ambiguous' WHEN status = 'queued' AND resolved_profile_id IS NULL THEN 'stale' ELSE status END,
  NULL,
  safe_owner_session, safe_owner_worktree, CASE WHEN safe_owner_id IS NULL THEN NULL ELSE execution_kind_name END, safe_owner_id,
  requested_at, strftime('%Y-%m-%dT%H:%M:%fZ', requested_at, '+2 hours'), acquired_at, NULL, CASE WHEN status = 'cancelled' THEN released_at ELSE NULL END, released_at, requested_at,
  CASE WHEN status = 'released' THEN 'completed' WHEN status = 'cancelled' THEN 'cancelled' WHEN status = 'stale' OR (status = 'queued' AND resolved_profile_id IS NULL) THEN 'failed_before_start' WHEN status = 'active' AND safe_owner_id IS NULL THEN 'ownership_ambiguous' ELSE NULL END
FROM owners;
--> statement-breakpoint
DROP TABLE `suplex_capacity_requests`;
--> statement-breakpoint
ALTER TABLE `suplex_capacity_requests_repaired` RENAME TO `suplex_capacity_requests`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_capacity_logical_open_unique` ON `suplex_capacity_requests` (`logical_turn_key`) WHERE `status` IN ('queued', 'active', 'rate_limited', 'ownership_ambiguous');
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_capacity_task_open_unique` ON `suplex_capacity_requests` (`task_id`) WHERE `status` IN ('active', 'ownership_ambiguous');
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_capacity_session_open_unique` ON `suplex_capacity_requests` (`session_ref`) WHERE `status` IN ('active', 'ownership_ambiguous') AND `session_ref` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_capacity_worktree_open_unique` ON `suplex_capacity_requests` (`worktree_path`) WHERE `status` IN ('active', 'ownership_ambiguous') AND `worktree_path` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_capacity_execution_open_unique` ON `suplex_capacity_requests` (`execution_kind`, `execution_id`) WHERE `status` IN ('active', 'ownership_ambiguous') AND `execution_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `suplex_capacity_lane_status_requested_idx` ON `suplex_capacity_requests` (`lane_key`, `status`, `requested_at`, `id`);
--> statement-breakpoint
CREATE INDEX `suplex_capacity_task_status_requested_idx` ON `suplex_capacity_requests` (`task_id`, `status`, `requested_at`);
--> statement-breakpoint
CREATE INDEX `suplex_capacity_status_retry_idx` ON `suplex_capacity_requests` (`status`, `retry_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_agent_capacity_request_active_unique` ON `suplex_agent_executions` (`capacity_request_id`) WHERE `capacity_request_id` IS NOT NULL AND `status` IN ('starting', 'running', 'cancelling');
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_developer_capacity_request_active_unique` ON `suplex_developer_executions` (`capacity_request_id`) WHERE `capacity_request_id` IS NOT NULL AND `status` IN ('starting', 'running', 'cancelling');
--> statement-breakpoint
DROP INDEX IF EXISTS `suplex_agent_active_lease_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_agent_active_lease_idx` ON `suplex_agent_executions` (`task_id`, `role`) WHERE `status` IN ('starting', 'running', 'cancelling');
--> statement-breakpoint
DROP INDEX IF EXISTS `suplex_developer_active_lease_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_developer_active_lease_idx` ON `suplex_developer_executions` (`task_id`) WHERE `status` IN ('starting', 'running', 'cancelling');

CREATE TABLE IF NOT EXISTS `forge_developer_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`branch_name` text NOT NULL,
	`worktree_path` text NOT NULL,
	`target_base_sha` text NOT NULL,
	`session_ref` text,
	`process_pid` integer,
	`process_start_identity` text,
	`current_step` integer,
	`started_at` text NOT NULL,
	`heartbeat_at` text,
	`finished_at` text,
	`result_commit` text,
	`result_tree` text,
	`dirty_state` text,
	`delivery_artifact_id` text,
	`evidence_artifact_id` text,
	`failure_code` text,
	`failure_summary` text,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delivery_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `forge_developer_executions_attempt_unique` UNIQUE(`workflow_id`, `plan_revision`, `attempt`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_developer_active_lease_idx` ON `forge_developer_executions` (`task_id`) WHERE `status` IN ('starting', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_developer_executions_task_idx` ON `forge_developer_executions` (`task_id`, `plan_revision`, `attempt`);

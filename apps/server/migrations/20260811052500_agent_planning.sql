CREATE TABLE IF NOT EXISTS `suplex_agent_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`session_ref` text,
	`process_pid` integer,
	`process_start_identity` text,
	`heartbeat_at` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`failure_code` text,
	`failure_summary` text,
	`evidence_artifact_id` text,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_agent_active_lease_idx` ON `suplex_agent_executions` (`task_id`, `role`) WHERE `status` IN ('starting', 'running');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_issue_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`output_artifact_id` text NOT NULL,
	`evidence_artifact_id` text NOT NULL,
	`session_ref` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `suplex_agent_executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`output_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `suplex_issue_outputs_revision_unique` UNIQUE(`workflow_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_agent_executions_task_idx` ON `suplex_agent_executions` (`task_id`, `started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_issue_outputs_task_idx` ON `suplex_issue_outputs` (`task_id`, `revision`);

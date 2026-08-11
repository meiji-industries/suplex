CREATE TABLE IF NOT EXISTS `probe_workflows` (
	`probe_id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`company_id` text NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT `probe_workflows_workflow_id_unique` UNIQUE(`workflow_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `worker_registrations` (
	`worker_id` text PRIMARY KEY NOT NULL,
	`task_queue` text NOT NULL,
	`build_id` text NOT NULL,
	`heartbeat_at` text NOT NULL
);

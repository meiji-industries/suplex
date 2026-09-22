CREATE TABLE IF NOT EXISTS `suplex_delivery_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`base_sha` text NOT NULL,
	`subject_commit` text NOT NULL,
	`subject_tree` text NOT NULL,
	`lead_execution_id` text NOT NULL,
	`session_ref` text NOT NULL,
	`outcome` text NOT NULL,
	`summary` text NOT NULL,
	`opinion_artifact_id` text NOT NULL,
	`evidence_artifact_id` text NOT NULL,
	`repair_cycle` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_execution_id`) REFERENCES `suplex_agent_executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opinion_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `suplex_delivery_reviews_subject_unique` UNIQUE(`workflow_id`, `subject_commit`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_delivery_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`severity` text NOT NULL,
	`rationale` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`disposition` text NOT NULL,
	`repair_instruction` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `suplex_delivery_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_delivery_findings_review_idx` ON `suplex_delivery_findings` (`review_id`, `severity`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_delivery_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_delivery_repairs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`review_id` text NOT NULL,
	`developer_execution_id` text NOT NULL,
	`cycle` integer NOT NULL,
	`status` text NOT NULL,
	`subject_commit` text NOT NULL,
	`result_commit` text,
	`evidence_artifact_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `suplex_delivery_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`developer_execution_id`) REFERENCES `suplex_developer_executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `suplex_delivery_repairs_cycle_unique` UNIQUE(`workflow_id`, `review_id`, `cycle`)
);

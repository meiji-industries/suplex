ALTER TABLE `suplex_tasks` ADD COLUMN `successor_task_id` text;
--> statement-breakpoint
ALTER TABLE `suplex_acceptances` ADD COLUMN `final_review_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_tasks_successor_idx` ON `suplex_tasks` (`successor_task_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_workflow_snapshots` (
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`task_id`, `revision`),
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_workflow_snapshots_task_idx` ON `suplex_workflow_snapshots` (`task_id`, `revision`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_final_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`release_id` text NOT NULL,
	`ci_run_id` text NOT NULL,
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
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `suplex_releases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ci_run_id`) REFERENCES `suplex_ci_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_execution_id`) REFERENCES `suplex_agent_executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opinion_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `suplex_final_reviews_subject_unique` UNIQUE(`workflow_id`, `subject_commit`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_final_review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`severity` text NOT NULL,
	`rationale` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`disposition` text NOT NULL,
	`repair_instruction` text,
	FOREIGN KEY (`review_id`) REFERENCES `suplex_final_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_final_review_findings_idx` ON `suplex_final_review_findings` (`review_id`, `severity`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_provider_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_key` text NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`retry_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `suplex_provider_operations_key_unique` UNIQUE(`operation_key`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_provider_operations_task_idx` ON `suplex_provider_operations` (`task_id`, `kind`, `updated_at`);

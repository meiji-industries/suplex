ALTER TABLE `forge_tasks` ADD COLUMN `successor_task_id` text;
--> statement-breakpoint
ALTER TABLE `forge_acceptances` ADD COLUMN `final_review_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_tasks_successor_idx` ON `forge_tasks` (`successor_task_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_workflow_snapshots` (
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`task_id`, `revision`),
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_workflow_snapshots_task_idx` ON `forge_workflow_snapshots` (`task_id`, `revision`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_final_reviews` (
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
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `forge_releases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ci_run_id`) REFERENCES `forge_ci_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_execution_id`) REFERENCES `forge_agent_executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opinion_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `forge_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `forge_final_reviews_subject_unique` UNIQUE(`workflow_id`, `subject_commit`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_final_review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`severity` text NOT NULL,
	`rationale` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`disposition` text NOT NULL,
	`repair_instruction` text,
	FOREIGN KEY (`review_id`) REFERENCES `forge_final_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_final_review_findings_idx` ON `forge_final_review_findings` (`review_id`, `severity`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_provider_operations` (
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
	FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `forge_provider_operations_key_unique` UNIQUE(`operation_key`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_provider_operations_task_idx` ON `forge_provider_operations` (`task_id`, `kind`, `updated_at`);

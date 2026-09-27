CREATE TABLE IF NOT EXISTS `suplex_plan_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`profile_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`session_ref` text NOT NULL,
	`opinion_artifact_id` text NOT NULL,
	`evidence_artifact_id` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `suplex_agent_executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opinion_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `suplex_plan_reviews_revision_unique` UNIQUE(`workflow_id`, `plan_revision`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_plan_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`company_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`decision` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`note_artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`note_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `suplex_plan_decisions_revision_unique` UNIQUE(`workflow_id`, `plan_revision`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_plan_reviews_task_idx` ON `suplex_plan_reviews` (`task_id`, `plan_revision`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_plan_decisions_task_idx` ON `suplex_plan_decisions` (`task_id`, `plan_revision`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_issue_governance` (
	`task_id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`plan_revision` integer,
	`plan_material` integer,
	`material_categories_json` text,
	`supplemental_review_used` integer NOT NULL DEFAULT 0,
	`supplemental_review_artifact_id` text,
	`decision_id` text,
	FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplemental_review_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `suplex_plan_decisions`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `forge_task_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL,
  `project_id` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `role_agents` text NOT NULL,
  `supplemental_review` integer NOT NULL,
  `auto_approve_plan` integer NOT NULL,
  `delivery_target` text NOT NULL,
  `run_project_tests` integer NOT NULL,
  `visual_evidence` text NOT NULL,
  `created_at` text NOT NULL,
  UNIQUE (`project_id`, `name`)
);
--> statement-breakpoint
CREATE INDEX `forge_task_templates_project_id_idx` ON `forge_task_templates` (`project_id`);

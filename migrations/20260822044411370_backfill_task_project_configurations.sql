-- Artifact files are written by the deploy-time backfill worker; this index
-- makes its verified task scan resumable without consulting mutable projects.
CREATE INDEX IF NOT EXISTS `suplex_tasks_project_configuration_artifact_idx`
  ON `suplex_tasks` (`project_configuration_artifact_id`);
--> statement-breakpoint
-- Successor records retain the legacy column for old workflow histories, but
-- new tasks place their configuration artifact ID there during the transition.
-- It is therefore no longer a foreign key to the retired revision table.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `suplex_successor_intents_next` (
  `id` text PRIMARY KEY NOT NULL,
  `predecessor_task_id` text NOT NULL UNIQUE,
  `predecessor_workflow_id` text NOT NULL UNIQUE,
  `accepted_revision` integer NOT NULL,
  `successor_task_id` text NOT NULL UNIQUE,
  `successor_workflow_id` text NOT NULL UNIQUE,
  `company_id` text NOT NULL,
  `project_id` text NOT NULL,
  `project_revision_id` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `reason_artifact_id` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('prepared', 'workflow_starting', 'started', 'linked')),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`predecessor_task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`successor_task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`) REFERENCES `suplex_projects`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`actor_user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`reason_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `suplex_successor_intents_next` SELECT * FROM `suplex_successor_intents`;
--> statement-breakpoint
DROP TABLE `suplex_successor_intents`;
--> statement-breakpoint
ALTER TABLE `suplex_successor_intents_next` RENAME TO `suplex_successor_intents`;
--> statement-breakpoint
CREATE INDEX `suplex_successor_intents_state_idx` ON `suplex_successor_intents` (`state`, `updated_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;

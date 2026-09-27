CREATE TABLE IF NOT EXISTS `suplex_plan_revision_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `company_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `request_revision` integer NOT NULL,
  `actor_user_id` text NOT NULL,
  `reason_artifact_id` text NOT NULL,
  `disposition` text NOT NULL CHECK (`disposition` IN ('reuse', 'new')),
  `status` text NOT NULL CHECK (`status` IN ('accepted', 'blocked', 'authorized')),
  `blocker_code` text,
  `developer_execution_id` text,
  `worktree_path` text,
  `branch_name` text,
  `base_sha` text,
  `head_sha` text,
  `tree_sha` text,
  `dirty_state` text CHECK (`dirty_state` IS NULL OR `dirty_state` IN ('clean', 'dirty')),
  `exact_base_sha` text,
  `authorized_plan_revision` integer,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `suplex_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`actor_user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`reason_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`developer_execution_id`) REFERENCES `suplex_developer_executions`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `suplex_plan_revision_requests_identity_unique` UNIQUE (`workflow_id`, `request_revision`),
  CONSTRAINT `suplex_plan_revision_requests_coordinates_check` CHECK ((`status` = 'blocked' AND `blocker_code` IS NOT NULL) OR (`status` IN ('accepted', 'authorized') AND `blocker_code` IS NULL)),
  CONSTRAINT `suplex_plan_revision_requests_reuse_check` CHECK ((`disposition` = 'reuse' AND `exact_base_sha` IS NULL AND (`status` = 'blocked' OR (`developer_execution_id` IS NOT NULL AND `worktree_path` IS NOT NULL AND `branch_name` IS NOT NULL AND `base_sha` IS NOT NULL AND `head_sha` IS NOT NULL AND `tree_sha` IS NOT NULL AND `dirty_state` = 'clean'))) OR (`disposition` = 'new' AND `exact_base_sha` IS NOT NULL AND `developer_execution_id` IS NULL AND `worktree_path` IS NULL AND `branch_name` IS NULL AND `base_sha` IS NULL AND `head_sha` IS NULL AND `tree_sha` IS NULL AND `dirty_state` IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_plan_revision_requests_task_idx` ON `suplex_plan_revision_requests` (`task_id`, `request_revision`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `suplex_successor_intents` (
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
  FOREIGN KEY (`project_revision_id`) REFERENCES `suplex_project_revisions`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`actor_user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`reason_artifact_id`) REFERENCES `suplex_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_successor_intents_state_idx` ON `suplex_successor_intents` (`state`, `updated_at`);
--> statement-breakpoint
CREATE TEMP TABLE `suplex_task_link_integrity_assertion` (
  `duplicate_predecessors` integer NOT NULL CONSTRAINT `no_duplicate_predecessor_links` CHECK (`duplicate_predecessors` = 0),
  `duplicate_successors` integer NOT NULL CONSTRAINT `no_duplicate_successor_links` CHECK (`duplicate_successors` = 0)
);
--> statement-breakpoint
INSERT INTO `suplex_task_link_integrity_assertion` (`duplicate_predecessors`, `duplicate_successors`)
SELECT
  (SELECT COUNT(*) FROM (SELECT `predecessor_task_id` FROM `suplex_tasks` WHERE `predecessor_task_id` IS NOT NULL GROUP BY `predecessor_task_id` HAVING COUNT(*) > 1)),
  (SELECT COUNT(*) FROM (SELECT `successor_task_id` FROM `suplex_tasks` WHERE `successor_task_id` IS NOT NULL GROUP BY `successor_task_id` HAVING COUNT(*) > 1));
--> statement-breakpoint
DROP TABLE `suplex_task_link_integrity_assertion`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_tasks_one_predecessor` ON `suplex_tasks` (`predecessor_task_id`) WHERE `predecessor_task_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `suplex_tasks_one_successor` ON `suplex_tasks` (`successor_task_id`) WHERE `successor_task_id` IS NOT NULL;

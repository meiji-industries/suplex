CREATE TABLE `suplex_developer_execution_truth_new` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `worktree_lease_id` text NOT NULL,
  `manifest_artifact_id` text NOT NULL,
  `manifest_sha256` text NOT NULL,
  `boundary_mode` text NOT NULL DEFAULT 'owner_controlled_observed',
  `before_provider_artifact_id` text,
  `before_provider_sha256` text,
  `after_provider_artifact_id` text,
  `after_provider_sha256` text,
  `raw_report_artifact_id` text,
  `raw_report_sha256` text,
  `reconciliation_artifact_id` text,
  `reconciliation_sha256` text,
  `starting_commit` text NOT NULL,
  `starting_tree` text NOT NULL,
  `final_commit` text,
  `final_tree` text,
  FOREIGN KEY (`execution_id`) REFERENCES `suplex_developer_executions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`worktree_lease_id`) REFERENCES `suplex_issue_worktrees`(`id`),
  FOREIGN KEY (`manifest_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`before_provider_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`after_provider_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`raw_report_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  FOREIGN KEY (`reconciliation_artifact_id`) REFERENCES `suplex_artifacts`(`id`),
  CONSTRAINT `suplex_developer_execution_truth_boundary_check` CHECK (`boundary_mode` = 'owner_controlled_observed')
);
--> statement-breakpoint
INSERT INTO `suplex_developer_execution_truth_new` (`execution_id`, `worktree_lease_id`, `manifest_artifact_id`, `manifest_sha256`, `boundary_mode`, `before_provider_artifact_id`, `before_provider_sha256`, `after_provider_artifact_id`, `after_provider_sha256`, `raw_report_artifact_id`, `raw_report_sha256`, `reconciliation_artifact_id`, `reconciliation_sha256`, `starting_commit`, `starting_tree`, `final_commit`, `final_tree`)
SELECT `execution_id`, `worktree_lease_id`, `manifest_artifact_id`, `manifest_sha256`, `boundary_mode`, `before_provider_artifact_id`, `before_provider_sha256`, `after_provider_artifact_id`, `after_provider_sha256`, `raw_report_artifact_id`, `raw_report_sha256`, `reconciliation_artifact_id`, `reconciliation_sha256`, `starting_commit`, `starting_tree`, `final_commit`, `final_tree`
FROM `suplex_developer_execution_truth`;
--> statement-breakpoint
DROP TABLE `suplex_developer_execution_truth`;
--> statement-breakpoint
ALTER TABLE `suplex_developer_execution_truth_new` RENAME TO `suplex_developer_execution_truth`;
--> statement-breakpoint
DROP TABLE `suplex_plan_authorizations`;
--> statement-breakpoint
DROP TABLE `suplex_issue_governance`;

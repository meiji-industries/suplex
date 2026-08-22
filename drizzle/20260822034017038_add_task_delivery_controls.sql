ALTER TABLE `forge_tasks` ADD COLUMN `delivery_target` text;
--> statement-breakpoint
ALTER TABLE `forge_tasks` ADD COLUMN `run_project_tests` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `forge_tasks` ADD COLUMN `visual_evidence` text NOT NULL DEFAULT 'off';
--> statement-breakpoint
ALTER TABLE `forge_tasks` ADD COLUMN `delivery_worktree_path` text;
--> statement-breakpoint
ALTER TABLE `forge_tasks` ADD COLUMN `delivery_branch_name` text;
--> statement-breakpoint
ALTER TABLE `forge_tasks` ADD COLUMN `delivery_commit` text;

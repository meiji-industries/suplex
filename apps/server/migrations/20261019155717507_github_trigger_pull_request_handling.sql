ALTER TABLE suplex_github_trigger_rules ADD COLUMN draft_pull_requests TEXT NOT NULL DEFAULT 'ignore';
--> statement-breakpoint
ALTER TABLE suplex_github_trigger_rules ADD COLUMN ready_pull_requests TEXT NOT NULL DEFAULT 'deliver';

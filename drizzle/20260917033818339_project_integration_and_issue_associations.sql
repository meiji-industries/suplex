ALTER TABLE suplex_projects ADD COLUMN integration_json TEXT;
--> statement-breakpoint
ALTER TABLE suplex_projects ADD COLUMN execution_json TEXT;
--> statement-breakpoint
ALTER TABLE suplex_tasks ADD COLUMN issue_json TEXT;
--> statement-breakpoint
ALTER TABLE suplex_tasks ADD COLUMN issue_context_json TEXT;
--> statement-breakpoint
ALTER TABLE suplex_tasks ADD COLUMN issue_publication_json TEXT;

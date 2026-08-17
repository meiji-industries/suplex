ALTER TABLE forge_tasks ADD COLUMN auto_approve_plan INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE forge_tasks ADD COLUMN pull_request_mode TEXT NOT NULL DEFAULT 'draft';

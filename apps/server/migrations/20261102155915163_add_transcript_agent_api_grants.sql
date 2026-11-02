ALTER TABLE suplex_external_agents ADD COLUMN transcripts_granted_by_user_id TEXT REFERENCES suplex_users(id);
--> statement-breakpoint
ALTER TABLE suplex_external_agents ADD COLUMN transcripts_granted_at TEXT;

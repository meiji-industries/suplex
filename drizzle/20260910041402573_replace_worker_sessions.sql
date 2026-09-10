ALTER TABLE forge_task_sessions ADD COLUMN profile_json TEXT;
--> statement-breakpoint
ALTER TABLE forge_task_sessions ADD COLUMN replaces_session_id TEXT REFERENCES forge_task_sessions(id);
--> statement-breakpoint
ALTER TABLE forge_task_sessions ADD COLUMN replacement_reason TEXT;
--> statement-breakpoint
ALTER TABLE forge_task_sessions ADD COLUMN replacement_handoff TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX forge_task_sessions_replaces_session ON forge_task_sessions(replaces_session_id) WHERE replaces_session_id IS NOT NULL;

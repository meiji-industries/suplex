ALTER TABLE suplex_telemetry ADD COLUMN session_replay_enabled INTEGER NOT NULL DEFAULT 0 CHECK (session_replay_enabled IN (0, 1));
--> statement-breakpoint
ALTER TABLE suplex_telemetry ADD COLUMN last_app_version TEXT;
--> statement-breakpoint
ALTER TABLE suplex_telemetry ADD COLUMN last_app_revision TEXT;

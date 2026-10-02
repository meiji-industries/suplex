-- Product telemetry. The host forwards committed rows to PostHog only after a
-- user saw the notice and only while the setting is on. docs/telemetry.md
-- lists every event and property.
ALTER TABLE suplex_environment_settings ADD COLUMN telemetry_enabled INTEGER NOT NULL DEFAULT 1 CHECK (telemetry_enabled IN (0, 1));
--> statement-breakpoint
CREATE TABLE suplex_telemetry (
  id TEXT PRIMARY KEY CHECK (id = 'host'),
  notice_at TEXT,
  email TEXT,
  email_sent_at TEXT,
  audit_cursor INTEGER,
  lifecycle_cursor INTEGER,
  daily_at TEXT
);
--> statement-breakpoint
CREATE TABLE suplex_telemetry_pull_requests (
  task_id TEXT PRIMARY KEY,
  merged INTEGER NOT NULL CHECK (merged IN (0, 1))
);

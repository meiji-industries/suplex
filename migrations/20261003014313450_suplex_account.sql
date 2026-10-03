-- The Suplex account linked to this installation. One row per host; the
-- token is the hosted account token, used only to log out.
CREATE TABLE suplex_account (
  id TEXT PRIMARY KEY CHECK (id = 'host'),
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  token TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  identify_sent_at TEXT
);
--> statement-breakpoint
ALTER TABLE suplex_telemetry DROP COLUMN email;
--> statement-breakpoint
ALTER TABLE suplex_telemetry DROP COLUMN email_sent_at;

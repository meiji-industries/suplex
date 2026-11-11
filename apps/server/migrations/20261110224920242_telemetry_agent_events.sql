-- Telemetry observations from agent surfaces (pairing, MCP, the Agent API, and `suplex mcp`)
-- that have no audit row. The telemetry tick sends them under the same consent gates.
CREATE TABLE suplex_telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  company_id TEXT,
  properties_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE suplex_telemetry ADD COLUMN event_cursor INTEGER;

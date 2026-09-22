CREATE TABLE suplex_task_usage (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
--> statement-breakpoint
CREATE INDEX suplex_task_usage_task ON suplex_task_usage(task_id);
--> statement-breakpoint
CREATE TABLE suplex_task_analytics_sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  observed_at TEXT,
  error_at TEXT
);
--> statement-breakpoint
CREATE TABLE suplex_task_analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  question_id TEXT,
  observed_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX suplex_task_analytics_events_task ON suplex_task_analytics_events(task_id, id);

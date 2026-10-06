CREATE TABLE suplex_web_push_keys (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  private_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE suplex_web_push_subscriptions (
  endpoint TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES suplex_users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX suplex_web_push_subscriptions_user_id ON suplex_web_push_subscriptions(user_id);
--> statement-breakpoint
CREATE TABLE suplex_web_push_sent (
  task_id TEXT NOT NULL REFERENCES suplex_tasks(id) ON DELETE CASCADE,
  status_changed_at TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (task_id, status_changed_at)
);

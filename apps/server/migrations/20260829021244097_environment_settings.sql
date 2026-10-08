-- Write migration SQL here.
CREATE TABLE suplex_environment_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'host'),
  min_free_disk_gb REAL NOT NULL DEFAULT 5 CHECK (min_free_disk_gb >= 0 AND min_free_disk_gb <= 1024),
  updated_at TEXT
);
--> statement-breakpoint
INSERT INTO suplex_environment_settings (id, min_free_disk_gb, updated_at) VALUES ('host', 5, NULL);

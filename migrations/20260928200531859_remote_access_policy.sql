-- Write migration SQL here.
CREATE TABLE suplex_remote_access_policy (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'host'),
  mode TEXT NOT NULL CHECK (mode IN ('open', 'passkeys')),
  require_https INTEGER NOT NULL CHECK (require_https IN (0, 1)),
  default_user_id TEXT,
  external_https_origin TEXT,
  updated_at TEXT,
  CHECK ((mode = 'open' AND default_user_id IS NOT NULL) OR (mode = 'passkeys' AND require_https = 1 AND default_user_id IS NULL)),
  FOREIGN KEY (default_user_id) REFERENCES suplex_users(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);
--> statement-breakpoint
INSERT INTO suplex_remote_access_policy (id, mode, require_https, default_user_id, external_https_origin, updated_at)
VALUES ('host', 'open', 0, 'user_development', NULL, NULL);
--> statement-breakpoint
ALTER TABLE suplex_sessions ADD COLUMN provenance TEXT NOT NULL DEFAULT 'legacy' CHECK (provenance IN ('legacy', 'automatic', 'passkey'));
--> statement-breakpoint
ALTER TABLE suplex_credentials ADD COLUMN label TEXT NOT NULL DEFAULT 'Passkey';

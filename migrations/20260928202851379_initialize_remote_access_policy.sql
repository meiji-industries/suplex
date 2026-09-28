ALTER TABLE suplex_remote_access_policy ADD COLUMN initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1));

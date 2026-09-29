ALTER TABLE suplex_environment_settings ADD COLUMN git2_enabled INTEGER NOT NULL DEFAULT 0 CHECK (git2_enabled IN (0, 1));

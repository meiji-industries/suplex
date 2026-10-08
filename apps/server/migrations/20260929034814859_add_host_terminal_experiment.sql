ALTER TABLE suplex_environment_settings ADD COLUMN host_terminal_enabled INTEGER NOT NULL DEFAULT 0 CHECK (host_terminal_enabled IN (0, 1));

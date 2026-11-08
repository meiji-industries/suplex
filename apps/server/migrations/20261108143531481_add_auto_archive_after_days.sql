ALTER TABLE suplex_environment_settings ADD COLUMN auto_archive_after_days INTEGER NOT NULL DEFAULT 30 CHECK (auto_archive_after_days >= 0);

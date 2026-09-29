ALTER TABLE suplex_environment_settings ADD COLUMN today_page_enabled INTEGER NOT NULL DEFAULT 0 CHECK (today_page_enabled IN (0, 1));

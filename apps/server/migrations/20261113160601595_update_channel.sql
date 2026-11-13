ALTER TABLE suplex_environment_settings ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable', 'dev'));

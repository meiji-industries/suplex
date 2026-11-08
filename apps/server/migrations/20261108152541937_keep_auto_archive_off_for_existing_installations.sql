-- An installation that was in use before automatic archive existed keeps it off
-- until an administrator sets a number of days. A migration seeds only the
-- development Operator user, and no migration seeds companies or tasks. So any
-- other user, any company, or any task means earlier use. A new installation
-- has none of them and keeps the default of 30.
UPDATE suplex_environment_settings SET auto_archive_after_days = 0 WHERE id = 'host' AND (EXISTS (SELECT 1 FROM suplex_users WHERE id <> 'user_development') OR EXISTS (SELECT 1 FROM suplex_companies) OR EXISTS (SELECT 1 FROM suplex_tasks));

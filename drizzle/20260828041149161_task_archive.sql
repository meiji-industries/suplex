-- Write migration SQL here.
ALTER TABLE forge_tasks ADD COLUMN archived_at TEXT;

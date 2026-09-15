-- A fresh install has no tasks, so its seeds become Codex; an install with
-- history keeps its converted OpenCode profiles.
UPDATE forge_profiles SET model = provider || '/' || model, provider = 'opencode' WHERE provider NOT IN ('opencode', 'claude-code', 'devin', 'codex');
--> statement-breakpoint
UPDATE forge_profiles SET provider = 'codex', model = 'gpt-5.6-sol', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'profile_native_root' AND NOT EXISTS (SELECT 1 FROM forge_tasks);
--> statement-breakpoint
UPDATE forge_profiles SET provider = 'codex', model = 'gpt-5.6-luna', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'profile_native_worker' AND NOT EXISTS (SELECT 1 FROM forge_tasks);

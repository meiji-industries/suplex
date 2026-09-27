INSERT OR IGNORE INTO suplex_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at)
VALUES
  ('profile_native_root', 'Root', 'openai', 'gpt-5.6-sol', 'medium', 'standard', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('profile_native_worker', 'Worker', 'openai', 'gpt-5.6-luna', 'max', 'priority', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
INSERT OR IGNORE INTO suplex_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at)
SELECT 'agent_native_root', 'internal', 'Root', 'planner', '781a58269e47413298b36a2d265400c9', 'profile_native_root', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM suplex_profiles WHERE id = 'profile_native_root');
--> statement-breakpoint
INSERT OR IGNORE INTO suplex_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at)
SELECT 'agent_native_worker', 'internal', 'Worker', 'builder', '07d642a2f9024178a5bd6c3b59535650', 'profile_native_worker', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM suplex_profiles WHERE id = 'profile_native_worker');

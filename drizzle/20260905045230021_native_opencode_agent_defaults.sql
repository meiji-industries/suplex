UPDATE forge_profiles
SET provider = 'openai', model = 'gpt-5.6-sol', reasoning_level = 'medium', service_priority = 'standard'
WHERE provider IN ('codex', 'claude');
--> statement-breakpoint
UPDATE forge_profiles
SET provider = 'openai', model = 'gpt-5.6-luna', reasoning_level = 'max', service_priority = 'priority'
WHERE id IN (SELECT profile_id FROM forge_agents WHERE kind = 'internal' AND role = 'builder');

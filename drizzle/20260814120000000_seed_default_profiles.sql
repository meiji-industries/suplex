-- Normalize the development profile set while preserving existing profile IDs.
UPDATE forge_profiles
SET name = 'Smart', provider = 'codex', model = 'gpt-5.6-sol', reasoning_level = 'high', service_priority = 'standard', updated_at = '2026-08-14T00:00:00.000Z'
WHERE name = 'Default' AND NOT EXISTS (SELECT 1 FROM forge_profiles WHERE name = 'Smart');
--> statement-breakpoint
INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at)
SELECT 'profile_default_smart', 'Smart', 'codex', 'gpt-5.6-sol', 'high', 'standard', 2, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM forge_profiles WHERE name = 'Smart');
--> statement-breakpoint
INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at)
SELECT 'profile_default_balanced', 'Balanced', 'codex', 'gpt-5.6-terra', 'medium', 'standard', 2, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM forge_profiles WHERE name = 'Balanced');
--> statement-breakpoint
INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at)
SELECT 'profile_default_fast', 'Fast', 'codex', 'gpt-5.6-luna', 'xhigh', 'fast', 2, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM forge_profiles WHERE name = 'Fast');

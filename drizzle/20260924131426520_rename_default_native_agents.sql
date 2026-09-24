UPDATE suplex_profiles
SET name = 'Smart Coordinator', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'profile_native_root' AND name = 'Root'
  AND NOT EXISTS (SELECT 1 FROM suplex_profiles WHERE name = 'Smart Coordinator');
--> statement-breakpoint
UPDATE suplex_profiles
SET name = 'Fast Worker', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'profile_native_worker' AND name = 'Worker'
  AND NOT EXISTS (SELECT 1 FROM suplex_profiles WHERE name = 'Fast Worker');

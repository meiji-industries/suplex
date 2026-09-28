UPDATE suplex_profiles
SET name = 'Alt Coordinator'
WHERE id = 'profile_native_independent' AND name = 'Independent Coordinator'
  AND NOT EXISTS (SELECT 1 FROM suplex_profiles WHERE name = 'Alt Coordinator');

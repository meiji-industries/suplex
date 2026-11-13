-- One global default agent for each role slot. A new project copies these profile IDs.
-- A slot without a row uses its seeded profile.
CREATE TABLE suplex_profile_defaults (
  slot TEXT PRIMARY KEY NOT NULL CHECK (slot IN ('root', 'alt', 'worker')),
  profile_id TEXT NOT NULL REFERENCES suplex_profiles(id),
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO suplex_profile_defaults (slot, profile_id, updated_at)
SELECT seeded.slot, profile.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT 'root' AS slot, 'profile_native_root' AS profile_id, 'root' AS role
  UNION ALL SELECT 'alt', 'profile_native_independent', 'root'
  UNION ALL SELECT 'worker', 'profile_native_worker', 'worker'
) AS seeded
JOIN suplex_profiles AS profile
  ON profile.id = seeded.profile_id AND profile.role = seeded.role AND profile.archived_at IS NULL;

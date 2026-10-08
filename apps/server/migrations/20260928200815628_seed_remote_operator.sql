-- Write migration SQL here.
INSERT OR IGNORE INTO suplex_users (
  id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version
) VALUES (
  'user_development', 'Operator', 'operator@suplex.local', 'operator@suplex.local',
  'admin', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1
);

DELETE FROM forge_agents WHERE kind = 'internal';
--> statement-breakpoint
DROP TABLE forge_profiles;
--> statement-breakpoint
CREATE TABLE forge_profiles (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('root', 'worker')),
  avatar_seed text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  reasoning_level text NOT NULL CHECK (reasoning_level IN ('low', 'medium', 'high', 'xhigh', 'max')),
  service_tier text NOT NULL CHECK (service_tier IN ('default', 'priority')),
  archived_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
INSERT INTO forge_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at)
VALUES ('profile_native_root', 'Root', 'root', '00000000000000000000000000000001', 'openai', 'gpt-5.6-sol', 'medium', 'default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       ('profile_native_worker', 'Worker', 'worker', '00000000000000000000000000000002', 'openai', 'gpt-5.6-luna', 'max', 'priority', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

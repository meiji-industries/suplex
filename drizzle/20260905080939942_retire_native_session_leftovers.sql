ALTER TABLE forge_task_sessions DROP COLUMN agent_name;
--> statement-breakpoint
ALTER TABLE forge_task_sessions DROP COLUMN prompt_hash;
--> statement-breakpoint
ALTER TABLE forge_task_sessions DROP COLUMN result_receipt_id;
--> statement-breakpoint
CREATE TABLE forge_agents_native (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL UNIQUE,
  avatar_seed text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
INSERT INTO forge_agents_native (id, name, avatar_seed, created_at, updated_at)
SELECT id, name, avatar_seed, created_at, updated_at FROM forge_agents;
--> statement-breakpoint
DROP TABLE forge_agents;
--> statement-breakpoint
ALTER TABLE forge_agents_native RENAME TO forge_agents;

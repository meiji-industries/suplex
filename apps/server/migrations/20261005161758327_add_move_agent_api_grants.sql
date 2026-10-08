-- Write migration SQL here.
ALTER TABLE suplex_external_agents ADD COLUMN moves_granted_by_user_id TEXT REFERENCES suplex_users(id);
--> statement-breakpoint
ALTER TABLE suplex_external_agents ADD COLUMN moves_granted_at TEXT;
--> statement-breakpoint
ALTER TABLE suplex_moves ADD COLUMN created_by_external_agent_id TEXT REFERENCES suplex_external_agents(id);
--> statement-breakpoint
ALTER TABLE suplex_moves ADD COLUMN idempotency_key TEXT;
--> statement-breakpoint
ALTER TABLE suplex_moves ADD COLUMN request_hash TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_moves_agent_create_key ON suplex_moves(created_by_external_agent_id, idempotency_key) WHERE created_by_external_agent_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE suplex_move_runs ADD COLUMN started_by_external_agent_id TEXT REFERENCES suplex_external_agents(id);
--> statement-breakpoint
ALTER TABLE suplex_move_runs ADD COLUMN request_hash TEXT;

ALTER TABLE suplex_provider_operations ADD COLUMN delivery_generation integer;
--> statement-breakpoint
ALTER TABLE suplex_provider_operations ADD COLUMN delivery_intent_json text;
--> statement-breakpoint
ALTER TABLE suplex_provider_operations ADD COLUMN owner_token text;
--> statement-breakpoint
ALTER TABLE suplex_provider_operations ADD COLUMN owner_generation integer;
--> statement-breakpoint
ALTER TABLE suplex_provider_operations ADD COLUMN lease_expires_at text;
--> statement-breakpoint
ALTER TABLE suplex_provider_operations ADD COLUMN heartbeat_at text;
--> statement-breakpoint
ALTER TABLE suplex_provider_operations ADD COLUMN cancelled_at text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS suplex_provider_operations_delivery_owner_idx
  ON suplex_provider_operations (task_id, workflow_id, delivery_generation, lease_expires_at);

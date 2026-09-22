ALTER TABLE suplex_operation_claims ADD COLUMN coordinates_json TEXT;
--> statement-breakpoint
ALTER TABLE suplex_operation_claims ADD COLUMN owner_token TEXT;
--> statement-breakpoint
ALTER TABLE suplex_operation_claims ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;

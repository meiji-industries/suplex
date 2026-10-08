ALTER TABLE suplex_operation_claims ADD COLUMN phase TEXT CHECK (phase IN ('prepared', 'executing'));
--> statement-breakpoint
ALTER TABLE suplex_operation_claims ADD COLUMN effect_receipt_json TEXT;
--> statement-breakpoint
ALTER TABLE suplex_operation_claims ADD COLUMN lease_expires_at TEXT;
--> statement-breakpoint
ALTER TABLE suplex_operation_claims ADD COLUMN heartbeat_at TEXT;
--> statement-breakpoint
CREATE TABLE suplex_worktree_mutation_leases (
  worktree_path TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  generation INTEGER NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

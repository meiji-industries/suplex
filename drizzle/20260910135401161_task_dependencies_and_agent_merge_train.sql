CREATE TABLE forge_task_dependencies (
  task_id text NOT NULL,
  depends_on_task_id text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX forge_task_dependencies_depends_on_idx ON forge_task_dependencies (depends_on_task_id);
--> statement-breakpoint
CREATE TABLE forge_delivery_provenance (
  id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  attempt_id text,
  agent_id text,
  kind text NOT NULL CHECK (kind IN ('reconciliation', 'observation', 'merge')),
  pull_request_number integer,
  original_head_sha text,
  head_sha text,
  base_sha text,
  checks_json text,
  merge_json text,
  recorded_at text NOT NULL,
  FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX forge_delivery_provenance_task_idx ON forge_delivery_provenance (task_id, recorded_at, id);
--> statement-breakpoint
CREATE INDEX forge_delivery_provenance_attempt_idx ON forge_delivery_provenance (attempt_id);
--> statement-breakpoint
-- Provenance is append-only. Rows are never rewritten; a later fact is a new row that names the same attempt.
-- Deletion stays available so that clearing a company still removes its task data.
CREATE TRIGGER forge_delivery_provenance_append_only
BEFORE UPDATE ON forge_delivery_provenance
BEGIN
  SELECT RAISE(ABORT, 'forge_delivery_provenance is append-only');
END;
--> statement-breakpoint
CREATE TABLE forge_merge_approvals (
  id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  agent_id text NOT NULL,
  pull_request_number integer NOT NULL,
  head_sha text NOT NULL,
  base_sha text NOT NULL,
  receipt_hash text NOT NULL UNIQUE,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  consumed_at text,
  FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX forge_merge_approvals_task_idx ON forge_merge_approvals (task_id, created_at);

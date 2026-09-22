CREATE TABLE suplex_task_controls (
  task_id text PRIMARY KEY NOT NULL,
  objective text NOT NULL,
  delivery_target text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'waiting_human', 'cancelled', 'delivered')),
  wake_at text,
  human_question text,
  worktree_json text,
  pull_request_json text,
  root_session_id text,
  worker_session_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  FOREIGN KEY (task_id) REFERENCES suplex_tasks(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE suplex_task_sessions (
  id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('root', 'worker')),
  generation integer NOT NULL CHECK (generation > 0),
  is_current integer NOT NULL CHECK (is_current IN (0, 1)),
  pane_id text,
  agent_name text,
  native_session_id text,
  lifecycle text NOT NULL CHECK (lifecycle IN ('reserved', 'live', 'stopped', 'unknown', 'cancelled')),
  assignment_hash text,
  prompt_hash text,
  result_receipt_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  FOREIGN KEY (task_id) REFERENCES suplex_tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, kind, generation)
);
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_task_current_root_unique
  ON suplex_task_sessions (task_id, kind) WHERE is_current = 1 AND kind = 'root';
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_task_current_worker_unique
  ON suplex_task_sessions (task_id, kind) WHERE is_current = 1 AND kind = 'worker';
--> statement-breakpoint
CREATE TABLE suplex_task_turns (
  id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  session_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  assignment_hash text,
  prompt_hash text NOT NULL,
  prompt_text text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_prompt', 'prompted', 'unknown', 'completed', 'cancelled')),
  result_receipt_id text,
  terminal_observation text,
  created_at text NOT NULL,
  prompted_at text,
  completed_at text,
  updated_at text NOT NULL,
  FOREIGN KEY (task_id) REFERENCES suplex_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES suplex_task_sessions(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX suplex_task_turn_recovery_idx
  ON suplex_task_turns (task_id, session_id, status, updated_at);

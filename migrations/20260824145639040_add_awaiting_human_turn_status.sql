PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE suplex_herdr_turns_awaiting_human (
  turn_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  role_session_id TEXT NOT NULL,
  execution_role TEXT NOT NULL CHECK (execution_role IN ('planner', 'reviewer', 'builder', 'integrator')),
  ledger TEXT NOT NULL CHECK (ledger IN ('agent', 'developer')),
  execution_id TEXT NOT NULL,
  prompt_kind TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  result_relative_path TEXT NOT NULL UNIQUE,
  rollout_path TEXT,
  rollout_start_offset INTEGER NOT NULL DEFAULT 0 CHECK (rollout_start_offset >= 0),
  rollout_cursor_offset INTEGER NOT NULL DEFAULT 0 CHECK (rollout_cursor_offset >= rollout_start_offset),
  codex_turn_id TEXT,
  prompt_sent_at TEXT,
  task_complete_seen_at TEXT,
  result_sha256 TEXT,
  result_artifact_id TEXT,
  rollout_artifact_id TEXT,
  correction_of_turn_id TEXT,
  correction_index INTEGER NOT NULL DEFAULT 0 CHECK (correction_index >= 0),
  interrupted_generation INTEGER,
  interrupted_prompt_sent_at TEXT,
  attention_excerpt TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'correction_required', 'completed', 'interrupted', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (ledger, execution_id, prompt_kind, correction_index),
  FOREIGN KEY (task_id) REFERENCES suplex_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (role_session_id) REFERENCES suplex_herdr_role_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (result_artifact_id) REFERENCES suplex_artifacts(id),
  FOREIGN KEY (rollout_artifact_id) REFERENCES suplex_artifacts(id),
  FOREIGN KEY (correction_of_turn_id) REFERENCES suplex_herdr_turns_awaiting_human(turn_id)
);
--> statement-breakpoint
INSERT INTO suplex_herdr_turns_awaiting_human (
  turn_id, task_id, role_session_id, execution_role, ledger, execution_id,
  prompt_kind, prompt_sha256, result_relative_path, rollout_path,
  rollout_start_offset, rollout_cursor_offset, codex_turn_id, prompt_sent_at,
  task_complete_seen_at, result_sha256, result_artifact_id, rollout_artifact_id,
  correction_of_turn_id, correction_index, interrupted_generation,
  interrupted_prompt_sent_at, status, created_at, updated_at, finished_at
)
SELECT
  turn_id, task_id, role_session_id, execution_role, ledger, execution_id,
  prompt_kind, prompt_sha256, result_relative_path, rollout_path,
  rollout_start_offset, rollout_cursor_offset, codex_turn_id, prompt_sent_at,
  task_complete_seen_at, result_sha256, result_artifact_id, rollout_artifact_id,
  correction_of_turn_id, correction_index, interrupted_generation,
  interrupted_prompt_sent_at, status, created_at, updated_at, finished_at
FROM suplex_herdr_turns;
--> statement-breakpoint
DROP TABLE suplex_herdr_turns;
--> statement-breakpoint
ALTER TABLE suplex_herdr_turns_awaiting_human RENAME TO suplex_herdr_turns;
--> statement-breakpoint
CREATE INDEX suplex_herdr_turn_active_idx
  ON suplex_herdr_turns (task_id, role_session_id, status, updated_at);
--> statement-breakpoint
PRAGMA foreign_keys=ON;

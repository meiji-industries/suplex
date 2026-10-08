import { readFile } from "node:fs/promises";

import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

test("role panes migration maps legacy roles and keeps one current reviewer", async () => {
  const database = new Database(":memory:", { enableForeignKeyConstraints: false });
  database.exec("PRAGMA foreign_keys = ON");
  try {
    database.exec(`
      CREATE TABLE suplex_tasks (id TEXT PRIMARY KEY);
      INSERT INTO suplex_tasks VALUES ('task');
      CREATE TABLE suplex_herdr_role_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES suplex_tasks(id) ON DELETE cascade,
        session_role TEXT NOT NULL CHECK (session_role IN ('lead', 'developer', 'reviewer')),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('codex', 'claude', 'openrouter')),
        codex_session_id TEXT UNIQUE, agent_name TEXT, pane_id TEXT, rollout_path TEXT,
        launch_fingerprint TEXT, guard_directory TEXT,
        status TEXT NOT NULL CHECK (status IN ('unbound', 'starting', 'ready', 'working', 'blocked', 'missing', 'closed', 'failed')),
        last_agent_status TEXT, attention_activated_at TEXT, ensure_token TEXT, ensure_expires_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT, attention_excerpt TEXT,
        UNIQUE (task_id, session_role, generation)
      );
      CREATE UNIQUE INDEX suplex_herdr_current_persistent_role_unique ON suplex_herdr_role_sessions (task_id, session_role) WHERE is_current = 1 AND session_role IN ('lead', 'developer');
      CREATE INDEX suplex_herdr_role_session_status_idx ON suplex_herdr_role_sessions (status, updated_at);
      INSERT INTO suplex_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, agent_name, pane_id, status, created_at, updated_at) VALUES
        ('lead', 'task', 'lead', 0, 1, 'codex', 'live-lead-name', 'lead-pane', 'ready', '2026-08-29', '2026-08-29'),
        ('developer', 'task', 'developer', 0, 1, 'codex', 'live-developer-name', 'developer-pane', 'ready', '2026-08-29', '2026-08-29'),
        ('reviewer-0', 'task', 'reviewer', 0, 1, 'codex', 'live-reviewer-0', 'reviewer-pane-0', 'ready', '2026-08-29', '2026-08-29'),
        ('reviewer-1', 'task', 'reviewer', 1, 1, 'codex', 'live-reviewer-1', 'reviewer-pane-1', 'ready', '2026-08-29', '2026-08-29');
    `);
    const migration = await readFile(new URL("../apps/server/migrations/20260829121040158_role_panes.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);

    expect(database.prepare("SELECT id, session_role AS role, is_current AS current, agent_name AS agentName, pane_id AS paneId FROM suplex_herdr_role_sessions ORDER BY id").all()).toEqual([
      { id: "developer", role: "builder", current: 1, agentName: "live-developer-name", paneId: "developer-pane" },
      { id: "lead", role: "planner", current: 1, agentName: "live-lead-name", paneId: "lead-pane" },
      { id: "reviewer-0", role: "reviewer", current: 0, agentName: "live-reviewer-0", paneId: "reviewer-pane-0" },
      { id: "reviewer-1", role: "reviewer", current: 1, agentName: "live-reviewer-1", paneId: "reviewer-pane-1" },
    ]);
  } finally {
    database.close();
  }
});

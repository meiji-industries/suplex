import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { projectAgentRuntime } from "../src/agent-runtime.js";
import { ForgeDatabase } from "../src/database.js";

const now = "2026-08-31T00:00:00.000Z";

test("runtime projection excludes inaccessible and unbound agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-agent-runtime-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      for (const companyId of ["company-a", "company-b"]) {
        db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, ?, 'active', ?)").run(companyId, companyId, now);
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(`project-${companyId}`, companyId, companyId, `/repo/${companyId}`, `/worktrees/${companyId}`, now, now);
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 'Task', 'brief', '[]', ?, 0, ?, 'revision', ?, ?, ?)").run(`task-${companyId}`, companyId, `project-${companyId}`, JSON.stringify({ planner: "shared-agent" }), `workflow-${companyId}`, `key-${companyId}`, now, now);
        db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES (?, ?, ?, ?, 1, 'planning', 'lead', '[]', NULL, ?, 'event')").run(`task-${companyId}`, companyId, `project-${companyId}`, `workflow-${companyId}`, now);
        db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, pane_id, status, created_at, updated_at) VALUES (?, ?, 'planner', 1, 1, 'codex', ?, 'ready', ?, ?)").run(`session-${companyId}`, `task-${companyId}`, `pane-${companyId}`, now, now);
      }
    });
    const runtime = await projectAgentRuntime(database, { runtimeSnapshot: async () => ({ agents: [{ name: "unbound", paneId: "other", status: "working" }], panes: [{ paneId: "other", agent: "unbound", agentStatus: "working" }] }) } as never, ["shared-agent"], ["company-a"]);
    expect(runtime).toEqual([{ agentId: "shared-agent", taskId: "task-company-a", role: "planner", diagnosis: "unknown", detail: "No recovery action is currently needed." }]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

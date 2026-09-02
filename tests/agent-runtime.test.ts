import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { projectAgentRuntime } from "../src/agent-runtime.js";
import { ForgeDatabase } from "../src/database.js";

const now = "2026-08-31T00:00:00.000Z";
type FixtureRole = "planner" | "builder" | "reviewer" | "integrator";

test("runtime projection excludes stale history and keeps in-flight turns and observed active panes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-agent-runtime-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      for (const companyId of ["company-a", "company-b"]) {
        db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, ?, 'active', ?)").run(companyId, companyId, now);
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(`project-${companyId}`, companyId, companyId, `/repo/${companyId}`, `/worktrees/${companyId}`, now, now);
      }

      const addTask = (id: string, role: FixtureRole, options: { companyId?: string; archived?: boolean; executionStatus?: string; turnStatus?: string } = {}) => {
        const companyId = options.companyId ?? "company-a";
        const taskId = `task-${id}`;
        const sessionId = `session-${id}`;
        const executionId = `execution-${id}`;
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'Task', 'brief', '[]', ?, 0, ?, 'revision', ?, ?, ?, ?)").run(taskId, companyId, `project-${companyId}`, JSON.stringify({ [role]: "shared-agent" }), `workflow-${id}`, `key-${id}`, now, now, options.archived ? now : null);
        db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES (?, ?, ?, ?, 1, 'planning', 'lead', '[]', NULL, ?, ?)").run(taskId, companyId, `project-${companyId}`, `workflow-${id}`, now, `event-${id}`);
        db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, pane_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'codex', ?, 'ready', ?, ?)").run(sessionId, taskId, role, `pane-${id}`, now, now);
        if (!options.executionStatus) return;
        const ledger = role === "builder" ? "developer" : "agent";
        if (ledger === "developer") {
          db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)").run(executionId, taskId, companyId, `workflow-${id}`, options.executionStatus, `forge/${id}`, `/worktrees/${id}`, "a".repeat(40), now);
        } else {
          db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)").run(executionId, taskId, companyId, `workflow-${id}`, role, options.executionStatus, now);
        }
        if (options.turnStatus) {
          db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, prompt_sent_at, result_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'fixture', ?, ?, 0, ?, ?, ?, ?, ?)").run(`turn-${id}`, taskId, sessionId, role, ledger, executionId, "b".repeat(64), `results/${id}.json`, options.turnStatus, now, options.turnStatus === "completed" ? "c".repeat(64) : null, now, now);
        }
      };

      addTask("completed", "planner", { executionStatus: "completed", turnStatus: "completed" });
      addTask("cancelled", "builder", { executionStatus: "cancelled", turnStatus: "waiting" });
      addTask("active-live", "planner", { executionStatus: "running", turnStatus: "waiting" });
      addTask("active-missing", "builder", { executionStatus: "running", turnStatus: "waiting" });
      addTask("archived", "reviewer", { archived: true, executionStatus: "running", turnStatus: "waiting" });
      addTask("idle-live", "reviewer");
      addTask("other-company", "integrator", { companyId: "company-b", executionStatus: "running", turnStatus: "waiting" });
    });

    const runtime = await projectAgentRuntime(database, { runtimeSnapshot: async () => ({
      agents: [
        { name: "planner", paneId: "pane-active-live", status: "working" },
        { name: "reviewer", paneId: "pane-archived", status: "working" },
        { name: "reviewer", paneId: "pane-idle-live", status: "idle" },
        { name: "integrator", paneId: "pane-other-company", status: "working" },
      ],
      panes: [
        { paneId: "pane-active-live", agent: "planner", agentStatus: "working" },
        { paneId: "pane-archived", agent: "reviewer", agentStatus: "working" },
        { paneId: "pane-idle-live", agent: "reviewer", agentStatus: "idle" },
        { paneId: "pane-other-company", agent: "integrator", agentStatus: "working" },
      ],
    }) } as never, ["shared-agent"], ["company-a"]);

    expect(runtime).toHaveLength(3);
    expect(runtime).toMatchObject([
      { taskId: "task-active-live", role: "planner", paneId: "pane-active-live", liveStatus: "active", diagnosis: "working" },
      { taskId: "task-active-missing", role: "builder", paneId: "pane-active-missing", liveStatus: "missing", diagnosis: "recovering_runtime" },
      { taskId: "task-idle-live", role: "reviewer", paneId: "pane-idle-live", liveStatus: "active", diagnosis: "resting" },
    ]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shares a runtime snapshot within the five-second cache window", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-agent-runtime-memo-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    const runtimeSnapshot = vi.fn(async () => ({ agents: [], panes: [] }));
    const herdr = { runtimeSnapshot } as never;
    await Promise.all([
      projectAgentRuntime(database, herdr, ["agent-a"], ["company-a"]),
      projectAgentRuntime(database, herdr, ["agent-a"], ["company-a"]),
    ]);
    expect(runtimeSnapshot).toHaveBeenCalledOnce();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { reconcileDeveloperExecutions } from "../src/developer-recovery.js";
import { observeHerdrSessions, reconcileHerdrSessions } from "../src/herdr-recovery.js";
import type { HerdrAgent, HerdrClient, HerdrRuntimeSnapshot, Pane } from "../src/herdr-client.js";

const stamp = "2026-08-24T00:00:00.000Z";

class FakeHerdrClient {
  agents: HerdrAgent[] = [];
  panes: Pane[] = [];
  runtimeSnapshotCalls = 0;
  closedTabs: string[] = [];

  async runtimeSnapshot(): Promise<HerdrRuntimeSnapshot> {
    this.runtimeSnapshotCalls += 1;
    return { agents: this.agents, panes: this.panes };
  }
  async getTab(id: string) { return id === "tab" ? { tabId: id, workspaceId: "workspace", label: "TASK" } : null; }
  async closeTab(id: string) { this.closedTabs.push(id); }
}

async function fixture(phase = "planning") {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-recovery-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(stamp, stamp);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief.md', ?)").run("b".repeat(64), stamp);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("a".repeat(64), stamp, stamp);
    db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task', 'company', 'project', 'workflow', 3, ?, 'lead', '[]', 'Planning', ?, 'workflow:3')").run(phase, stamp);
    db.prepare("INSERT INTO forge_herdr_project_workspaces (project_id, workspace_label, workspace_id, state, created_at, updated_at) VALUES ('project', 'project', 'workspace', 'open', ?, ?)").run(stamp, stamp);
    db.prepare("INSERT INTO forge_herdr_task_tabs (task_id, project_id, workspace_id, tab_label, tab_id, shell_pane_id, state, created_at, updated_at) VALUES ('task', 'project', 'workspace', 'TASK', 'tab', 'shell', 'open', ?, ?)").run(stamp, stamp);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, status, last_agent_status, last_seen_at, created_at, updated_at) VALUES ('session', 'task', 'planner', 1, 1, 'codex', 'codex-session', 'task-planner', 'pane-old', 'working', 'recorded', ?, ?, ?)").run(stamp, stamp, stamp);
  });
  return { root, database };
}

function liveMirrors(database: ForgeDatabase) {
  return database.authQuery((db) => db.prepare("SELECT status, last_agent_status AS lastAgentStatus, last_seen_at AS lastSeenAt, updated_at AS updatedAt FROM forge_herdr_role_sessions WHERE id = 'session'").get());
}

function liveRuntime(status: string, name = "renamed-planner"): { agents: HerdrAgent[]; panes: Pane[] } {
  return {
    agents: [{ name, paneId: "pane-old", tabId: "tab", workspaceId: "workspace", agentSession: "native-session", status }],
    panes: [{ paneId: "pane-old", tabId: "tab", workspaceId: "workspace", agent: name, agentSession: "native-session", agentStatus: status, tokens: { forge_binding_id: "session" } }],
  };
}

test("live and missing observations never rewrite historical liveness columns", async () => {
  for (const lifecycle of ["active", "working", "idle", "blocked", "done"] as const) {
    const value = await fixture();
    const herdr = new FakeHerdrClient();
    Object.assign(herdr, liveRuntime(lifecycle));
    const before = liveMirrors(value.database);
    try {
      await expect(observeHerdrSessions(value.database, herdr as unknown as HerdrClient)).resolves.toMatchObject([{
        sessionId: "session",
        paneId: "pane-old",
        agentName: "renamed-planner",
        nativeSessionId: "native-session",
        lifecycleStatus: lifecycle,
        classification: "active",
      }]);
      expect(liveMirrors(value.database)).toEqual(before);
    } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
  }

  const value = await fixture();
  const herdr = new FakeHerdrClient();
  herdr.panes = [{ paneId: "pane-old", tabId: "tab", workspaceId: "workspace", tokens: { forge_binding_id: "session" } }];
  const before = liveMirrors(value.database);
  try {
    await expect(observeHerdrSessions(value.database, herdr as unknown as HerdrClient)).resolves.toMatchObject([{ sessionId: "session", classification: "missing", lifecycleStatus: null }]);
    expect(liveMirrors(value.database)).toEqual(before);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("an unreachable runtime is unverifiable and does not rewrite live mirrors", async () => {
  const value = await fixture();
  const herdr = new FakeHerdrClient();
  herdr.runtimeSnapshot = async () => { throw new Error("socket unavailable"); };
  Object.assign(herdr, { listAgents: async () => { throw new Error("socket unavailable"); } });
  const before = liveMirrors(value.database);
  try {
    await expect(observeHerdrSessions(value.database, herdr as unknown as HerdrClient)).resolves.toMatchObject([{ classification: "unverifiable", paneId: "pane-old" }]);
    expect(liveMirrors(value.database)).toEqual(before);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("pane identity wins over mutable names and missing metadata remains legacy-compatible", async () => {
  const value = await fixture();
  const herdr = new FakeHerdrClient();
  herdr.agents = [
    { name: "task-planner", paneId: "wrong-pane", status: "working" },
    { name: "renamed-planner", paneId: "pane-old", agentSession: "native-session", status: "idle" },
  ];
  herdr.panes = [
    { paneId: "wrong-pane", agent: "task-planner", agentStatus: "working", tokens: { forge_binding_id: "other-session" } },
    { paneId: "pane-old", tabId: "tab", agent: "renamed-planner", agentStatus: "idle", tokens: {} },
  ];
  try {
    const [observation] = await observeHerdrSessions(value.database, herdr as unknown as HerdrClient);
    expect(observation).toMatchObject({
      sessionId: "session",
      paneId: "pane-old",
      agentName: "renamed-planner",
      nativeSessionId: "native-session",
      lifecycleStatus: "idle",
      classification: "active",
      identityFailure: null,
    });
    expect(observation?.liveAgent?.paneId).toBe("pane-old");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a conflicting Forge binding token fails closed without rewriting the role session", async () => {
  const value = await fixture();
  const herdr = new FakeHerdrClient();
  Object.assign(herdr, liveRuntime("working"));
  herdr.panes[0]!.tokens = { forge_binding_id: "different-session" };
  const before = liveMirrors(value.database);
  value.database.authQuery((db) => {
    db.prepare("UPDATE forge_herdr_role_sessions SET session_role = 'builder' WHERE id = 'session'").run();
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at) VALUES ('execution', 'task', 'company', 'workflow', 3, 1, 'running', 'forge/task', '/worktrees/task', ?, 'session', ?)").run("d".repeat(40), stamp);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn', 'task', 'session', 'builder', 'developer', 'execution', 'implementation', ?, 'result.json', 0, 'waiting', ?, ?)").run("e".repeat(64), stamp, stamp);
  });
  try {
    await expect(observeHerdrSessions(value.database, herdr as unknown as HerdrClient)).resolves.toMatchObject([{
      sessionId: "session",
      classification: "failed",
      identityFailure: "binding-token-conflict",
    }]);
    expect(liveMirrors(value.database)).toEqual(before);
    await expect(reconcileDeveloperExecutions(value.database, herdr as unknown as HerdrClient)).resolves.toEqual([{
      executionId: "execution",
      status: "failed",
      reason: "herdr-binding-conflict",
    }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code AS failureCode FROM forge_developer_executions WHERE id = 'execution'").get())).toEqual({
      status: "failed",
      failureCode: "developer-session-identity-conflict",
    });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a transiently missing runtime leaves durable Developer intent recoverable", async () => {
  const value = await fixture();
  const herdr = new FakeHerdrClient();
  herdr.panes = [{ paneId: "pane-old", tabId: "tab", tokens: { forge_binding_id: "session" } }];
  value.database.authQuery((db) => {
    db.prepare("UPDATE forge_herdr_role_sessions SET session_role = 'builder' WHERE id = 'session'").run();
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at) VALUES ('execution', 'task', 'company', 'workflow', 3, 1, 'running', 'forge/task', '/worktrees/task', ?, 'session', ?)").run("d".repeat(40), stamp);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn', 'task', 'session', 'builder', 'developer', 'execution', 'implementation', ?, 'result.json', 0, 'waiting', ?, ?)").run("e".repeat(64), stamp, stamp);
  });
  try {
    await expect(reconcileDeveloperExecutions(value.database, herdr as unknown as HerdrClient)).resolves.toEqual([{
      executionId: "execution",
      status: "recoverable",
      reason: "herdr-runtime-missing",
    }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code AS failureCode, finished_at AS finishedAt FROM forge_developer_executions WHERE id = 'execution'").get())).toEqual({
      status: "running",
      failureCode: null,
      finishedAt: null,
    });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("terminal projections close tabs, while failed tabs remain available", async () => {
  const done = await fixture("done");
  const failed = await fixture("failed");
  const doneHerdr = new FakeHerdrClient();
  const failedHerdr = new FakeHerdrClient();
  try {
    await reconcileHerdrSessions(done.database, doneHerdr as unknown as HerdrClient);
    await reconcileHerdrSessions(failed.database, failedHerdr as unknown as HerdrClient);
    expect(doneHerdr.closedTabs).toEqual(["tab"]);
    expect(failedHerdr.closedTabs).toEqual([]);
  } finally {
    done.database.close(); failed.database.close();
    await rm(done.root, { recursive: true, force: true }); await rm(failed.root, { recursive: true, force: true });
  }
});

test("compatibility cleanup closes old terminal sessions without taking a runtime snapshot", async () => {
  const value = await fixture("failed");
  const herdr = new FakeHerdrClient();
  try {
    value.database.authQuery((db) => {
      db.prepare("UPDATE forge_issue_projections SET state_changed_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE task_id = 'task'").run();
      db.prepare("UPDATE forge_herdr_role_sessions SET updated_at = datetime('now') WHERE id = 'session'").run();
    });
    await expect(reconcileHerdrSessions(value.database, herdr as unknown as HerdrClient)).resolves.toEqual([]);
    expect(herdr.runtimeSnapshotCalls).toBe(0);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ status: "closed" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

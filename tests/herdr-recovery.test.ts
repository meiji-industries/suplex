import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AttentionService } from "../src/attention.js";
import { ForgeDatabase } from "../src/database.js";
import { reconcileHerdrSessions } from "../src/herdr-recovery.js";
import { HerdrSessionStore } from "../src/herdr-session-store.js";
import type { HerdrAgent, HerdrClient, Pane } from "../src/herdr-client.js";

const stamp = "2026-08-24T00:00:00.000Z";

class FakeHerdrClient {
  readonly agents = new Map<string, HerdrAgent>();
  readonly prompts: string[] = [];
  readonly getAgentCalls: string[] = [];
  readonly starts: Array<{ name: string; args: string[] }> = [];
  readonly panes = new Set(["shell"]);
  listAgentCalls = 0;
  closedTabs: string[] = [];
  nextPane = 1;

  async getAgent(name: string) { this.getAgentCalls.push(name); return this.agents.get(name) ?? null; }
  async listAgents() { this.listAgentCalls += 1; return [...this.agents.values()]; }
  async getWorkspace(id: string) { return id === "workspace" ? { workspaceId: id, label: "project" } : null; }
  async getTab(id: string) { return id === "tab" ? { tabId: id, workspaceId: "workspace", label: "TASK" } : null; }
  async getPane(id: string) { return this.panes.has(id) ? { paneId: id, tabId: "tab", workspaceId: "workspace" } : null; }
  async splitPane(): Promise<Pane> { const paneId = `pane-${this.nextPane++}`; this.panes.add(paneId); return { paneId, tabId: "tab", workspaceId: "workspace" }; }
  async renamePane() {}
  async runPaneCommand(_paneId: string, command: string) {
    const readinessPath = command.match(/FORGE_HERDR_READINESS_SENTINEL='([^']+)'/)?.[1];
    if (readinessPath) await writeFile(readinessPath, "ok");
  }
  async closePane(id: string) { this.panes.delete(id); }
  async closeTab(id: string) { this.closedTabs.push(id); }
  async startAgent(input: { name: string; paneId: string; kind: "codex"; args: string[] }) {
    this.starts.push({ name: input.name, args: input.args });
    const live = { name: input.name, paneId: input.paneId, tabId: "tab", workspaceId: "workspace", agentSession: input.args.at(-1) ?? "fresh-session", status: "working" };
    this.agents.set(live.name, live);
    return live;
  }
  async prompt(_name: string, text: string) { this.prompts.push(text); return this.agents.get(_name)!; }
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
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, status, created_at, updated_at) VALUES ('session', 'task', 'planner', 1, 1, 'codex', 'codex-session', 'task-planner', 'pane-old', 'working', ?, ?)").run(stamp, stamp);
  });
  return { root, database };
}

test("worker restart re-finds an agent by durable name", async () => {
  const value = await fixture();
  const herdr = new FakeHerdrClient();
  herdr.agents.set("task-planner", { name: "task-planner", paneId: "pane-old", tabId: "tab", workspaceId: "workspace", agentSession: "codex-session", status: "working" });
  try {
    await expect(reconcileHerdrSessions(value.database, herdr as unknown as HerdrClient)).resolves.toContainEqual({ sessionId: "session", taskId: "task", status: "active" });
    expect(herdr.starts).toEqual([]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("idle and done agents reconcile as ready while preserving their raw status", async () => {
  for (const status of ["idle", "done"] as const) {
    const value = await fixture();
    const herdr = new FakeHerdrClient();
    herdr.agents.set("task-planner", { name: "task-planner", paneId: "pane-old", tabId: "tab", workspaceId: "workspace", agentSession: "codex-session", status });
    try {
      await expect(reconcileHerdrSessions(value.database, herdr as unknown as HerdrClient)).resolves.toContainEqual({ sessionId: "session", taskId: "task", status: "active" });
      expect(value.database.authQuery((db) => db.prepare("SELECT status, last_agent_status FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ status: "ready", last_agent_status: status });
    } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
  }
});

test("a missing agent recreates its pane, resumes the session, and sends one interruption prompt per generation", async () => {
  const value = await fixture();
  const herdr = new FakeHerdrClient();
  try {
    await reconcileHerdrSessions(value.database, herdr as unknown as HerdrClient);
    const sessions = new HerdrSessionStore(value.database, herdr as unknown as HerdrClient);
    const first = await sessions.ensureRoleSession({ taskId: "task", projectId: "project", projectSlug: "project", issueKey: "TASK", worktreePath: "/worktree", runtimeRoot: value.root }, "planner", { model: "gpt", reasoningLevel: "high", serviceTier: "priority" });
    await herdr.prompt(first.agentName, "You were interrupted. Continue the current Forge turn.");
    herdr.agents.delete(first.agentName);
    await reconcileHerdrSessions(value.database, herdr as unknown as HerdrClient);
    const second = await sessions.ensureRoleSession({ taskId: "task", projectId: "project", projectSlug: "project", issueKey: "TASK", worktreePath: "/worktree", runtimeRoot: value.root }, "planner", { model: "gpt", reasoningLevel: "high", serviceTier: "priority" });
    await herdr.prompt(second.agentName, "You were interrupted. Continue the current Forge turn.");
    expect(herdr.starts).toHaveLength(2);
    expect(herdr.starts.every((start) => start.args.includes("resume") && start.args.includes("codex-session"))).toBe(true);
    expect(herdr.prompts).toHaveLength(2);
    expect(second.generation).toBe(first.generation + 1);
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

test("closes old finished-task sessions even when the session was just observed", async () => {
  const value = await fixture("failed");
  const herdr = new FakeHerdrClient();
  try {
    value.database.authQuery((db) => {
      db.prepare("UPDATE forge_issue_projections SET state_changed_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE task_id = 'task'").run();
      db.prepare("UPDATE forge_herdr_role_sessions SET updated_at = datetime('now') WHERE id = 'session'").run();
    });
    await expect(reconcileHerdrSessions(value.database, herdr as unknown as HerdrClient)).resolves.toEqual([]);
    expect(herdr.getAgentCalls).toEqual([]);
    expect(herdr.listAgentCalls).toBe(0);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ status: "closed" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a blocked role session is an attention row without Forge actions", async () => {
  const value = await fixture();
  const herdr = new FakeHerdrClient();
  herdr.agents.set("task-planner", { name: "task-planner", paneId: "pane-old", tabId: "tab", workspaceId: "workspace", agentSession: "codex-session", status: "blocked" });
  try {
    await reconcileHerdrSessions(value.database, herdr as unknown as HerdrClient);
    const attention = new AttentionService(value.database, { listVisibleCompanies() { return [{ id: "company", name: "Company", status: "active" }]; } } as never).list("member");
    expect(attention[0]).toMatchObject({ attentionCount: 1, attention: [{ summary: "Agent needs you in pane-old (task-planner)", actions: [] }] });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

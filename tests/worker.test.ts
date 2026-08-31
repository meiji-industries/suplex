import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { HerdrClient, HerdrRuntimeSnapshot } from "../src/herdr-client.js";
import { convergeOrphanedHerdrExecutions, reclaimOrphanedHerdrExecutions, recoverOrphanedHerdrExecutions, startEngineHost } from "../src/worker.js";

const stamp = "2026-08-30T12:00:00.000Z";

async function startupFixture(taskIds: string[]) {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-startup-test-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(stamp, stamp);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
    taskIds.forEach((taskId, index) => {
      const workflowId = `workflow-${taskId}`;
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES (?, 'company', 'project', ?, 'brief', '[]', '{}', 0, ?, 'revision', ?, ?, ?, ?)").run(taskId, taskId, workflowId, `key-${taskId}`, index.toString(16).padStart(64, "0"), stamp, stamp);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES (?, 'company', 'project', ?, 1, 'reviewing_delivery', 'lead', '[]', 'Reviewing delivery', ?, ?)").run(taskId, workflowId, stamp, `${workflowId}:1`);
    });
  });
  return { root, config, database };
}

function bindAgentExecution(database: ForgeDatabase, input: { taskId: string; executionId: string; sessionId: string; paneId: string; role?: "planner" | "reviewer" | "integrator"; status?: "starting" | "running" | "failed"; turnStatus?: "waiting" | "blocked" | "completed"; mirroredSessionStatus?: "working" | "blocked" | "missing" | "closed" | "failed" }): void {
  const role = input.role ?? "reviewer";
  const status = input.status ?? "running";
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, finished_at, failure_code, failure_summary) VALUES (?, ?, 'company', ?, ?, ?, 1, ?, ?, ?, ?)").run(input.executionId, input.taskId, `workflow-${input.taskId}`, role, status, stamp, status === "failed" ? stamp : null, status === "failed" ? "worker-restart-orphan" : null, status === "failed" ? "worker stopped" : null);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, agent_name, pane_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'codex', ?, ?, ?, ?, ?)").run(input.sessionId, input.taskId, role, `${input.taskId}-${role}`, input.paneId, input.mirroredSessionStatus ?? "working", stamp, stamp);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'agent', ?, 'delivery-review', ?, ?, 0, ?, ?, ?)").run(`turn-${input.executionId}`, input.taskId, input.sessionId, role, input.executionId, "b".repeat(64), `results/${input.executionId}.json`, input.turnStatus ?? "completed", stamp, stamp);
  });
}

function bindDeveloperExecution(database: ForgeDatabase, input: { taskId: string; executionId: string; sessionId: string; paneId: string; status: "running" | "failed" }): void {
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, finished_at, failure_code, failure_summary) VALUES (?, ?, 'company', ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.executionId, input.taskId, `workflow-${input.taskId}`, input.status, `forge/${input.taskId}`, `/worktrees/${input.taskId}`, "c".repeat(40), stamp, input.status === "failed" ? stamp : null, input.status === "failed" ? "worker-restart-orphan" : null, input.status === "failed" ? "worker stopped" : null);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, agent_name, pane_id, status, created_at, updated_at) VALUES (?, ?, 'builder', 1, 1, 'codex', ?, ?, 'closed', ?, ?)").run(input.sessionId, input.taskId, `${input.taskId}-builder`, input.paneId, stamp, stamp);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES (?, ?, ?, 'builder', 'developer', ?, 'implementation', ?, ?, 0, 'waiting', ?, ?)").run(`turn-${input.executionId}`, input.taskId, input.sessionId, input.executionId, "d".repeat(64), `results/${input.executionId}.json`, stamp, stamp);
  });
}

function insertReviewAttempt(database: ForgeDatabase, input: { id: string; taskId: string; executionId: string; sessionId: string; status: "running" | "failed" | "blocked" | "completed"; failureCode?: string | null; failureSummary?: string | null; finishedAt?: string | null }): void {
  database.authTransaction((db) => db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, lead_session_ref, status, correction_attempts, failure_code, failure_summary, created_at, finished_at) VALUES (?, ?, 'company', ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)").run(input.id, input.taskId, `workflow-${input.taskId}`, "e".repeat(40), "f".repeat(40), "1".repeat(40), input.executionId, input.sessionId, input.status, input.failureCode ?? null, input.failureSummary ?? null, stamp, input.finishedAt ?? null));
}

function runtimeSnapshot(bindings: Array<{ sessionId: string; paneId: string; status: string }>): HerdrRuntimeSnapshot {
  return {
    agents: bindings.map((binding) => ({ name: `agent-${binding.sessionId}`, paneId: binding.paneId, status: binding.status })),
    panes: bindings.map((binding) => ({ paneId: binding.paneId, agent: `agent-${binding.sessionId}`, agentStatus: binding.status, tokens: { forge_binding_id: binding.sessionId } })),
  };
}

const silentLogger = { info() {}, warn() {} };

test("reclaims non-terminal agent and developer execution ledgers after a worker restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-reclaim-test-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  const startedAt = "2026-08-24T12:00:00.000Z";
  const finishedAt = "2026-08-24T12:01:00.000Z";
  const reclaimedAt = "2026-08-24T12:02:00.000Z";
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(startedAt);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(startedAt, startedAt);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?)").run("a".repeat(64), startedAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), startedAt, startedAt);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('agent-orphan', 'task', 'company', 'workflow', 'planner', 'starting', 1, ?)").run(startedAt);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, finished_at) VALUES ('agent-terminal', 'task', 'company', 'workflow', 'planner', 'completed', 2, ?, ?)").run(startedAt, finishedAt);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer-orphan', 'task', 'company', 'workflow', 1, 1, 'running', 'forge/task', '/worktrees/task', ?, ?)").run("c".repeat(40), startedAt);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, finished_at) VALUES ('developer-terminal', 'task', 'company', 'workflow', 1, 2, 'completed', 'forge/task', '/worktrees/task', ?, ?, ?)").run("c".repeat(40), startedAt, finishedAt);
    });

    expect(reclaimOrphanedHerdrExecutions(database, new Set(), reclaimedAt)).toEqual({ agentExecutions: 1, developerExecutions: 1 });
    expect(database.authQuery((db) => db.prepare("SELECT id, status, failure_code, finished_at FROM forge_agent_executions ORDER BY id").all())).toEqual([
      { id: "agent-orphan", status: "failed", failure_code: "worker-restart-orphan", finished_at: reclaimedAt },
      { id: "agent-terminal", status: "completed", failure_code: null, finished_at: finishedAt },
    ]);
    expect(database.authQuery((db) => db.prepare("SELECT id, status, failure_code, finished_at FROM forge_developer_executions ORDER BY id").all())).toEqual([
      { id: "developer-orphan", status: "failed", failure_code: "worker-restart-orphan", finished_at: reclaimedAt },
      { id: "developer-terminal", status: "completed", failure_code: null, finished_at: finishedAt },
    ]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses explicit recoverable bindings instead of mirrored role-session status", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-recovery-test-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  const now = new Date().toISOString();
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('execution', 'task', 'company', 'workflow', 'planner', 'running', 1, ?)").run(now);
      db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, status, created_at, updated_at) VALUES ('session', 'task', 'planner', 1, 1, 'codex', 'codex', 'planner', 'pane', 'working', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn', 'task', 'session', 'planner', 'agent', 'execution', 'plan', ?, 'result.json', 0, 'waiting', ?, ?)").run("c".repeat(64), now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer-execution', 'task', 'company', 'workflow', 1, 1, 'running', 'forge/task', '/worktrees/task', ?, ?)").run("d".repeat(40), now);
      db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, status, created_at, updated_at) VALUES ('developer-session', 'task', 'builder', 1, 1, 'codex', 'developer-codex', 'builder', 'developer-pane', 'working', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('developer-turn', 'task', 'developer-session', 'builder', 'developer', 'developer-execution', 'implementation', ?, 'developer-result.json', 0, 'waiting', ?, ?)").run("e".repeat(64), now, now);
    });
    const recoverableBindings = new Set(["session", "developer-session"]);
    database.authQuery((db) => {
      db.prepare("UPDATE forge_herdr_role_sessions SET status = 'missing' WHERE id = 'session'").run();
      db.prepare("UPDATE forge_herdr_role_sessions SET status = 'closed' WHERE id = 'developer-session'").run();
    });
    expect(reclaimOrphanedHerdrExecutions(database, recoverableBindings, now)).toEqual({ agentExecutions: 0, developerExecutions: 0 });
    database.authQuery((db) => {
      db.prepare("UPDATE forge_agent_executions SET status = 'failed', failure_code = 'worker-restart-orphan', finished_at = ? WHERE id = 'execution'").run(now);
      db.prepare("UPDATE forge_developer_executions SET status = 'failed', failure_code = 'worker-restart-orphan', finished_at = ? WHERE id = 'developer-execution'").run(now);
    });
    expect(recoverOrphanedHerdrExecutions(database, recoverableBindings)).toEqual({ agentExecutions: 1, developerExecutions: 1 });
    expect(database.authQuery((db) => db.prepare("SELECT status, failure_code, finished_at FROM forge_agent_executions WHERE id = 'execution'").get())).toEqual({ status: "running", failure_code: null, finished_at: null });
    expect(database.authQuery((db) => db.prepare("SELECT status, failure_code, finished_at FROM forge_developer_executions WHERE id = 'developer-execution'").get())).toEqual({ status: "running", failure_code: null, finished_at: null });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("startup converges terminal Herdr state before issue runs can resume", async () => {
  const value = await startupFixture(["terminal-task"]);
  bindAgentExecution(value.database, { taskId: "terminal-task", executionId: "terminal-execution", sessionId: "terminal-session", paneId: "terminal-pane", status: "running", turnStatus: "completed" });
  insertReviewAttempt(value.database, { id: "terminal-attempt", taskId: "terminal-task", executionId: "terminal-execution", sessionId: "terminal-session", status: "running" });
  const events: string[] = [];
  let snapshots = 0;
  const herdr = {
    async runtimeSnapshot() {
      snapshots += 1;
      events.push("snapshot");
      return runtimeSnapshot([{ sessionId: "terminal-session", paneId: "terminal-pane", status: "done" }]);
    },
  } as unknown as HerdrClient;
  try {
    const engine = await startEngineHost(value.config, value.database, {
      herdr,
      logger: silentLogger,
      schedule() {},
      async loadRuns() {
        events.push("load-runs");
        expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_agent_executions WHERE id = 'terminal-execution'").get())).toEqual({ status: "failed", failure_code: "worker-restart-orphan" });
        expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, failure_summary, finished_at FROM forge_delivery_review_attempts WHERE id = 'terminal-attempt'").get())).toMatchObject({ status: "failed", failure_code: "process-failed", failure_summary: expect.any(String), finished_at: expect.any(String) });
        expect(() => value.database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('replacement-execution', 'terminal-task', 'company', 'workflow-terminal-task', 'reviewer', 'starting', 2, ?)").run(stamp))).not.toThrow();
        return 1;
      },
    });
    engine.dispose();
    expect(snapshots).toBe(1);
    expect(events).toEqual(["snapshot", "load-runs"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("live identity-valid Herdr processes preserve and recover agent and developer executions", async () => {
  const value = await startupFixture(["live-agent", "orphan-agent", "orphan-developer"]);
  bindAgentExecution(value.database, { taskId: "live-agent", executionId: "live-agent-execution", sessionId: "live-agent-session", paneId: "live-agent-pane", status: "running", turnStatus: "waiting", mirroredSessionStatus: "closed" });
  bindAgentExecution(value.database, { taskId: "orphan-agent", executionId: "orphan-agent-execution", sessionId: "orphan-agent-session", paneId: "orphan-agent-pane", status: "failed", turnStatus: "waiting", mirroredSessionStatus: "failed" });
  bindDeveloperExecution(value.database, { taskId: "orphan-developer", executionId: "orphan-developer-execution", sessionId: "orphan-developer-session", paneId: "orphan-developer-pane", status: "failed" });
  insertReviewAttempt(value.database, { id: "orphan-agent-attempt", taskId: "orphan-agent", executionId: "orphan-agent-execution", sessionId: "orphan-agent-session", status: "failed", failureCode: "worker-restart-orphan", failureSummary: "worker stopped", finishedAt: stamp });
  let snapshots = 0;
  const herdr = { async runtimeSnapshot() { snapshots += 1; return runtimeSnapshot([
    { sessionId: "live-agent-session", paneId: "live-agent-pane", status: "working" },
    { sessionId: "orphan-agent-session", paneId: "orphan-agent-pane", status: "idle" },
    { sessionId: "orphan-developer-session", paneId: "orphan-developer-pane", status: "blocked" },
  ]); } } as unknown as HerdrClient;
  try {
    await expect(convergeOrphanedHerdrExecutions(value.database, herdr, silentLogger)).resolves.toEqual({
      reclaimed: { agentExecutions: 0, developerExecutions: 0 },
      recovered: { agentExecutions: 1, developerExecutions: 1 },
    });
    expect(snapshots).toBe(1);
    expect(value.database.authQuery((db) => db.prepare("SELECT id, status, failure_code, failure_summary, finished_at FROM forge_agent_executions ORDER BY id").all())).toEqual([
      { id: "live-agent-execution", status: "running", failure_code: null, failure_summary: null, finished_at: null },
      { id: "orphan-agent-execution", status: "running", failure_code: null, failure_summary: null, finished_at: null },
    ]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, failure_summary, finished_at FROM forge_developer_executions WHERE id = 'orphan-developer-execution'").get())).toEqual({ status: "running", failure_code: null, failure_summary: null, finished_at: null });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, failure_summary, finished_at FROM forge_delivery_review_attempts WHERE id = 'orphan-agent-attempt'").get())).toEqual({ status: "running", failure_code: null, failure_summary: null, finished_at: null });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("startup convergence ignores an older failed execution when a newer turn in its role session is active", async () => {
  const value = await startupFixture(["shared-session-task"]);
  bindAgentExecution(value.database, { taskId: "shared-session-task", executionId: "older-execution", sessionId: "shared-session", paneId: "shared-pane", role: "integrator", status: "failed", turnStatus: "waiting", mirroredSessionStatus: "failed" });
  value.database.authTransaction((db) => {
    const later = "2026-08-30T12:01:00.000Z";
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('newer-execution', 'shared-session-task', 'company', 'workflow-shared-session-task', 'integrator', 'starting', 2, ?)").run(later);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn-newer-execution', 'shared-session-task', 'shared-session', 'integrator', 'agent', 'newer-execution', 'delivery-review', ?, 'results/newer-execution.json', 0, 'waiting', ?, ?)").run("2".repeat(64), later, later);
  });
  const herdr = { async runtimeSnapshot() { return runtimeSnapshot([{ sessionId: "shared-session", paneId: "shared-pane", status: "idle" }]); } } as unknown as HerdrClient;
  try {
    await expect(convergeOrphanedHerdrExecutions(value.database, herdr, silentLogger)).resolves.toEqual({
      reclaimed: { agentExecutions: 0, developerExecutions: 0 },
      recovered: { agentExecutions: 0, developerExecutions: 0 },
    });
    expect(value.database.authQuery((db) => db.prepare("SELECT id, status, failure_code FROM forge_agent_executions ORDER BY id").all())).toEqual([
      { id: "newer-execution", status: "starting", failure_code: null },
      { id: "older-execution", status: "failed", failure_code: "worker-restart-orphan" },
    ]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("the compatibility agent-list snapshot fallback preserves an observed live execution", async () => {
  const value = await startupFixture(["fallback-task"]);
  bindAgentExecution(value.database, { taskId: "fallback-task", executionId: "fallback-execution", sessionId: "fallback-session", paneId: "fallback-pane", role: "planner", turnStatus: "waiting" });
  let snapshots = 0;
  let fallbackLists = 0;
  const herdr = {
    async runtimeSnapshot(): Promise<HerdrRuntimeSnapshot> { snapshots += 1; throw new Error("snapshot method unavailable"); },
    async listAgents() { fallbackLists += 1; return [{ name: "fallback-agent", paneId: "fallback-pane", status: "unknown" }]; },
  } as unknown as HerdrClient;
  try {
    await expect(convergeOrphanedHerdrExecutions(value.database, herdr, silentLogger)).resolves.toEqual({
      reclaimed: { agentExecutions: 0, developerExecutions: 0 },
      recovered: { agentExecutions: 0, developerExecutions: 0 },
    });
    expect({ snapshots, fallbackLists }).toEqual({ snapshots: 1, fallbackLists: 1 });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_agent_executions WHERE id = 'fallback-execution'").get())).toEqual({ status: "running", failure_code: null });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a live reused role pane does not preserve an execution whose own linked turn completed", async () => {
  const value = await startupFixture(["reused-pane-task"]);
  bindAgentExecution(value.database, { taskId: "reused-pane-task", executionId: "stale-execution", sessionId: "shared-session", paneId: "shared-pane", status: "running", turnStatus: "completed" });
  value.database.authTransaction((db) => {
    const later = "2026-08-30T12:01:00.000Z";
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, finished_at, failure_code, failure_summary) VALUES ('later-execution', 'reused-pane-task', 'company', 'workflow-reused-pane-task', 'reviewer', 'failed', 2, ?, ?, 'worker-restart-orphan', 'worker stopped')").run(later, later);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn-later-execution', 'reused-pane-task', 'shared-session', 'reviewer', 'agent', 'later-execution', 'delivery-review', ?, 'results/later-execution.json', 0, 'waiting', ?, ?)").run("2".repeat(64), later, later);
  });
  insertReviewAttempt(value.database, { id: "stale-running-attempt", taskId: "reused-pane-task", executionId: "stale-execution", sessionId: "shared-session", status: "running" });
  insertReviewAttempt(value.database, { id: "stale-completed-attempt", taskId: "reused-pane-task", executionId: "stale-execution", sessionId: "shared-session", status: "completed", finishedAt: stamp });
  insertReviewAttempt(value.database, { id: "stale-blocked-attempt", taskId: "reused-pane-task", executionId: "stale-execution", sessionId: "shared-session", status: "blocked", failureCode: "review-blocked", failureSummary: "needs input", finishedAt: stamp });
  insertReviewAttempt(value.database, { id: "later-recovery-attempt", taskId: "reused-pane-task", executionId: "later-execution", sessionId: "shared-session", status: "failed", failureCode: "worker-restart-orphan", failureSummary: "worker stopped", finishedAt: stamp });
  const herdr = { async runtimeSnapshot() { return runtimeSnapshot([{ sessionId: "shared-session", paneId: "shared-pane", status: "idle" }]); } } as unknown as HerdrClient;
  try {
    await expect(convergeOrphanedHerdrExecutions(value.database, herdr, silentLogger)).resolves.toEqual({
      reclaimed: { agentExecutions: 1, developerExecutions: 0 },
      recovered: { agentExecutions: 1, developerExecutions: 0 },
    });
    expect(value.database.authQuery((db) => db.prepare("SELECT id, status, failure_code FROM forge_agent_executions ORDER BY id").all())).toEqual([
      { id: "later-execution", status: "running", failure_code: null },
      { id: "stale-execution", status: "failed", failure_code: "worker-restart-orphan" },
    ]);
    expect(value.database.authQuery((db) => db.prepare("SELECT id, status, failure_code, failure_summary, finished_at FROM forge_delivery_review_attempts ORDER BY id").all())).toEqual([
      { id: "later-recovery-attempt", status: "running", failure_code: null, failure_summary: null, finished_at: null },
      { id: "stale-blocked-attempt", status: "blocked", failure_code: "review-blocked", failure_summary: "needs input", finished_at: stamp },
      { id: "stale-completed-attempt", status: "completed", failure_code: null, failure_summary: null, finished_at: stamp },
      { id: "stale-running-attempt", status: "failed", failure_code: "process-failed", failure_summary: "The delivery review stopped because its linked agent process was not resumable after the Forge worker restarted.", finished_at: expect.any(String) },
    ]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("missing, unbound, and identity-conflicted Herdr processes reclaim stale active executions", async () => {
  const value = await startupFixture(["missing-task", "unbound-task", "conflict-task"]);
  bindAgentExecution(value.database, { taskId: "missing-task", executionId: "missing-execution", sessionId: "missing-session", paneId: "missing-pane", role: "planner" });
  bindAgentExecution(value.database, { taskId: "unbound-task", executionId: "unbound-execution", sessionId: "unbound-session", paneId: "unbound-pane", role: "planner" });
  bindAgentExecution(value.database, { taskId: "conflict-task", executionId: "conflict-execution", sessionId: "conflict-session", paneId: "conflict-pane", role: "planner" });
  value.database.authTransaction((db) => db.prepare("UPDATE forge_herdr_role_sessions SET pane_id = NULL WHERE id = 'unbound-session'").run());
  const snapshot = runtimeSnapshot([{ sessionId: "different-session", paneId: "conflict-pane", status: "working" }]);
  const herdr = { async runtimeSnapshot() { return snapshot; } } as unknown as HerdrClient;
  try {
    await expect(convergeOrphanedHerdrExecutions(value.database, herdr, silentLogger)).resolves.toEqual({
      reclaimed: { agentExecutions: 3, developerExecutions: 0 },
      recovered: { agentExecutions: 0, developerExecutions: 0 },
    });
    expect(value.database.authQuery((db) => db.prepare("SELECT id, status, failure_code FROM forge_agent_executions ORDER BY id").all())).toEqual([
      { id: "conflict-execution", status: "failed", failure_code: "worker-restart-orphan" },
      { id: "missing-execution", status: "failed", failure_code: "worker-restart-orphan" },
      { id: "unbound-execution", status: "failed", failure_code: "worker-restart-orphan" },
    ]);
    expect(() => value.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('missing-replacement', 'missing-task', 'company', 'workflow-missing-task', 'planner', 'starting', 2, ?)").run(stamp))).not.toThrow();
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("linked review-attempt failure and recovery are atomic and preserve terminal attempts", async () => {
  const value = await startupFixture(["review-task"]);
  bindAgentExecution(value.database, { taskId: "review-task", executionId: "review-execution", sessionId: "review-session", paneId: "review-pane", status: "running", turnStatus: "waiting" });
  insertReviewAttempt(value.database, { id: "attempt-running", taskId: "review-task", executionId: "review-execution", sessionId: "review-session", status: "running" });
  insertReviewAttempt(value.database, { id: "attempt-blocked", taskId: "review-task", executionId: "review-execution", sessionId: "review-session", status: "blocked", failureCode: "review-blocked", failureSummary: "needs input", finishedAt: stamp });
  insertReviewAttempt(value.database, { id: "attempt-completed", taskId: "review-task", executionId: "review-execution", sessionId: "review-session", status: "completed", finishedAt: stamp });
  const reclaimedAt = "2026-08-30T12:05:00.000Z";
  try {
    value.database.authTransaction((db) => db.exec("CREATE TRIGGER abort_review_reclaim BEFORE UPDATE OF status ON forge_delivery_review_attempts WHEN OLD.id = 'attempt-running' AND NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'review reclaim rollback'); END"));
    expect(() => reclaimOrphanedHerdrExecutions(value.database, new Set(), reclaimedAt)).toThrow(/review reclaim rollback/);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_agent_executions WHERE id = 'review-execution'").get())).toEqual({ status: "running" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_delivery_review_attempts WHERE id = 'attempt-running'").get())).toEqual({ status: "running" });
    value.database.authTransaction((db) => db.exec("DROP TRIGGER abort_review_reclaim"));

    expect(reclaimOrphanedHerdrExecutions(value.database, new Set(), reclaimedAt)).toEqual({ agentExecutions: 1, developerExecutions: 0 });
    expect(value.database.authQuery((db) => db.prepare("SELECT id, status, failure_code, failure_summary, finished_at FROM forge_delivery_review_attempts ORDER BY id").all())).toEqual([
      { id: "attempt-blocked", status: "blocked", failure_code: "review-blocked", failure_summary: "needs input", finished_at: stamp },
      { id: "attempt-completed", status: "completed", failure_code: null, failure_summary: null, finished_at: stamp },
      { id: "attempt-running", status: "failed", failure_code: "process-failed", failure_summary: "The delivery review stopped because its linked agent process was not resumable after the Forge worker restarted.", finished_at: reclaimedAt },
    ]);

    value.database.authTransaction((db) => db.exec("CREATE TRIGGER abort_review_recovery BEFORE UPDATE OF status ON forge_delivery_review_attempts WHEN OLD.id = 'attempt-running' AND NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'review recovery rollback'); END"));
    expect(() => recoverOrphanedHerdrExecutions(value.database, new Set(["review-session"]))).toThrow(/review recovery rollback/);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_agent_executions WHERE id = 'review-execution'").get())).toEqual({ status: "failed" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_delivery_review_attempts WHERE id = 'attempt-running'").get())).toEqual({ status: "failed" });
    value.database.authTransaction((db) => db.exec("DROP TRIGGER abort_review_recovery"));

    expect(recoverOrphanedHerdrExecutions(value.database, new Set(["review-session"]))).toEqual({ agentExecutions: 1, developerExecutions: 0 });
    expect(value.database.authQuery((db) => db.prepare("SELECT id, status, failure_code, failure_summary, finished_at FROM forge_delivery_review_attempts ORDER BY id").all())).toEqual([
      { id: "attempt-blocked", status: "blocked", failure_code: "review-blocked", failure_summary: "needs input", finished_at: stamp },
      { id: "attempt-completed", status: "completed", failure_code: null, failure_summary: null, finished_at: stamp },
      { id: "attempt-running", status: "running", failure_code: null, failure_summary: null, finished_at: null },
    ]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("snapshot failure skips mutation and startup remains available", async () => {
  const value = await startupFixture(["snapshot-failure-task"]);
  bindAgentExecution(value.database, { taskId: "snapshot-failure-task", executionId: "snapshot-failure-execution", sessionId: "snapshot-failure-session", paneId: "snapshot-failure-pane", role: "planner" });
  let snapshots = 0;
  let fallbackLists = 0;
  let loaded = false;
  const warnings: string[] = [];
  const herdr = {
    async runtimeSnapshot(): Promise<HerdrRuntimeSnapshot> { snapshots += 1; throw new Error("Herdr snapshot unavailable"); },
    async listAgents() { fallbackLists += 1; throw new Error("Herdr unavailable"); },
  } as unknown as HerdrClient;
  const logger = { info() {}, warn(message: string) { warnings.push(message); } };
  try {
    const engine = await startEngineHost(value.config, value.database, {
      herdr,
      logger,
      schedule() {},
      async loadRuns() {
        loaded = true;
        expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_agent_executions WHERE id = 'snapshot-failure-execution'").get())).toEqual({ status: "running", failure_code: null });
        return 0;
      },
    });
    engine.dispose();
    expect(snapshots).toBe(1);
    expect(fallbackLists).toBe(1);
    expect(loaded).toBe(true);
    expect(warnings).toEqual(["Skipping startup execution convergence because Herdr could not be observed"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

import { expect, test } from "vitest";

import { reconcileAgentExecutions } from "../src/agent-recovery.js";
import { CapacityManager } from "../src/capacity.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

const now = new Date().toISOString();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-capacity-test-"));
  const config = createTestConfig(root, { externalTurnCapacity: 2, externalTurnRateLimitAttempts: 2 });
  const database = new ForgeDatabase(config.databasePath);
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project', 'company', 'Project', '/tmp/repo', '/tmp/worktrees', 'main', 'main', 'setup', 'test', '[]', '{}', 'active', 'revision', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('revision', 'project', 1, 'identity', '{}', ?, ?, 'admin', ?)").run("a".repeat(40), "b".repeat(40), now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile', 'Profile', 'codex', 'gpt-5.6-sol', 'medium', 'standard', 2, ?, ?)").run(now, now);
    for (const taskId of ["task-a", "task-b", "task-c", "task-d"]) {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company', 'task-brief', ?, 'text/plain', 1, ?, ?, ?)").run(`brief-${taskId}`, `${taskId}.txt`, "a".repeat(64), `company/${taskId}`, now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, 'company', 'project', ?, ?, '[]', ?, 0, ?, 'revision', ?, ?, ?)").run(taskId, taskId, `brief-${taskId}`, JSON.stringify({ builder: "profile", planner: "profile", reviewer: "profile" }), `workflow-${taskId}`, `key-${taskId}`, now, now);
    }
  });
  return { root, config, database };
}

function input(taskId: string, logicalTurnKey: string, requestedAt?: string, workflowRevision = 0) {
  return { logicalTurnKey, companyId: "company", taskId, workflowId: `workflow-${taskId}`, projectRevisionId: "revision", workflowRevision, operation: "developer_execution" as const, role: "builder" as const, profileId: "profile", ...(requestedAt ? { requestedAt } : {}) };
}

test("admits FIFO requests per profile lane and releases exactly one slot", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const requests = ["task-a", "task-b", "task-c"].map((taskId, index) => capacity.request(input(taskId, `workflow-${taskId}:${index}:developer_execution`, new Date(Date.parse(now) + index * 1_000).toISOString())));
    const [first, second, third] = requests;
    expect(capacity.tryAcquire(first!.id, 0).status).toBe("active");
    expect(capacity.tryAcquire(second!.id, 0).status).toBe("active");
    expect(capacity.tryAcquire(third!.id, 0).status).toBe("queued");
    expect(capacity.position(third!.id)).toBe(1);
    capacity.bindExecution(first!.id, { executionKind: "developer", executionId: "developer-a", worktreePath: "/tmp/a", sessionRef: "session-a" });
    capacity.finalize(first!.id, "developer-a", "completed");
    expect(capacity.tryAcquire(third!.id, 0).status).toBe("active");
    expect(capacity.inspect(first!.id).terminalReason).toBe("completed");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("uses the current host default when an override is cleared", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const first = capacity.request(input("task-a", "default-a"));
    const second = capacity.request(input("task-b", "default-b", new Date(Date.parse(now) + 1_000).toISOString()));
    expect(capacity.tryAcquire(first.id, 0).status).toBe("active");
    value.database.authTransaction((db) => db.prepare("UPDATE forge_profiles SET capacity = NULL WHERE id = 'profile'").run());
    const currentDefault = new CapacityManager(value.database, { ...value.config, externalTurnCapacity: 1 });
    expect(currentDefault.tryAcquire(second.id, 0).status).toBe("queued");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("reclaims an ambiguous admission that never bound an execution", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const request = capacity.request(input("task-a", "unbound-retry"));
    expect(capacity.tryAcquire(request.id, 0).status).toBe("active");
    capacity.markOwnershipAmbiguous(request.id, "worker restarted before execution registration");
    expect(capacity.bindExecution(request.id, { executionKind: "developer", executionId: "developer-retry", worktreePath: "/tmp/retry" })).toMatchObject({ status: "active", executionId: "developer-retry" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("does not release an Agent slot while its execution is cancelling", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const request = capacity.request(input("task-a", "cancelling-agent"));
    expect(capacity.tryAcquire(request.id, 0).status).toBe("active");
    capacity.bindExecution(request.id, { executionKind: "agent", executionId: "agent-cancelling" });
    value.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('agent-cancelling', 'task-a', 'company', 'workflow-task-a', 'planner', 'cancelling', 1, ?)").run(now));
    expect(() => capacity.finalize(request.id, "agent-cancelling", "cancelled")).toThrowError("Capacity request invalid-status");
    expect(capacity.inspect(request.id).status).toBe("active");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("does not release a slot while the bound wrapper is still live", async () => {
  const value = await fixture();
  const wrapperRoot = await mkdtemp(join(tmpdir(), "forge-capacity-wrapper-"));
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const request = capacity.request(input("task-a", "live-wrapper"));
    expect(capacity.tryAcquire(request.id, 0).status).toBe("active");
    capacity.bindExecution(request.id, { executionKind: "agent", executionId: "agent-live" });
    await writeFile(join(wrapperRoot, "state.json"), JSON.stringify({ wrapperPid: 2, wrapperProcessGroupId: 2, wrapperStartIdentity: "2:live", childPid: 3, childProcessGroupId: 3, childStartIdentity: "3:live", heartbeatAt: now, status: "running" }));
    value.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, wrapper_path, started_at) VALUES ('agent-live', 'task-a', 'company', 'workflow-task-a', 'planner', 'failed', 1, ?, ?)").run(wrapperRoot, now));
    expect(() => capacity.finalize(request.id, "agent-live", "process_failed")).toThrowError("Capacity request invalid-status");
    expect(capacity.inspect(request.id).status).toBe("active");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
    await rm(wrapperRoot, { recursive: true, force: true });
  }
});

test("skips a same-issue head while an independent request uses the free lane slot", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const active = capacity.request(input("task-a", "workflow-a:0:developer_execution", now));
    capacity.tryAcquire(active.id, 0);
    const sameIssue = capacity.request(input("task-a", "workflow-a:1:developer_execution", new Date(Date.parse(now) + 1_000).toISOString()));
    const independent = capacity.request(input("task-d", "workflow-d:1:developer_execution", new Date(Date.parse(now) + 2_000).toISOString()));
    expect(capacity.tryAcquire(sameIssue.id, 0).status).toBe("queued");
    expect(capacity.tryAcquire(independent.id, 0).status).toBe("active");
    expect(capacity.inspect(sameIssue.id).waitReason).toBe("issue_active");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("skips a queued request whose workflow revision is no longer current", async () => {
  const value = await fixture();
  try {
    value.database.authTransaction((db) => db.prepare("UPDATE forge_profiles SET capacity = 1 WHERE id = 'profile'").run());
    const capacity = new CapacityManager(value.database, value.config);
    const stale = capacity.request(input("task-a", "workflow-task-a:0:developer_execution", now, 0));
    const current = capacity.request(input("task-b", "workflow-task-b:1:developer_execution", new Date(Date.parse(now) + 1_000).toISOString(), 1));
    value.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, 'company', ?, 1, ?, ?)").run("task-a", "workflow-task-a", JSON.stringify({ capacity: null }), now);
      db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, 'company', ?, 1, ?, ?)").run("task-b", "workflow-task-b", JSON.stringify({ capacity: { requestId: current.id, workflowRevision: 1 } }), now);
    });
    expect(capacity.tryAcquire(stale.id, 0).status).toBe("stale");
    expect(capacity.tryAcquire(current.id, 1).status).toBe("active");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rate-limit attempts become durable exhaustion without changing the lane", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const request = capacity.request(input("task-a", "workflow-a:0:developer_execution"));
    capacity.tryAcquire(request.id, 0);
    capacity.bindExecution(request.id, { executionKind: "developer", executionId: "developer-rate", worktreePath: "/tmp/rate" });
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const limited = capacity.recordRateLimit(request.id, "developer-rate", retryAt);
    expect(limited.status).toBe("rate_limited");
    capacity.requeueRateLimited(request.id, new Date(Date.parse(retryAt) + 1).toISOString());
    capacity.tryAcquire(request.id, 0);
    capacity.bindExecution(request.id, { executionKind: "developer", executionId: "developer-rate", worktreePath: "/tmp/rate" });
    const exhausted = capacity.recordRateLimit(request.id, "developer-rate", retryAt);
    expect(exhausted).toMatchObject({ status: "exhausted", rateLimitAttempts: 2, terminalReason: "wait_exhausted" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("ambiguous execution ledgers retain the capacity slot after worker reconciliation", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const request = capacity.request(input("task-a", "workflow-a:ambiguous:developer_execution"));
    expect(capacity.tryAcquire(request.id, 0).status).toBe("active");
    capacity.bindExecution(request.id, { executionKind: "developer", executionId: "developer-ambiguous", worktreePath: "/tmp/ambiguous" });
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer-ambiguous', 'task-a', 'company', 'workflow-a', 1, 99, 'ownership_ambiguous', 'forge/ambiguous', '/tmp/ambiguous', ?, ?)").run("a".repeat(40), now));
    capacity.reconcileFromLedgers();
    expect(capacity.inspect(request.id)).toMatchObject({ status: "ownership_ambiguous", terminalReason: "ownership_ambiguous" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a dead agent process fails its execution and frees the ambiguous capacity slot", async () => {
  const value = await fixture();
  const deadProcess = { inspect: async () => undefined, signalGroup: async () => undefined };
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const request = capacity.request(input("task-a", "workflow-task-a:1:developer_execution"));
    expect(capacity.tryAcquire(request.id, 0).status).toBe("active");
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, process_pid, process_start_identity, started_at) VALUES ('agent-dead', 'task-a', 'company', 'workflow-task-a', 'planner', 'running', 1, 424242, '424242:Fri 21 Aug 00:47:24 2026', ?)").run(now));
    capacity.bindExecution(request.id, { executionKind: "agent", executionId: "agent-dead", sessionRef: "session-dead" });
    capacity.markOwnershipAmbiguous(request.id, "operator killed the stack mid-turn");
    // A prior pass already demoted the execution: a dead pid must still resolve.
    value.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'ownership_ambiguous', failure_code = 'ownership-ambiguous' WHERE id = 'agent-dead'").run());

    expect(await reconcileAgentExecutions(value.database, deadProcess)).toEqual([{ executionId: "agent-dead", status: "failed", reason: "process-gone" }]);
    capacity.reconcileFromLedgers();

    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_agent_executions WHERE id = 'agent-dead'").get())).toMatchObject({ status: "failed", failure_code: "worker-restart" });
    expect(capacity.inspect(request.id)).toMatchObject({ status: "released", terminalReason: "process_failed" });
    const retry = capacity.request(input("task-a", "workflow-task-a:2:developer_execution", new Date(Date.parse(now) + 1_000).toISOString()));
    expect(capacity.tryAcquire(retry.id, 0).status).toBe("active");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a live agent process keeps its turn even without a recorded process group", async () => {
  const value = await fixture();
  const liveProcess = { inspect: async (pid: number) => ({ pid, processGroupId: pid, processStartIdentity: `${pid}:start`, command: "codex" }), signalGroup: async () => undefined };
  try {
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, process_pid, process_start_identity, wrapper_id, wrapper_path, wrapper_pid, wrapper_start_identity, started_at) VALUES ('agent-live-pid', 'task-a', 'company', 'workflow-task-a', 'planner', 'running', 1, 4242, '4242:start', 'wrapper-live', '/tmp/wrapper-live', 4241, '4241:start', ?)").run(now));
    expect(await reconcileAgentExecutions(value.database, liveProcess)).toEqual([{ executionId: "agent-live-pid", status: "active", reason: "live-process" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_agent_executions WHERE id = 'agent-live-pid'").get())).toMatchObject({ status: "running" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a genuinely ambiguous agent turn still leaves the operator a way out", async () => {
  const value = await fixture();
  // Child alive, wrapper gone: partial evidence, so the turn is truly ambiguous.
  const partial = { inspect: async (pid: number) => (pid === 5252 ? { pid, processGroupId: pid, processStartIdentity: "5252:start", command: "codex" } : undefined), signalGroup: async () => undefined };
  try {
    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task-a', 'company', 'project', 'workflow-task-a', 1, 'planning', 'lead', '[]', 'Preparing', ?, 'event-1')").run(now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, process_pid, process_start_identity, wrapper_id, wrapper_path, wrapper_pid, wrapper_start_identity, started_at) VALUES ('agent-partial', 'task-a', 'company', 'workflow-task-a', 'analyst', 'running', 1, 5252, '5252:start', 'wrapper-partial', '/tmp/wrapper-partial', 5251, '5251:start', ?)").run(now);
    });
    expect(await reconcileAgentExecutions(value.database, partial)).toEqual([{ executionId: "agent-partial", status: "ownership_ambiguous", reason: "wrapper-identity-mismatch" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT owner, allowed_commands_json FROM forge_issue_projections WHERE task_id = 'task-a'").get())).toMatchObject({ owner: "human", allowed_commands_json: JSON.stringify(["retry_capacity", "cancel_issue"]) });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("separate SQLite workers race admission without exceeding the lane", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, value.config);
    const requests = ["task-a", "task-b", "task-c", "task-d"].map((taskId, index) => capacity.request(input(taskId, `worker-${index}:0:developer_execution`, new Date(Date.parse(now) + index * 1_000).toISOString())));
    const gate = new SharedArrayBuffer(4);
    const workers: Worker[] = [];
    const results: Promise<{ status: string; acquired: boolean }>[] = [];
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      let count = 0;
      for (const request of requests) {
        const worker = new Worker(new URL("./capacity-worker.ts", import.meta.url), { execArgv: ["--import", "tsx"], workerData: { databasePath: value.config.databasePath, requestId: request.id, capacity: 2, gate } });
        workers.push(worker);
        results.push(new Promise((resolveResult, rejectResult) => { worker.once("error", rejectResult); worker.on("message", (message: { type: string; status?: string; acquired?: boolean }) => { if (message.type === "result") resolveResult({ status: message.status ?? "", acquired: Boolean(message.acquired) }); }); }));
        worker.once("error", rejectReady);
        worker.on("message", (message: { type: string }) => { if (message.type === "ready" && ++count === requests.length) resolveReady(); });
      }
    });
    await ready;
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, requests.length);
    await Promise.all(results);
    await Promise.all(workers.map((worker) => worker.terminate()));
    const active = value.database.authQuery((db) => db.prepare("SELECT id FROM forge_capacity_requests WHERE status = 'active' ORDER BY requested_at, id").all() as Array<{ id: string }>);
    expect(active.map((entry) => entry.id)).toEqual(requests.slice(0, 2).map((entry) => entry.id));
    expect(value.database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_capacity_requests WHERE status = 'active'").get() as { count: number }).count)).toBe(2);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

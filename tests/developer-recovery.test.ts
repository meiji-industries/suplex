import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { DeveloperExecutionLeaseRepository } from "../src/developer-execution-leases.js";
import { cancelDeveloperExecution, reconcileDeveloperExecutions, reconcileRestoredDeveloperExecutions, type DeveloperProcessController, type DeveloperProcessInspection } from "../src/developer-recovery.js";
import type { DeveloperSupervisorIdentity } from "../src/developer-supervisor-protocol.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-recovery-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'User', 'user', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[\"Tests / unit\"]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_1', 'company_1', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'company_1/brief_1.bin', ?)").run("0".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'recovery-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task_1', 'company_1', 'project_1', 'workflow_1', 4, 'development', 'lead', '[]', 'Developer execution', ?, 'workflow_1:4')").run(now);
  });
  return { root, database };
}

function execution(database: ForgeDatabase, id: string, attempt: number): void {
  const now = new Date().toISOString();
  database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, ?, 'running', 'forge/issue/task_1', '/tmp/forge-worktree-task_1', ?, ?, ?)").run(id, attempt, "a".repeat(40), now, now));
}

function lease(database: ForgeDatabase, root: string, id: string, attempt: number): DeveloperExecutionLeaseRepository {
  execution(database, id, attempt);
  const repository = new DeveloperExecutionLeaseRepository(database, root);
  repository.reserve({ executionId: id, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt, turnKind: "implementation", canonicalWorktreePath: "/tmp/forge-worktree-task_1", worktreeIdentityHash: `worktree-${attempt}` });
  repository.markSupervisorStarting(id);
  return repository;
}

function identity(pid: number, startTime = "started"): DeveloperSupervisorIdentity {
  return { pid, processGroup: pid, startTime, executable: "/usr/bin/codex", argv: ["/usr/bin/codex", "exec"], ownerUid: 501 };
}

function inspection(value: DeveloperSupervisorIdentity): DeveloperProcessInspection {
  return { pid: value.pid, processGroupId: value.processGroup, processStartIdentity: value.startTime, command: value.argv.join(" "), executable: value.executable, argv: value.argv, ...(value.ownerUid === null ? {} : { ownerUid: value.ownerUid }) };
}

function controller(inspections: Map<number, DeveloperProcessInspection | undefined>, calls: Array<[number, "SIGTERM" | "SIGKILL"]>): DeveloperProcessController {
  return { async inspect(pid) { return inspections.get(pid); }, async signalGroup(pid, signal) { calls.push([pid, signal]); } };
}

test("INV-09 recovery observation reattaches an exact lease without starting a duplicate or writing projection state", async () => {
  const value = await fixture();
  try {
    const id = `developer_${"a".repeat(24)}`;
    const repository = lease(value.database, value.root, id, 1);
    repository.setSupervisorIdentity(id, { ...identity(101), pid: 101, processGroup: 101 });
    repository.setChildIdentity(id, identity(102));
    const before = value.database.authQuery((db) => db.prepare("SELECT revision, phase, allowed_commands_json, pending_action FROM forge_issue_projections WHERE task_id = 'task_1'").get());
    const outcomes = await reconcileDeveloperExecutions(value.database, controller(new Map([[101, inspection(identity(101))], [102, inspection(identity(102))]]), []));
    expect(outcomes).toEqual([{ executionId: id, status: "active" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT revision, phase, allowed_commands_json, pending_action FROM forge_issue_projections WHERE task_id = 'task_1'").get())).toEqual(before);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("INV-12 missing lease identity is ownership ambiguous and never signals", async () => {
  const value = await fixture();
  try {
    const id = `developer_${"b".repeat(24)}`;
    lease(value.database, value.root, id, 1);
    const calls: Array<[number, "SIGTERM" | "SIGKILL"]> = [];
    expect(await reconcileDeveloperExecutions(value.database, controller(new Map(), calls))).toEqual([{ executionId: id, status: "ownership_ambiguous", reason: "ownership-missing" }]);
    expect(await cancelDeveloperExecution(value.database, id, controller(new Map(), calls))).toMatchObject({ status: "ownership_ambiguous", reasonCode: "developer-ownership-incomplete" });
    expect(calls).toEqual([]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("INV-04 PID/start mismatch blocks cancellation without a signal", async () => {
  const value = await fixture();
  try {
    const id = `developer_${"c".repeat(24)}`;
    const repository = lease(value.database, value.root, id, 1);
    repository.setSupervisorIdentity(id, identity(201));
    repository.setChildIdentity(id, identity(202));
    const calls: Array<[number, "SIGTERM" | "SIGKILL"]> = [];
    const result = await cancelDeveloperExecution(value.database, id, controller(new Map([[201, inspection(identity(201))], [202, inspection(identity(202, "reused"))]]), calls));
    expect(result).toMatchObject({ status: "ownership_ambiguous", reasonCode: "developer-wrong_start_time" });
    expect(calls).toEqual([]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("missing Developer process marks the lease and execution interrupted", async () => {
  const value = await fixture();
  try {
    const id = `developer_${"e".repeat(24)}`;
    const repository = lease(value.database, value.root, id, 1);
    repository.setSupervisorIdentity(id, identity(301));
    repository.setChildIdentity(id, identity(302));
    expect(await cancelDeveloperExecution(value.database, id, controller(new Map(), []))).toMatchObject({ status: "interrupted", reasonCode: "developer-child-missing" });
    expect(await cancelDeveloperExecution(value.database, id, controller(new Map(), []))).toMatchObject({ status: "interrupted", reasonCode: "developer-child-missing" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(id))).toEqual({ status: "interrupted" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("INV-09 restore recovery is projection-read-only and invalidates local process ownership", async () => {
  const value = await fixture();
  try {
    const id = `developer_${"d".repeat(24)}`;
    lease(value.database, value.root, id, 1);
    const before = value.database.authQuery((db) => db.prepare("SELECT revision, phase, allowed_commands_json, pending_action FROM forge_issue_projections WHERE task_id = 'task_1'").get());
    expect(reconcileRestoredDeveloperExecutions(value.database)).toEqual([{ executionId: id, status: "interrupted", reason: "restore-invalidated-process-ownership" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT revision, phase, allowed_commands_json, pending_action FROM forge_issue_projections WHERE task_id = 'task_1'").get())).toEqual(before);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { cancelDeveloperExecution, reconcileDeveloperExecutions, reconcileRestoredDeveloperExecutions, type DeveloperProcessController, type DeveloperProcessInspection } from "../src/developer-recovery.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-recovery-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'User', 'user', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[\"Tests / unit\"]', '[]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_1', 'company_1', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'company_1/brief_1.bin', ?)").run("0".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'recovery-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task_1', 'company_1', 'project_1', 'workflow_1', 4, 'development', 'lead', '[]', 'Developer execution', ?, 'workflow_1:4')").run(now);
  });
  return { root, database };
}

function execution(database: ForgeDatabase, id: string, pid: number, status = "running", attempt = 1): void {
  const now = new Date().toISOString();
  database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, process_pid, process_group_id, process_start_identity, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, ?, ?, 'forge/issue/task_1', '/tmp/forge-worktree-task_1', ?, 'wrapper_1', '/tmp/forge-wrapper-1', ?, ?, ?, ?, ?)").run(id, attempt, status, "a".repeat(40), pid, pid, `${pid}:started`, now, now));
}

function controller(inspection: DeveloperProcessInspection | undefined, calls: Array<[number, "SIGTERM" | "SIGKILL"]>): DeveloperProcessController {
  let signalled = false;
  return { async inspect() { return signalled ? undefined : inspection; }, async signalGroup(pid, signal) { calls.push([pid, signal]); signalled = true; } };
}

test("reconciliation reattaches a matching live process without starting a duplicate", async () => {
  const value = await fixture();
  try {
    execution(value.database, "developer_live", 123);
    const outcomes = await reconcileDeveloperExecutions(value.database, controller({ pid: 123, processGroupId: 123, processStartIdentity: "123:started", command: "codex exec /tmp/forge-worktree-task_1" }, []));
    expect(outcomes).toEqual([{ executionId: "developer_live", status: "active" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_developer_executions WHERE id = 'developer_live'").get())).toEqual({ status: "running", failure_code: null });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("missing and mismatched processes become explicit recovery states without signalling", async () => {
  const value = await fixture();
  try {
    execution(value.database, "developer_missing", 124);
    const missing = await reconcileDeveloperExecutions(value.database, controller(undefined, []));
    expect(missing).toEqual([{ executionId: "developer_missing", status: "interrupted", reason: "process-missing" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_developer_executions WHERE id = 'developer_missing'").get())).toEqual({ status: "interrupted", failure_code: "process-missing" });
    expect(value.database.authQuery((db) => db.prepare("SELECT phase, allowed_commands_json, pending_action FROM forge_issue_projections WHERE task_id = 'task_1'").get())).toMatchObject({ phase: "development", allowed_commands_json: '["retry_development","cancel_development"]', pending_action: "Developer turn interrupted" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("PID reuse or command ownership mismatch blocks cancellation, while a verified group is cancelled precisely", async () => {
  const value = await fixture();
  try {
    execution(value.database, "developer_mismatch", 125);
    const calls: Array<[number, "SIGTERM" | "SIGKILL"]> = [];
    const ambiguous = await cancelDeveloperExecution(value.database, "developer_mismatch", controller({ pid: 125, processGroupId: 125, processStartIdentity: "125:other-start", command: "unrelated-process" }, calls));
    expect(ambiguous).toEqual({ status: "ownership_ambiguous", reason: "identity-mismatch" });
    expect(calls).toEqual([]);

    execution(value.database, "developer_owned", 126, "running", 2);
    const cancelled = await cancelDeveloperExecution(value.database, "developer_owned", controller({ pid: 126, processGroupId: 126, processStartIdentity: "126:started", command: "codex exec /tmp/forge-worktree-task_1" }, calls));
    expect(cancelled).toEqual({ status: "cancelled" });
    expect(calls).toEqual([[126, "SIGTERM"]]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions WHERE id = 'developer_owned'").get())).toEqual({ status: "cancelled" });
    expect(value.database.authQuery((db) => db.prepare("SELECT phase, allowed_commands_json FROM forge_issue_projections WHERE task_id = 'task_1'").get())).toMatchObject({ phase: "development", allowed_commands_json: "[]" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("restore invalidates source-host process ownership without starting a duplicate turn", async () => {
  const value = await fixture();
  try {
    execution(value.database, "developer_restored", 127);
    const report = reconcileRestoredDeveloperExecutions(value.database);
    expect(report).toEqual([{ executionId: "developer_restored", status: "interrupted", reason: "restore-invalidated-process-ownership" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_developer_executions WHERE id = 'developer_restored'").get())).toEqual({ status: "interrupted", failure_code: "restore-process-invalidated" });
    expect(value.database.authQuery((db) => db.prepare("SELECT phase, allowed_commands_json, pending_action FROM forge_issue_projections WHERE task_id = 'task_1'").get())).toMatchObject({ phase: "development", allowed_commands_json: '["retry_development","cancel_development","cancel_issue"]', pending_action: "Developer turn interrupted during restore" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

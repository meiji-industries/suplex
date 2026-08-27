import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/temporal/activities/context.js";
import { createDevelopmentActivities } from "../src/temporal/activities/development.js";

const now = "2026-08-26T00:00:00.000Z";
const baseSha = "a".repeat(40);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((remove) => remove()));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forge-development-recovery-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  cleanup.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?)").run("b".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'project-revision', 'key', ?, ?, ?)").run("c".repeat(64), now, now);
  });
  return { database, activities: createDevelopmentActivities(createActivityContext(database, config)) };
}

function addCandidate(database: ForgeDatabase, input: { id: string; status?: "failed" | "completed" | "blocked" | "running"; failureCode?: string | null; sessionStatus?: "ready" | "working" | "blocked" | "missing"; codexSessionId?: string | null; turnStatus?: "waiting" | "completed" | "blocked"; roleSessionId?: string }) {
  const status = input.status ?? "failed";
  const sessionStatus = input.sessionStatus ?? "working";
  const turnStatus = input.turnStatus ?? "waiting";
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, failure_code) VALUES (?, 'task', 'company', 'workflow', 7, ?, ?, ?, ?, ?, NULL, ?, ?, ?)").run(input.id, input.id === "candidate-2" ? 2 : 1, status, `forge/${input.id}`, `/worktrees/${input.id}`, baseSha, now, status === "failed" ? now : null, input.failureCode ?? (status === "failed" ? "worker-restart-orphan" : null));
    const roleSessionId = input.roleSessionId ?? `session-${input.id}`;
    if (!input.roleSessionId) db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, status, created_at, updated_at) VALUES (?, 'task', 'developer', ?, 1, 'codex', ?, ?, ?, ?)").run(roleSessionId, input.id === "candidate-2" ? 2 : 1, input.codexSessionId === undefined ? `codex-${input.id}` : input.codexSessionId, sessionStatus, now, now);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES (?, 'task', ?, 'builder', 'developer', ?, 'implementation', ?, ?, 0, ?, ?, ?)").run(`turn-${input.id}`, roleSessionId, input.id, "d".repeat(64), `results/${input.id}.json`, turnStatus, now, now);
  });
}

function addClaim(database: ForgeDatabase, executionId: string) {
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company', 'developer-delivery', ?, 'application/json', 1, ?, ?, ?)").run(`delivery-${executionId}`, `${executionId}.json`, "e".repeat(64), `delivery-${executionId}`, now);
    db.prepare("INSERT INTO forge_developer_result_claims (execution_id, claim_key, result_hash, activity_result_json, delivery_artifact_id, evidence_artifact_id, claimed_at) VALUES (?, ?, ?, '{}', ?, ?, ?)").run(executionId, `claim-${executionId}`, "f".repeat(64), `delivery-${executionId}`, `delivery-${executionId}`, now);
  });
}

test("findRecoverableDeveloperExecution joins the current role session and atomically reopens one orphan", async () => {
  const { database, activities } = await setup();
  addCandidate(database, { id: "candidate" });

  await expect(activities.findRecoverableDeveloperExecution({ taskId: "task", companyId: "company", workflowId: "workflow" })).resolves.toEqual({ executionId: "candidate", planRevision: 7, attempt: 1, sessionRef: "session-candidate", worktreePath: "/worktrees/candidate", branchName: "forge/candidate", targetBaseSha: baseSha });
  expect(database.authQuery((db) => db.prepare("SELECT status, failure_code, finished_at FROM forge_developer_executions WHERE id = 'candidate'").get())).toEqual({ status: "running", failure_code: null, finished_at: null });
});

test("findRecoverableDeveloperExecution leaves ambiguous candidates untouched", async () => {
  const { database, activities } = await setup();
  addCandidate(database, { id: "candidate-1" });
  addCandidate(database, { id: "candidate-2", roleSessionId: "session-candidate-1" });

  await expect(activities.findRecoverableDeveloperExecution({ taskId: "task", companyId: "company", workflowId: "workflow" })).resolves.toBeNull();
  expect(database.authQuery((db) => db.prepare("SELECT id, status, failure_code FROM forge_developer_executions ORDER BY id").all())).toEqual([{ id: "candidate-1", status: "failed", failure_code: "worker-restart-orphan" }, { id: "candidate-2", status: "failed", failure_code: "worker-restart-orphan" }]);
});

test("findRecoverableDeveloperExecution rejects a result conflict", async () => {
  const { database, activities } = await setup();
  addCandidate(database, { id: "candidate" });
  database.authQuery((db) => db.prepare("INSERT INTO forge_developer_result_conflicts (id, execution_id, existing_result_hash, conflicting_result_hash, existing_delivery_artifact_id, existing_evidence_artifact_id, conflicting_delivery_artifact_id, conflicting_evidence_artifact_id, recorded_at) VALUES ('conflict', 'candidate', ?, ?, 'brief', 'brief', 'brief', 'brief', ?)").run("1".repeat(64), "2".repeat(64), now));

  await expect(activities.findRecoverableDeveloperExecution({ taskId: "task", companyId: "company", workflowId: "workflow" })).resolves.toBeNull();
  expect(database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions WHERE id = 'candidate'").get())).toEqual({ status: "failed" });
});

test("findRecoverableDeveloperExecution returns claimed terminal results without reopening them", async () => {
  for (const status of ["completed", "blocked"] as const) {
    const { database, activities } = await setup();
    addCandidate(database, { id: `candidate-${status}`, status, turnStatus: status });
    addClaim(database, `candidate-${status}`);
    await expect(activities.findRecoverableDeveloperExecution({ taskId: "task", companyId: "company", workflowId: "workflow" })).resolves.toMatchObject({ executionId: `candidate-${status}`, sessionRef: `session-candidate-${status}` });
    expect(database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(`candidate-${status}`))).toEqual({ status });
  }
});

test("findRecoverableDeveloperExecution rejects an unclaimed terminal execution", async () => {
  const { database, activities } = await setup();
  addCandidate(database, { id: "candidate", status: "completed", turnStatus: "completed" });
  await expect(activities.findRecoverableDeveloperExecution({ taskId: "task", companyId: "company", workflowId: "workflow" })).resolves.toBeNull();
});

test("findRecoverableDeveloperExecution accepts a missing session only when it has a durable Codex session", async () => {
  const { database, activities } = await setup();
  addCandidate(database, { id: "candidate", sessionStatus: "missing", codexSessionId: "codex-durable" });
  await expect(activities.findRecoverableDeveloperExecution({ taskId: "task", companyId: "company", workflowId: "workflow" })).resolves.toMatchObject({ executionId: "candidate", sessionRef: "session-candidate" });

  const second = await setup();
  addCandidate(second.database, { id: "candidate", sessionStatus: "missing", codexSessionId: null });
  await expect(second.activities.findRecoverableDeveloperExecution({ taskId: "task", companyId: "company", workflowId: "workflow" })).resolves.toBeNull();
});

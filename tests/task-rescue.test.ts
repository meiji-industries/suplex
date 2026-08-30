import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

const { connectEngine, getIssueEngine, reconcileIssueDeveloperDelivery } = vi.hoisted(() => ({ connectEngine: vi.fn(), getIssueEngine: vi.fn(), reconcileIssueDeveloperDelivery: vi.fn() }));
vi.mock("../src/engine/service.js", () => ({ connectEngine, reconcileIssueDeveloperDelivery }));
vi.mock("../src/engine/index.js", () => ({ getIssueEngine }));

afterEach(() => {
  connectEngine.mockReset();
  reconcileIssueDeveloperDelivery.mockReset();
  getIssueEngine.mockReset();
});

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { TaskRescueService } from "../src/task-rescue.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/engine/issue-contracts.js";
import { jsonRequired } from "../src/task-utils.js";

function state(revision: number) {
  return IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId: "workflow-rescue", companyId: "company-rescue", projectId: "project-rescue", issueId: "task-rescue", projectRevisionId: "revision-rescue", briefArtifactId: "brief-rescue", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
    revision,
    phase: "delivery_blocked",
    owner: "human",
    allowedCommands: ["retry_development", "cancel_issue"],
    pendingAction: "Retry development",
    lastEventId: `workflow-rescue:${revision}`,
  });
}

test("rescue resyncs the live workflow projection before retrying its allowed command", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-rescue-test-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-rescue', 'Rescue', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-rescue', 'company-rescue', 'Rescue', '/tmp/repo', '/tmp/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-rescue', 'company-rescue', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'brief-rescue', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task-rescue', 'company-rescue', 'project-rescue', 'Rescue', 'brief-rescue', '[]', '{}', 0, 'workflow-rescue', 'revision-rescue', 'rescue-key', ?, ?, ?)").run("b".repeat(64), now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('starting-execution', 'task-rescue', 'company-rescue', 'workflow-rescue', 1, 1, 'starting', 'forge/task-rescue', ?, ?, ?)").run(root, "a".repeat(40), now);
    });
    for (let revision = 0; revision < 25; revision += 1) {
      const projected = state(revision);
      database.projectIssueState({ taskId: projected.issueId, companyId: projected.companyId, projectId: projected.projectId, workflowId: projected.workflowId, revision: projected.revision, phase: projected.phase, owner: projected.owner, allowedCommands: projected.allowedCommands, pendingAction: projected.pendingAction, lastEventId: projected.lastEventId, state: projected });
    }
    const live = state(25);
    const liveRun = { dispose: vi.fn() };
    const runs = new Map([["workflow-rescue", liveRun]]);
    const create = vi.fn();
    getIssueEngine.mockReturnValue({ runs, create });
    const close = vi.fn();
    reconcileIssueDeveloperDelivery.mockResolvedValue(live);
    connectEngine.mockResolvedValue({ connection: { close, workflowService: { describeWorkflowExecution: vi.fn().mockResolvedValue({ workflowExecutionInfo: { status: "running" } }) } }, client: { workflow: { getHandle: vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue(live), describe: vi.fn().mockResolvedValue({ runId: "run-after-reset" }) }) } } });
    const stale = { id: "task-rescue", companyId: "company-rescue", workflowId: "workflow-rescue", revision: 26, phase: "delivery_blocked", allowedCommands: [] };
    const tasks = {
      getTask: vi.fn().mockImplementation(() => {
        const projected = database.authQuery((db) => db.prepare("SELECT revision, allowed_commands_json FROM forge_issue_projections WHERE task_id = 'task-rescue'").get() as { revision: number; allowed_commands_json: string } | undefined);
        return projected ? { ...stale, revision: projected.revision, allowedCommands: jsonRequired(projected.allowed_commands_json) } : stale;
      }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
    };
    const rescue = new TaskRescueService(tasks as never, database, config);
    const result = await rescue.rescue("admin", "task-rescue");
    expect(result.steps[0]).toEqual({ name: "Resync projection", outcome: "completed", detail: "Projected workflow revision 25." });
    expect(result.steps).toContainEqual({ name: "Re-dispatch workflow", outcome: "skipped", detail: "In-process workflow re-dispatch is disabled because run liveness cannot be proven." });
    expect(result.steps).toContainEqual(expect.objectContaining({ name: "Release stale bookkeeping", outcome: "skipped", detail: "Process PID rescue is unavailable for Herdr executions." }));
    expect(database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions WHERE id = 'starting-execution'").get())).toEqual({ status: "starting" });
    expect(tasks.executeCommand).toHaveBeenCalledWith("admin", "task-rescue", "retry_development", expect.objectContaining({ expectedRevision: 25 }));
    expect(close).toHaveBeenCalled();
    expect(getIssueEngine).not.toHaveBeenCalled();
    expect(liveRun.dispose).not.toHaveBeenCalled();
    expect(runs.get("workflow-rescue")).toBe(liveRun);
    expect(create).not.toHaveBeenCalled();
    const audits = database.authQuery((db) => db.prepare("SELECT actor_user_id FROM forge_audit_events WHERE action = 'task_rescue'").all() as Array<{ actor_user_id: string }>);
    expect(audits).toHaveLength(result.steps.length);
    expect(audits.every(({ actor_user_id }) => actor_user_id === "admin")).toBe(true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rescue stops after typed Developer reconciliation reaches delivery ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-rescue-reconcile-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-rescue', 'Rescue', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-rescue', 'company-rescue', 'Rescue', '/tmp/repo', '/tmp/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-rescue', 'company-rescue', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'brief-rescue', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task-rescue', 'company-rescue', 'project-rescue', 'Rescue', 'brief-rescue', '[]', '{}', 0, 'workflow-rescue', 'revision-rescue', 'rescue-key', ?, ?, ?)").run("b".repeat(64), now, now);
    });
    const live = state(25);
    connectEngine.mockResolvedValue({ connection: { close: vi.fn() }, client: { workflow: { getHandle: vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue(live), describe: vi.fn().mockResolvedValue({ runId: "run" }) }) } } });
    reconcileIssueDeveloperDelivery.mockResolvedValue({ ...live, phase: "delivery_ready" });
    const tasks = { getTask: vi.fn().mockImplementation(() => ({ id: "task-rescue", companyId: "company-rescue", workflowId: "workflow-rescue", revision: 25, phase: "delivery_blocked", allowedCommands: ["retry_development"] })), executeCommand: vi.fn() };
    const result = await new TaskRescueService(tasks as never, database, config).rescue("admin", "task-rescue");
    expect(result.steps).toContainEqual(expect.objectContaining({ name: "Reconcile Developer delivery", outcome: "completed" }));
    expect(result.steps).not.toContainEqual(expect.objectContaining({ name: "Re-dispatch workflow" }));
    expect(result.steps).not.toContainEqual(expect.objectContaining({ name: "Release stale bookkeeping" }));
    expect(result.steps).not.toContainEqual(expect.objectContaining({ name: "Retry current step" }));
    expect(tasks.executeCommand).not.toHaveBeenCalled();
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("active admin can read rescue diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-diagnostics-admin-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now));
    const close = vi.fn();
    const describeWorkflowExecution = vi.fn().mockResolvedValue({ workflowExecutionInfo: { status: "running" } });
    connectEngine.mockResolvedValue({ connection: { close, workflowService: { describeWorkflowExecution } } });
    const tasks = {
      getTask: vi.fn().mockReturnValue({ id: "task-rescue", workflowId: "workflow-rescue" }),
      executeCommand: vi.fn(),
    };
    const result = await new TaskRescueService(tasks as never, database, config).diagnostics("admin", "task-rescue");
    expect(result.workflow.status).toBe("running");
    expect(tasks.getTask).toHaveBeenCalledWith("admin", "task-rescue");
    expect(describeWorkflowExecution).toHaveBeenCalledWith({ execution: { workflowId: "workflow-rescue" } });
    expect(close).toHaveBeenCalled();
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("member, revoked, and unknown actors fail closed before task or rescue dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-rescue-denied-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('member', 'Member', 'member@forge.local', 'member', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('revoked', 'Revoked', 'revoked@forge.local', 'admin', 'revoked', ?, ?)").run(now, now);
    });
    const tasks = { getTask: vi.fn(), executeCommand: vi.fn() };
    const rescue = new TaskRescueService(tasks as never, database, config);
    for (const method of ["diagnostics", "rescue"] as const) {
      for (const actor of ["member", "revoked", "unknown"]) {
        await expect(rescue[method](actor, "task-rescue")).rejects.toMatchObject({ publicMessage: "Not found", statusCode: 404 });
      }
    }
    expect(tasks.getTask).not.toHaveBeenCalled();
    expect(tasks.executeCommand).not.toHaveBeenCalled();
    expect(connectEngine).not.toHaveBeenCalled();
    expect(reconcileIssueDeveloperDelivery).not.toHaveBeenCalled();
    expect(getIssueEngine).not.toHaveBeenCalled();
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action = 'task_rescue'").get())).toEqual({ count: 0 });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

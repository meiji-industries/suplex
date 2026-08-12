import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase, projectionStateHash } from "../src/database.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { TaskService, type IssueWorkflowPort } from "../src/tasks.js";
import type { IssueWorkflowInput, IssueWorkflowState, StartPlanningInput } from "../src/temporal/issue-contracts.js";

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

async function fixture(): Promise<{ root: string; database: ForgeDatabase; auth: AuthService; projects: ProjectService; tasks: TaskService; adminId: string; companyId: string; projectId: string; profileId: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-task-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "https://forge.tailnet.ts.net:4111" });
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "Acme");
  const profile = projects.createProfile("admin-1", { name: "Default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const project = await projects.createProject("admin-1", company.id, { name: "Forge", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], allowedProfileIds: [profile.id], roleDefaults: { lead: profile.id, developer: profile.id } });
  await projects.activateProject("admin-1", project.id);
  const stateByTask = new Map<string, IssueWorkflowState>();
  const workflow: IssueWorkflowPort = {
    async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) {
      const state: IssueWorkflowState = { workflowId: input.workflowId!, companyId: input.companyId, projectId: input.projectId, issueId: input.issueId, projectRevisionId: input.projectRevisionId, phase: "backlog", revision: 0, owner: "human", allowedCommands: ["start_planning"], pendingAction: "Start planning", lastEventId: `${input.workflowId}:0`, continuationCount: 0, lastSummaryHash: null };
      stateByTask.set(input.issueId, state);
      return { workflowId: state.workflowId, runId: "run-1" };
    },
    async startPlanning(workflowId: string, input: StartPlanningInput) {
      const current = [...stateByTask.values()].find((state) => state.workflowId === workflowId)!;
      if (input.expectedRevision !== current.revision) throw new Error("Stale workflow revision");
      const next = { ...current, phase: "planning" as const, revision: 1, owner: "lead" as const, allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${workflowId}:1` };
      stateByTask.set(next.issueId, next);
      return next;
    },
  };
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  return { root, database, auth, projects, tasks, adminId: "admin-1", companyId: company.id, projectId: project.id, profileId: profile.id };
}

test("creates one durable backlog task, verifies immutable images, and starts planning with an expected revision", async () => {
  const value = await fixture();
  try {
    const events: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number }> = [];
    const unsubscribe = value.tasks.subscribe(value.adminId, (event) => events.push(event));
    const first = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Investigate queue", description: "## Reproduce\n\nPlease inspect the queue.", idempotencyKey: "queue-task-0001", supplementalReview: true, images: [{ filename: "evidence.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
    await expect.poll(() => events).toHaveLength(1);
    unsubscribe();
    expect(first.created).toBe(true);
    expect(first.task.phase).toBe("backlog");
    expect(first.task.pendingAction).toBe("Start planning");
    expect(first.task.description).toContain("Reproduce");
    expect(first.task.images).toHaveLength(1);
    expect(first.task.supplementalReview).toBe(true);
    expect(first.task.roleProfiles.lead).toBe(value.profileId);
    expect(events).toEqual([{ type: "invalidate", taskId: first.task.id, companyId: value.companyId, revision: 0 }]);
    const initialSnapshot = value.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(first.task.id) as { state_json: string });
    const initialState = JSON.parse(initialSnapshot.state_json) as IssueWorkflowState;
    expect(initialState).toMatchObject({ issueId: first.task.id, repairCycle: 0 });
    expect(initialState).not.toHaveProperty("taskId");
    expect(() => value.database.projectIssueState({ taskId: initialState.issueId, companyId: initialState.companyId, projectId: initialState.projectId, workflowId: initialState.workflowId, revision: initialState.revision, phase: initialState.phase, owner: initialState.owner, allowedCommands: initialState.allowedCommands, pendingAction: initialState.pendingAction, lastEventId: initialState.lastEventId, state: initialState })).not.toThrow();
    const duplicate = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Investigate queue", description: "## Reproduce\n\nPlease inspect the queue.", idempotencyKey: "queue-task-0001", supplementalReview: true, images: [{ filename: "evidence.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
    expect(duplicate.created).toBe(false);
    expect(duplicate.task.id).toBe(first.task.id);
    await expect(value.tasks.startPlanning(value.adminId, first.task.id, 9)).rejects.toMatchObject({ statusCode: 409, findings: [expect.objectContaining({ code: "stale-revision" })] });
    const planning = await value.tasks.startPlanning(value.adminId, first.task.id, 0);
    expect(planning).toMatchObject({ phase: "planning", revision: 1, owner: "lead", pendingAction: "Lead planning", allowedCommands: [] });
    expect(planning.timeline.map((entry) => entry.eventType)).toEqual(["task_created", "planning_started"]);
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, finished_at, failure_code, failure_summary) VALUES ('agent-visible', ?, ?, ?, 'lead', 'failed', 1, '2026-08-11T01:00:00.000Z', '2026-08-11T01:00:02.000Z', 'model-unavailable', 'Select a supported model, then retry.')").run(first.task.id, first.task.companyId, first.task.workflowId));
    expect(value.tasks.getTask(value.adminId, first.task.id).agentInvocations).toEqual([expect.objectContaining({ id: "agent-visible", role: "lead", status: "failed", attempt: 1, failureCode: "model-unavailable", failureSummary: "Select a supported model, then retry." })]);
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("repairs the legacy revision-zero seed before applying the Temporal initial projection", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Legacy seed", description: "body", idempotencyKey: "legacy-seed-0001", images: [] });
    const snapshot = value.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(created.task.id) as { state_json: string });
    const canonical = JSON.parse(snapshot.state_json) as IssueWorkflowState;
    const planning = { ...canonical, revision: 1, phase: "planning" as const, owner: "lead" as const, allowedCommands: [] as const, pendingAction: "Lead planning", lastEventId: `${canonical.workflowId}:1` };
    const approval = { ...planning, revision: 2, phase: "approval" as const, owner: "human" as const, allowedCommands: ["approve_plan" as const, "reject_plan" as const, "cancel_issue" as const], pendingAction: "Approve final plan", lastEventId: `${canonical.workflowId}:2` };
    value.database.projectIssueState({ taskId: planning.issueId, companyId: planning.companyId, projectId: planning.projectId, workflowId: planning.workflowId, revision: planning.revision, phase: planning.phase, owner: planning.owner, allowedCommands: [...planning.allowedCommands], pendingAction: planning.pendingAction, lastEventId: planning.lastEventId, state: planning });
    value.database.projectIssueState({ taskId: approval.issueId, companyId: approval.companyId, projectId: approval.projectId, workflowId: approval.workflowId, revision: approval.revision, phase: approval.phase, owner: approval.owner, allowedCommands: [...approval.allowedCommands], pendingAction: approval.pendingAction, lastEventId: approval.lastEventId, state: approval });
    const { issueId, repairCycle: _repairCycle, ...seed } = canonical;
    const legacy = { ...seed, taskId: issueId };
    const legacyHash = projectionStateHash(legacy);
    value.database.authTransaction((db) => {
      db.prepare("UPDATE forge_workflow_snapshots SET state_json = ? WHERE task_id = ? AND revision = 0").run(JSON.stringify(legacy), issueId);
      db.prepare("UPDATE forge_issue_timeline SET event_hash = ?, metadata_json = ? WHERE task_id = ? AND revision = 0").run(legacyHash, JSON.stringify({ revision: 0, stateHash: legacyHash }), issueId);
      db.prepare("UPDATE forge_issue_projections SET event_hash = ? WHERE task_id = ? AND revision = 0").run(legacyHash, issueId);
    });

    expect(() => value.database.projectIssueState({ taskId: canonical.issueId, companyId: canonical.companyId, projectId: canonical.projectId, workflowId: canonical.workflowId, revision: canonical.revision, phase: canonical.phase, owner: canonical.owner, allowedCommands: canonical.allowedCommands, pendingAction: canonical.pendingAction, lastEventId: canonical.lastEventId, state: canonical })).not.toThrow();
    const repaired = value.database.authQuery((db) => ({
      snapshot: db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(issueId) as { state_json: string },
      timeline: db.prepare("SELECT event_hash FROM forge_issue_timeline WHERE task_id = ? AND revision = 0").get(issueId) as { event_hash: string },
      projection: db.prepare("SELECT revision, event_hash FROM forge_issue_projections WHERE task_id = ?").get(issueId) as { revision: number; event_hash: string },
    }));
    expect(JSON.parse(repaired.snapshot.state_json)).toEqual(canonical);
    expect(repaired.timeline.event_hash).toBe(projectionStateHash(canonical));
    expect(repaired.projection).toEqual({ revision: 2, event_hash: projectionStateHash(approval) });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("streams projection changes written by the Temporal worker process", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Synced task", description: "body", idempotencyKey: "synced-task-0001", images: [] });
    const events: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number }> = [];
    const deniedEvents: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number }> = [];
    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('sync-member', 'Sync Member', 'sync@forge.local', 'member', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('sync-other-company', 'Other', 'active', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('sync-member', 'sync-other-company', '2026-08-11T00:00:00.000Z')").run();
    });
    const unsubscribe = value.tasks.subscribe(value.adminId, (event) => events.push(event));
    const unsubscribeDenied = value.tasks.subscribe("sync-member", (event) => deniedEvents.push(event));
    const workerDatabase = new ForgeDatabase(join(value.root, "forge.sqlite"));
    try {
      workerDatabase.projectIssueState({ taskId: created.task.id, companyId: created.task.companyId, projectId: created.task.projectId, workflowId: created.task.workflowId, revision: 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${created.task.workflowId}:1` });
      await expect.poll(() => events).toEqual([{ type: "invalidate", taskId: created.task.id, companyId: created.task.companyId, revision: 1 }]);
      expect(deniedEvents).toEqual([]);
    } finally {
      unsubscribe();
      unsubscribeDenied();
      workerDatabase.close();
    }
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("projection writes are monotonic and corrupted or traversing artifacts fail closed", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Artifact task", description: "body", idempotencyKey: "artifact-task-0001", images: [{ filename: "proof.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
    const imageId = created.task.images[0]!.artifactId;
    const artifact = value.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ?").get(imageId) as { storage_path: string });
    await writeFile(join(value.root, "artifacts", artifact.storage_path), "corrupted");
    await expect(value.tasks.getTaskImage(value.adminId, created.task.id, imageId)).rejects.toMatchObject({ code: "hash-mismatch" });
    await expect(value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Traversal", description: "body", idempotencyKey: "artifact-task-0002", images: [{ filename: "../secret.png", mimeType: "image/png", base64: Buffer.from("proof").toString("base64") }] })).rejects.toMatchObject({ findings: [expect.objectContaining({ code: "invalid-image-filename" })] });
    value.database.projectIssueState({ taskId: created.task.id, companyId: created.task.companyId, projectId: created.task.projectId, workflowId: created.task.workflowId, revision: 4, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${created.task.workflowId}:4` });
    value.database.projectIssueState({ taskId: created.task.id, companyId: created.task.companyId, projectId: created.task.projectId, workflowId: created.task.workflowId, revision: 2, phase: "backlog", owner: "human", allowedCommands: ["start_planning"], pendingAction: "Start planning", lastEventId: `${created.task.workflowId}:2` });
    expect(value.database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = ?").get(created.task.id))).toEqual({ revision: 4, phase: "planning" });
    await readFile(join(value.root, "artifacts", artifact.storage_path));
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("company scope denies task discovery and mutation", async () => {
  const value = await fixture();
  try {
    const task = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Scoped task", description: "body", idempotencyKey: "scoped-task-0001", images: [] });
    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('member-1', 'Member', 'member@forge.local', 'member', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('other-company', 'Other', 'active', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('member-1', 'other-company', '2026-08-11T00:00:00.000Z')").run();
    });
    expect(value.tasks.listTasks("member-1")).toEqual([]);
    expect(() => value.tasks.getTask("member-1", task.task.id)).toThrowError("Not found");
    await expect(value.tasks.createTask("member-1", value.companyId, { projectId: value.projectId, title: "Leak", description: "body", idempotencyKey: "scoped-task-0002", images: [] })).rejects.toMatchObject({ publicMessage: "Not found" });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("continues terminal work as a new linked issue without rewriting the original history", async () => {
  const value = await fixture();
  try {
    const original = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Finished issue", description: "Preserve this history.", idempotencyKey: "continue-task-0001", images: [] });
    value.database.authQuery((db) => db.prepare("UPDATE forge_issue_projections SET phase = 'done', owner = 'human', allowed_commands_json = '[]', pending_action = NULL, revision = 7 WHERE task_id = ?").run(original.task.id));
    const continued = await value.tasks.continueWork(value.adminId, original.task.id);
    expect(continued.original.phase).toBe("done");
    expect(continued.successor.predecessorTaskId).toBe(original.task.id);
    expect(continued.successor.id).not.toBe(original.task.id);
    expect(continued.successor.description).toContain(`Continued from Forge issue ${original.task.id}`);
    expect(value.database.authQuery((db) => db.prepare("SELECT phase, revision FROM forge_issue_projections WHERE task_id = ?").get(original.task.id))).toEqual({ phase: "done", revision: 7 });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { ArtifactStore } from "../src/artifacts.js";
import { createTestConfig, type ForgeConfig } from "../src/config.js";
import { ForgeDatabase, projectionStateHash } from "../src/database.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { TaskService, type IssueWorkflowPort } from "../src/tasks.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, IssueWorkflowStateSchema, type ContinueWorkCommand, type IssueWorkflowInput, type IssueWorkflowState, type PlanRevisionCommand, type RecordProgressInput, type ResolveDecisionBlockerInput } from "../src/temporal/issue-contracts.js";

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

function projectState(database: ForgeDatabase, state: IssueWorkflowState, runId = "run-1"): void {
  database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId, eventId: state.lastEventId, state }));
}

async function fixture(): Promise<{ root: string; config: ForgeConfig; database: ForgeDatabase; auth: AuthService; projects: ProjectService; tasks: TaskService; workflow: IssueWorkflowPort; stateByTask: Map<string, IssueWorkflowState>; adminId: string; companyId: string; projectId: string; profileId: string }> {
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
  const project = await projects.createProject("admin-1", company.id, { name: "Forge", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], allowedProfileIds: [profile.id], roleDefaults: { lead: profile.id, developer: profile.id, reviewer: profile.id } });
  await projects.activateProject("admin-1", project.id);
  const stateByTask = new Map<string, IssueWorkflowState>();
  let tasks!: TaskService;
  const workflow: IssueWorkflowPort = {
    async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) {
      const state = buildInitialIssueWorkflowState({ ...input, workflowId: input.workflowId! });
      stateByTask.set(input.issueId, state);
      database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run-1", eventId: state.lastEventId, state }));
      return { workflowId: state.workflowId, runId: "run-1" };
    },
    async execute(command, workflowId, input) {
      const current = [...stateByTask.values()].find((state) => state.workflowId === workflowId)!;
      if (input.expectedRevision !== current.revision) throw new Error("Stale workflow revision");
      if (command === "start_planning") {
        const next = { ...current, phase: "planning" as const, revision: 1, owner: "lead" as const, allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${workflowId}:1` };
        stateByTask.set(next.issueId, next);
        database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run-1", eventId: next.lastEventId, state: next }));
        return next;
      }
      if (command === "publish_draft") {
        const next = { ...current, phase: "releasing" as const, revision: current.revision + 1, owner: "lead" as const, allowedCommands: [], pendingAction: "Publishing one exact draft pull request", lastEventId: `${workflowId}:${current.revision + 1}` };
        stateByTask.set(next.issueId, next);
        projectState(database, next);
        return next;
      }
      throw new Error(`Unsupported fixture command: ${command}`);
    },
    async revisePlan(workflowId: string, _input: PlanRevisionCommand) {
      return [...stateByTask.values()].find((state) => state.workflowId === workflowId)!;
    },
    async continueWork(workflowId: string, input: ContinueWorkCommand) {
      const current = [...stateByTask.values()].find((state) => state.workflowId === workflowId)!;
      const projection = database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE workflow_id = ?").get(workflowId) as { revision: number; phase: IssueWorkflowState["phase"] });
      if (input.expectedRevision !== projection.revision) throw new Error("Stale workflow revision");
      const successor = await tasks.createTask("admin-1", company.id, { projectId: current.projectId, title: `Continue: ${current.issueId}`, description: `Continued from Forge issue ${current.issueId}: ${input.reason}`, idempotencyKey: `continue-${current.issueId}`, images: [] });
      const successorState = stateByTask.get(successor.task.id)!;
      const reasonArtifact = await new ArtifactStore(config.artifactRoot).put(company.id, "continuation-reason", { filename: "continuation-reason.md", mimeType: "text/markdown", bytes: Buffer.from(input.reason.trim(), "utf8") });
      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reasonArtifact.id, reasonArtifact.companyId, reasonArtifact.kind, reasonArtifact.filename, reasonArtifact.mimeType, reasonArtifact.byteSize, reasonArtifact.sha256, reasonArtifact.storagePath, reasonArtifact.createdAt);
        db.prepare("UPDATE forge_tasks SET predecessor_task_id = ? WHERE id = ?").run(current.issueId, successor.task.id);
        db.prepare("UPDATE forge_tasks SET successor_task_id = ? WHERE id = ?").run(successor.task.id, current.issueId);
        db.prepare("INSERT INTO forge_successor_intents (id, predecessor_task_id, predecessor_workflow_id, accepted_revision, successor_task_id, successor_workflow_id, company_id, project_id, project_revision_id, actor_user_id, reason_artifact_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?)").run(`intent_${workflowId}_7`, current.issueId, workflowId, 7, successor.task.id, successor.task.workflowId, company.id, current.projectId, successor.task.projectRevisionId, "admin-1", reasonArtifact.id, new Date().toISOString(), new Date().toISOString());
      });
      const next = IssueWorkflowStateSchema.parse({ ...current, phase: projection.phase, revision: projection.revision + 1, allowedCommands: [], pendingAction: "Successor created", successorTaskId: successor.task.id, successorReference: { successorTaskId: successor.task.id, successorWorkflowId: successorState.workflowId, predecessorTaskId: current.issueId, projectRevisionId: successor.task.projectRevisionId, creationRevision: projection.revision }, lastEventId: `${workflowId}:${projection.revision + 1}` });
      stateByTask.set(current.issueId, next);
      database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run-1", eventId: next.lastEventId, state: next }));
      return next;
    },
    async resolveDecisionBlocker(workflowId: string, _input: ResolveDecisionBlockerInput) {
      return [...stateByTask.values()].find((state) => state.workflowId === workflowId)!;
    },
    async recordProgress(workflowId: string, _input: RecordProgressInput) {
      return [...stateByTask.values()].find((state) => state.workflowId === workflowId)!;
    },
    async query(workflowId: string) {
      return [...stateByTask.values()].find((state) => state.workflowId === workflowId)!;
    },
  };
  tasks = new TaskService(database, auth, projects, config, { workflow });
  return { root, config, database, auth, projects, tasks, workflow, stateByTask, adminId: "admin-1", companyId: company.id, projectId: project.id, profileId: profile.id };
}

test("a creator that loses its lease cannot advance the creation intent", async () => {
  const value = await fixture();
  try {
    const tasks = new TaskService(value.database, value.auth, value.projects, value.config, {
      workflow: value.workflow,
      fault(point, ids) {
        if (point === "after_manifest_persisted") value.database.authTransaction((db) => db.prepare("UPDATE forge_task_creation_intents SET lease_token = 'lease-stolen' WHERE id = ?").run(ids.intentId));
      },
    });
    await expect(tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Lease task", description: "body", idempotencyKey: "lease-task-0001", images: [] })).rejects.toMatchObject({ statusCode: 409, findings: [expect.objectContaining({ code: "creation-lease-lost" })] });
    expect(value.database.authQuery((db) => db.prepare("SELECT state, lease_token, artifact_ids_json FROM forge_task_creation_intents WHERE idempotency_key = 'lease-task-0001'").get())).toEqual({ state: "staging", lease_token: "lease-stolen", artifact_ids_json: "[]" });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE idempotency_key = 'lease-task-0001'").get())).toEqual({ count: 0 });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

for (const faultPoint of ["after_artifact_finalized", "after_task_committed", "before_response"] as const) {
  test(`an exact retry converges after ${faultPoint}`, async () => {
    const value = await fixture();
    try {
      let failOnce = true;
      const faulting = new TaskService(value.database, value.auth, value.projects, value.config, {
        workflow: value.workflow,
        fault(point) {
          if (point === faultPoint && failOnce) {
            failOnce = false;
            throw new Error(`simulated crash at ${point}`);
          }
        },
      });
      const taskInput = { projectId: value.projectId, title: `Recovery ${faultPoint}`, description: "durable body", idempotencyKey: `recovery-${faultPoint.replaceAll("_", "-")}`, images: [] };
      await expect(faulting.createTask(value.adminId, value.companyId, taskInput)).rejects.toBeDefined();

      const beforeRetry = value.database.authQuery((db) => db.prepare("SELECT state FROM forge_task_creation_intents WHERE idempotency_key = ?").get(taskInput.idempotencyKey) as { state: string });
      expect(beforeRetry.state).toBe(faultPoint === "after_artifact_finalized" ? "failed_before_start" : faultPoint === "after_task_committed" ? "workflow_starting" : "started");
      if (faultPoint === "after_artifact_finalized") {
        expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE idempotency_key = ?").get(taskInput.idempotencyKey))).toEqual({ count: 0 });
        const files = await readdir(join(value.root, "artifacts"), { recursive: true }).catch(() => [] as string[]);
        expect(files.filter((entry) => entry.endsWith(".bin") || entry.endsWith(".tmp"))).toEqual([]);
      }

      const retried = await value.tasks.createTask(value.adminId, value.companyId, taskInput);
      expect(retried.created).toBe(faultPoint === "after_artifact_finalized");
      expect(retried.task).toMatchObject({ phase: "backlog", revision: 0 });
      expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE idempotency_key = ?").get(taskInput.idempotencyKey))).toEqual({ count: 1 });
      expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts WHERE company_id = ?").get(value.companyId))).toEqual({ count: 1 });
      expect(value.database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = ? ORDER BY revision").all(retried.task.id))).toEqual([{ revision: 0 }]);
    } finally {
      value.database.close(); await rm(value.root, { recursive: true, force: true });
    }
  });
}

test("concurrent identical submissions converge and conflicting submissions fail closed", async () => {
  const value = await fixture();
  try {
    const identicalInput = { projectId: value.projectId, title: "Concurrent task", description: "same body", idempotencyKey: "concurrent-task-0001", images: [] };
    const [first, second] = await Promise.all([
      value.tasks.createTask(value.adminId, value.companyId, identicalInput),
      value.tasks.createTask(value.adminId, value.companyId, identicalInput),
    ]);
    expect(first.task.id).toBe(second.task.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE idempotency_key = ?").get(identicalInput.idempotencyKey))).toEqual({ count: 1 });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_issue_timeline WHERE task_id = ? AND revision = 0").get(first.task.id))).toEqual({ count: 1 });

    const conflictKey = "concurrent-task-0002";
    const outcomes = await Promise.allSettled([
      value.tasks.createTask(value.adminId, value.companyId, { ...identicalInput, idempotencyKey: conflictKey, title: "Winner" }),
      value.tasks.createTask(value.adminId, value.companyId, { ...identicalInput, idempotencyKey: conflictKey, title: "Different request" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ statusCode: 409, findings: [expect.objectContaining({ code: "idempotency_conflict" })] }) })]);
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE idempotency_key = ?").get(conflictKey))).toEqual({ count: 1 });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("creates one durable backlog task, verifies immutable images, and starts planning with an expected revision", async () => {
  const value = await fixture();
  try {
    const events: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number; attentionChanged: boolean }> = [];
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
    expect(events).toEqual([{ type: "invalidate", taskId: first.task.id, companyId: value.companyId, revision: 0, attentionChanged: false }]);
    const initialSnapshot = value.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(first.task.id) as { state_json: string });
    const initialState = JSON.parse(initialSnapshot.state_json) as IssueWorkflowState;
    expect(initialState).toMatchObject({ issueId: first.task.id, repairCycle: 0 });
    expect(initialState).not.toHaveProperty("taskId");
    expect(() => projectState(value.database, initialState)).not.toThrow();
    const duplicate = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Investigate queue", description: "## Reproduce\n\nPlease inspect the queue.", idempotencyKey: "queue-task-0001", supplementalReview: true, images: [{ filename: "evidence.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
    expect(duplicate.created).toBe(false);
    expect(duplicate.task.id).toBe(first.task.id);
    await expect(value.tasks.executeCommand(value.adminId, first.task.id, "start_planning", { expectedRevision: 9 })).rejects.toMatchObject({ statusCode: 409, findings: [expect.objectContaining({ code: "stale-revision" })] });
    const planning = await value.tasks.executeCommand(value.adminId, first.task.id, "start_planning", { expectedRevision: 0 });
    expect(planning).toMatchObject({ phase: "planning", revision: 1, owner: "lead", pendingAction: "Lead planning", allowedCommands: [] });
    expect(planning.timeline.map((entry) => entry.eventType)).toEqual(["task_created", "planning_started"]);
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, finished_at, failure_code, failure_summary) VALUES ('agent-visible', ?, ?, ?, 'lead', 'failed', 1, '2026-08-11T01:00:00.000Z', '2026-08-11T01:00:02.000Z', 'model-unavailable', 'Select a supported model, then retry.')").run(first.task.id, first.task.companyId, first.task.workflowId));
    expect(value.tasks.getTask(value.adminId, first.task.id).agentInvocations).toEqual([expect.objectContaining({ id: "agent-visible", role: "lead", status: "failed", attempt: 1, failureCode: "model-unavailable", failureSummary: "Select a supported model, then retry." })]);
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("retries draft publication from a typed provider-failure state", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Retry release", description: "Reviewed delivery", idempotencyKey: "retry-release-0001", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const blocked: IssueWorkflowState = { ...initial, revision: 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "GitHub provider request failed", releaseStatus: "blocked", releaseFailureCode: "provider-unavailable", releaseFailureSummary: "GitHub provider request failed", lastEventId: `${initial.workflowId}:1` };
    value.stateByTask.set(created.task.id, blocked);
    projectState(value.database, blocked);

    const retried = await value.tasks.executeCommand(value.adminId, created.task.id, "publish_draft", { expectedRevision: 1 });
    expect(retried).toMatchObject({ phase: "releasing", revision: 2, pendingAction: "Publishing one exact draft pull request" });
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
    const planning = IssueWorkflowStateSchema.parse({ ...canonical, revision: 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${canonical.workflowId}:1` });
    const approval = IssueWorkflowStateSchema.parse({ ...planning, revision: 2, phase: "approval", owner: "human", allowedCommands: ["approve_plan", "reject_plan", "cancel_issue"], pendingAction: "Approve final plan", lastEventId: `${canonical.workflowId}:2` });
    projectState(value.database, planning);
    projectState(value.database, approval);
    const { issueId, repairCycle: _repairCycle, ...seed } = canonical;
    const legacy = { ...seed, taskId: issueId };
    const legacyHash = projectionStateHash(legacy);
    value.database.authTransaction((db) => {
      db.prepare("UPDATE forge_workflow_snapshots SET state_json = ? WHERE task_id = ? AND revision = 0").run(JSON.stringify(legacy), issueId);
      db.prepare("UPDATE forge_issue_timeline SET event_hash = ?, metadata_json = ? WHERE task_id = ? AND revision = 0").run(legacyHash, JSON.stringify({ revision: 0, stateHash: legacyHash }), issueId);
      db.prepare("UPDATE forge_issue_projections SET event_hash = ? WHERE task_id = ? AND revision = 0").run(legacyHash, issueId);
    });

    expect(() => projectState(value.database, canonical)).not.toThrow();
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
    const events: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number; attentionChanged: boolean }> = [];
    const deniedEvents: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number; attentionChanged: boolean }> = [];
    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('sync-member', 'Sync Member', 'sync@forge.local', 'member', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('sync-other-company', 'Other', 'active', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('sync-member', 'sync-other-company', '2026-08-11T00:00:00.000Z')").run();
    });
    const unsubscribe = value.tasks.subscribe(value.adminId, (event) => events.push(event));
    const unsubscribeDenied = value.tasks.subscribe("sync-member", (event) => deniedEvents.push(event));
    const workerDatabase = new ForgeDatabase(join(value.root, "forge.sqlite"));
    try {
      projectState(workerDatabase, IssueWorkflowStateSchema.parse({ ...created.task, issueId: created.task.id, projectRevisionId: created.task.projectRevisionId, revision: 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${created.task.workflowId}:1`, continuationCount: 0, lastSummaryHash: null, repairCycle: 0 }), "run-worker");
      await expect.poll(() => events).toEqual([{ type: "invalidate", taskId: created.task.id, companyId: created.task.companyId, revision: 1, attentionChanged: false }]);
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
    const initial = IssueWorkflowStateSchema.parse(JSON.parse(value.database.authQuery((db) => (db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(created.task.id) as { state_json: string }).state_json)));
    const newer = IssueWorkflowStateSchema.parse({ ...initial, revision: 4, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${created.task.workflowId}:4` });
    const stale = IssueWorkflowStateSchema.parse({ ...initial, revision: 2, lastEventId: `${created.task.workflowId}:2` });
    value.database.projectIssueEvent({ schemaVersion: 1, runId: "run-1", eventId: newer.lastEventId, state: newer });
    value.database.projectIssueEvent({ schemaVersion: 1, runId: "run-1", eventId: stale.lastEventId, state: stale });
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
    const initialSnapshot = value.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(original.task.id) as { state_json: string });
    const terminalState = { ...JSON.parse(initialSnapshot.state_json), phase: "done", revision: 7, owner: "human", allowedCommands: [], pendingAction: null, lastEventId: `${original.task.workflowId}:7` } as IssueWorkflowState;
    value.database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: terminalState.lastEventId, state: terminalState }));
    const continued = await value.tasks.continueWork(value.adminId, original.task.id, 7, "Continue implementation after the completed issue.");
    expect(continued.original.phase).toBe("done");
    expect(continued.successor.predecessorTaskId).toBe(original.task.id);
    expect(continued.original.successor).toMatchObject({ id: continued.successor.id, title: continued.successor.title, phase: "backlog" });
    expect(continued.successor.predecessor).toMatchObject({ id: original.task.id, title: original.task.title, phase: "done" });
    expect(continued.original.revisionHistory).toEqual([]);
    expect(continued.successor.id).not.toBe(original.task.id);
    expect(continued.successor.description).toContain(`Continued from Forge issue ${original.task.id}`);
    expect(value.database.authQuery((db) => db.prepare("SELECT phase, revision FROM forge_issue_projections WHERE task_id = ?").get(original.task.id))).toEqual({ phase: "done", revision: 8 });
    const retried = await value.tasks.continueWork(value.adminId, original.task.id, 7, "Continue implementation after the completed issue.");
    expect(retried.successor.id).toBe(continued.successor.id);
    await expect(value.tasks.continueWork(value.adminId, original.task.id, 7, "A different continuation request.")).rejects.toMatchObject({ statusCode: 409, findings: [expect.objectContaining({ code: "stale-revision" })] });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_successor_intents WHERE predecessor_task_id = ?").get(original.task.id))).toEqual({ count: 1 });
    const reasonArtifactId = value.database.authQuery((db) => (db.prepare("SELECT reason_artifact_id FROM forge_successor_intents WHERE predecessor_task_id = ?").get(original.task.id) as { reason_artifact_id: string }).reason_artifact_id);
    expect((await value.tasks.getTaskArtifact(value.adminId, original.task.id, reasonArtifactId)).bytes.toString("utf8")).toBe("Continue implementation after the completed issue.");
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

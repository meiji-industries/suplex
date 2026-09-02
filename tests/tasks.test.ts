import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import Fastify from "fastify";

import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";

import { AuthService } from "../src/auth.js";
import { ArtifactStore } from "../src/artifacts.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig, type ForgeConfig } from "../src/config.js";
import { ForgeDatabase, projectionStateHash } from "../src/database.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import type { GithubReleasePort } from "../src/github-release.js";
import { loadTaskConfiguration } from "../src/task-project-configuration.js";
import { TaskService, type IssueWorkflowPort } from "../src/tasks.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, IssueWorkflowStateSchema, type IssueWorkflowInput, type IssueWorkflowState } from "../src/engine/issue-contracts.js";
import type { ContinueWorkCommand, PlanRevisionCommand, RecordProgressInput, ResolveDecisionBlockerInput, StartPlanningInput } from "../src/commands/inputs.js";
import { TaskResponseSchema } from "../src/http/contracts/tasks.js";
import { jsonRequired } from "../src/task-utils.js";
import taskBranch from "../src/http/routes/task-branch.js";
import { WorktreeManager } from "../src/worktrees.js";
import { rebuildDriftedIssueProjections } from "../src/engine/host.js";
import taskRoutes from "../src/http/routes/tasks.js";


const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
}

function projectState(database: ForgeDatabase, state: IssueWorkflowState, runId = "run-1"): void {
  database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId, eventId: state.lastEventId, state }));
}

async function fixture(options: { githubRelease?: Pick<GithubReleasePort, "listOpenPullRequests" | "getPullRequest"> } = {}): Promise<{ root: string; config: ForgeConfig; database: ForgeDatabase; auth: AuthService; projects: ProjectService; tasks: TaskService; workflow: IssueWorkflowPort; stateByTask: Map<string, IssueWorkflowState>; workflowInputsByTask: Map<string, IssueWorkflowInput>; planningInputsByTask: Map<string, StartPlanningInput>; adminId: string; companyId: string; projectId: string; profileId: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-task-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "https://forge.tailnet.ts.net:4111" });
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, auth, config, { localRepository, github, ...(options.githubRelease ? { githubRelease: options.githubRelease } : {}) });
  const company = auth.createCompany("admin-1", "Acme");
  const profile = projects.createProfile("admin-1", { name: "Default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const planner = projects.createAgent("admin-1", { name: "Planner", role: "planner", profileId: profile.id });
  const builder = projects.createAgent("admin-1", { name: "Builder", role: "builder", profileId: profile.id });
  const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
  const project = await projects.createProject("admin-1", company.id, { name: "Forge", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { planner: planner.id, builder: builder.id, reviewer: reviewer.id } });
  await projects.activateProject("admin-1", project.id);
  const stateByTask = new Map<string, IssueWorkflowState>();
  const workflowInputsByTask = new Map<string, IssueWorkflowInput>();
  const planningInputsByTask = new Map<string, StartPlanningInput>();
  let tasks!: TaskService;
  const workflow: IssueWorkflowPort = {
    async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) {
      workflowInputsByTask.set(input.issueId, { ...input, workflowId: input.workflowId! });
      const state = buildInitialIssueWorkflowState({ ...input, workflowId: input.workflowId! });
      stateByTask.set(input.issueId, state);
      database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run-1", eventId: state.lastEventId, state }));
      return { workflowId: state.workflowId, runId: "run-1" };
    },
    async execute(command, workflowId, input) {
      const current = [...stateByTask.values()].find((state) => state.workflowId === workflowId)!;
      if (input.expectedRevision !== current.revision) throw new Error("Stale workflow revision");
      if (command === "start_planning") planningInputsByTask.set(current.issueId, input as StartPlanningInput);
      if (command === "start_planning") {
        const next = { ...current, ...at("planning"), revision: 1, owner: "lead" as const, allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${workflowId}:1` };
        stateByTask.set(next.issueId, next);
        database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run-1", eventId: next.lastEventId, state: next }));
        return next;
      }
      if (command === "publish_draft") {
        const next = { ...current, ...at("releasing"), revision: current.revision + 1, owner: "lead" as const, allowedCommands: [], pendingAction: "Publishing one exact draft pull request", lastEventId: `${workflowId}:${current.revision + 1}` };
        stateByTask.set(next.issueId, next);
        projectState(database, next);
        return next;
      }
      if (command === "cancel_development") {
        const next = IssueWorkflowStateSchema.parse({ ...current, revision: current.revision + 1, allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer process interrupted", developerRecoveryStatus: "interrupted", lastEventId: `${workflowId}:${current.revision + 1}` });
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
      const projection = database.authQuery((db) => db.prepare("SELECT revision, step FROM forge_issue_projections WHERE workflow_id = ?").get(workflowId) as { revision: number; step: IssueWorkflowState["step"] });
      if (input.expectedRevision !== projection.revision) throw new Error("Stale workflow revision");
      const successor = await tasks.createTask("admin-1", company.id, { projectId: current.projectId, title: `Continue: ${current.issueId}`, description: `Continued from Forge issue ${current.issueId}: ${input.reason}`, idempotencyKey: `continue-${current.issueId}`, images: [] });
      const successorState = stateByTask.get(successor.task.id)!;
      const reasonArtifact = await new ArtifactStore(config.artifactRoot).putArtifact(company.id, "continuation-reason", { filename: "continuation-reason.md", mimeType: "text/markdown", bytes: Buffer.from(input.reason.trim(), "utf8") });
      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reasonArtifact.id, reasonArtifact.companyId, reasonArtifact.kind, reasonArtifact.filename, reasonArtifact.mimeType, reasonArtifact.byteSize, reasonArtifact.sha256, reasonArtifact.storagePath, reasonArtifact.createdAt);
        db.prepare("UPDATE forge_tasks SET predecessor_task_id = ? WHERE id = ?").run(current.issueId, successor.task.id);
        db.prepare("UPDATE forge_tasks SET successor_task_id = ? WHERE id = ?").run(successor.task.id, current.issueId);
        db.prepare("INSERT INTO forge_successor_intents (id, predecessor_task_id, predecessor_workflow_id, accepted_revision, successor_task_id, successor_workflow_id, company_id, project_id, project_revision_id, actor_user_id, reason_artifact_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?)").run(`intent_${workflowId}_7`, current.issueId, workflowId, 7, successor.task.id, successor.task.workflowId, company.id, current.projectId, successor.task.projectRevisionId, "admin-1", reasonArtifact.id, new Date().toISOString(), new Date().toISOString());
      });
      const next = IssueWorkflowStateSchema.parse({ ...current, ...at(projection.step), revision: projection.revision + 1, allowedCommands: [], pendingAction: "Continued in a new task", successorTaskId: successor.task.id, successorReference: { successorTaskId: successor.task.id, successorWorkflowId: successorState.workflowId, predecessorTaskId: current.issueId, projectRevisionId: successor.task.projectRevisionId, creationRevision: projection.revision }, lastEventId: `${workflowId}:${projection.revision + 1}` });
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
  return { root, config, database, auth, projects, tasks, workflow, stateByTask, workflowInputsByTask, planningInputsByTask, adminId: "admin-1", companyId: company.id, projectId: project.id, profileId: profile.id };
}

test("rebuilds a legacy delivery-blocked projection before listing tasks", async () => {
  const value = await fixture();
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", (request, _reply, done) => { request.forgeUser = { id: value.adminId } as never; done(); });
  await app.register(taskRoutes, { tasks: value.tasks });
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Legacy delivery blocker", description: "body", idempotencyKey: "legacy-delivery-blocker", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const { step: _step, ...legacy } = initial;
    void _step;
    value.database.authTransaction((db) => {
      db.prepare("UPDATE forge_workflow_snapshots SET state_json = ? WHERE task_id = ? AND revision = 0").run(JSON.stringify({ ...legacy, phase: "delivery_blocked" }), created.task.id);
      db.prepare("UPDATE forge_issue_projections SET phase = 'delivery_blocked', step = NULL WHERE task_id = ?").run(created.task.id);
    });

    expect(await rebuildDriftedIssueProjections(value.database, value.config)).toBe(1);

    const response = await app.inject({ method: "GET", url: `/api/companies/${value.companyId}/tasks` });
    expect(response.statusCode).toBe(200);
    expect(response.json().tasks).toEqual([expect.objectContaining({ id: created.task.id, phase: "building", step: "development", blocked: true })]);
  } finally {
    await app.close();
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("task details use the current unreleased worktree lease", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Worktree details", description: "body", idempotencyKey: "worktree-details-task", images: [] });
    const path = "/Users/x/forge/worktrees/acme/forge/task_11faa20d50cfa686e5bb197e";
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, legacy, status, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?)").run("worktree-details-lease", created.task.id, value.companyId, value.projectId, created.task.workflowId, "/Users/x/forge/repositories/acme/forge", "/Users/x/forge/worktrees/acme/forge", path, "work/worktree-details", "a".repeat(40), "b".repeat(64), new Date().toISOString()));
    expect(value.tasks.getTask(value.adminId, created.task.id).worktreePath).toBe(path);
    value.database.authQuery((db) => db.prepare("UPDATE forge_issue_worktrees SET status = 'released' WHERE id = ?").run("worktree-details-lease"));
    expect(value.tasks.getTask(value.adminId, created.task.id).worktreePath).toBeNull();
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});


test("Planning progress is timeline-backed and does not read legacy spools", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Planning progress", description: "body", idempotencyKey: "planning-progress-task", images: [] });
    const startedAt = "2026-08-11T00:00:00.000Z";
    const executionId = `agent_${"a".repeat(24)}`;
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, purpose, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 'planner', 'running', 1, 'planning', ?, ?)").run(executionId, created.task.id, value.companyId, created.task.workflowId, startedAt, startedAt));

    const first = value.tasks.getPlanningProgress(value.adminId, created.task.id);
    expect(first).toMatchObject({ status: "running", execution: { id: executionId, status: "running" } });
    expect(first.events).toEqual([]);
    expect(value.tasks.getPlanningProgress(value.adminId, created.task.id, { executionId, sequence: 0 }).events).toEqual([]);
    value.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ? WHERE id = ?").run(startedAt, executionId));
    expect(value.tasks.getPlanningProgress(value.adminId, created.task.id)).toMatchObject({ status: "failed", execution: { status: "failed" } });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a stuck cancellation can be safely reissued", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Cancel recovery", description: "body", idempotencyKey: "cancel-recovery-task", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const stuck = IssueWorkflowStateSchema.parse({ ...initial, ...at("development"), revision: 1, owner: "human", allowedCommands: [], pendingAction: "Cancelling Developer turn", developerExecutionId: `developer_${"a".repeat(24)}`, developerRecoveryStatus: "cancellation_requested", developerRecoverySummary: "Cancellation requested", lastEventId: `${initial.workflowId}:1` });
    value.stateByTask.set(created.task.id, stuck);
    projectState(value.database, stuck);

    await expect(value.tasks.executeCommand(value.adminId, created.task.id, "cancel_development", { expectedRevision: 1 })).resolves.toMatchObject({ revision: 2, developerRecovery: { status: "interrupted" } });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});


test("cancelling falls back to the projection when Engine rejects the update", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Rejected cancellation", description: "body", idempotencyKey: "rejected-workflow-cancel", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const blocked = IssueWorkflowStateSchema.parse({ ...initial, ...at("ci_waiting"), revision: 1, owner: "human", allowedCommands: [], pendingAction: "CI repair required", lastEventId: `${initial.workflowId}:1` });
    projectState(value.database, blocked);
    value.workflow.execute = async () => { throw new Error("Issue cancellation is not available in the current phase"); };

    await expect(value.tasks.executeCommand(value.adminId, created.task.id, "cancel_issue", { expectedRevision: 1 })).resolves.toMatchObject({ step: "cancelled", owner: "human", allowedCommands: [], pendingAction: "Issue cancelled", revision: 2 });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("non-terminal projections always expose cancellation", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Hidden cancellation", description: "body", idempotencyKey: "hidden-cancel-command", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const blocked = IssueWorkflowStateSchema.parse({ ...initial, ...at("merge_conflict_reviewing"), revision: 1, owner: "human", allowedCommands: [], pendingAction: "Review merge conflict", lastEventId: `${initial.workflowId}:1` });
    projectState(value.database, blocked);

    expect(value.tasks.getTask(value.adminId, created.task.id)).toMatchObject({ allowedCommands: ["cancel_issue", "send_planner_note"], commands: [expect.objectContaining({ name: "cancel_issue", expectedRevision: 1 }), expect.objectContaining({ name: "send_planner_note", expectedRevision: 1 })] });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("failed tasks with a plan expose and accept Developer retry", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Failed retry", description: "body", idempotencyKey: "failed-retry-task", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const failed = IssueWorkflowStateSchema.parse({ ...initial, ...at("development"), revision: 1, owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Development failed", planRevision: 1, blocker: { category: "agent_exhausted", summary: "Development failed", unblockOwner: "human", actions: [{ command: "retry_development", label: "Retry development", requiresNote: false, destructive: false }], evidence: { artifactId: "blocker", kind: "attention-evidence" }, createdAt: "2026-09-01T00:00:00.000Z", retry: null }, lastEventId: `${initial.workflowId}:1` });
    value.stateByTask.set(created.task.id, failed);
    projectState(value.database, failed);
    let acceptedCommand: string | undefined;
    let acceptedCommandId: string | undefined;
    value.workflow.acceptDevelopment = async (workflowId, input, command) => {
      acceptedCommand = command;
      acceptedCommandId = input.commandId;
      const next = IssueWorkflowStateSchema.parse({ ...failed, revision: input.expectedRevision + 1, ...at("development"), owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "Developer retry", blocker: null, lastEventId: `${workflowId}:${input.expectedRevision + 1}` });
      value.stateByTask.set(created.task.id, next);
      projectState(value.database, next);
      return next;
    };

    expect(value.tasks.getTask(value.adminId, created.task.id)).toMatchObject({ step: "development", blocked: true, allowedCommands: expect.arrayContaining(["retry_development"]) });
    await expect(value.tasks.executeCommand(value.adminId, created.task.id, "retry_development", { expectedRevision: 1 })).resolves.toMatchObject({ step: "development", revision: 2 });
    expect(acceptedCommand).toBe("retry_development");
    expect(acceptedCommandId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    expect(acceptedCommandId).not.toBe("legacy-command");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a Developer retry returns after the retry update is accepted", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Retry recovery", description: "body", idempotencyKey: "retry-recovery-task", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const interrupted = IssueWorkflowStateSchema.parse({ ...initial, ...at("development"), revision: 1, owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer retry is available", developerExecutionId: `developer_${"a".repeat(24)}`, developerRecoveryStatus: "interrupted", lastEventId: `${initial.workflowId}:1` });
    value.stateByTask.set(created.task.id, interrupted);
    projectState(value.database, interrupted);
    let acceptedCommand: string | undefined;
    value.workflow.acceptDevelopment = async (workflowId, input, command) => {
      acceptedCommand = command;
      const next = IssueWorkflowStateSchema.parse({ ...interrupted, revision: input.expectedRevision + 1, ...at("development"), owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "Developer retry", lastEventId: `${workflowId}:${input.expectedRevision + 1}` });
      value.stateByTask.set(created.task.id, next);
      projectState(value.database, next);
      return next;
    };

    await expect(value.tasks.executeCommand(value.adminId, created.task.id, "retry_development", { expectedRevision: 1 })).resolves.toMatchObject({ step: "development", revision: 2 });
    expect(acceptedCommand).toBe("retry_development");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("planning returns after its accepted projection while a rejected update remains rejected", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Accepted planning", description: "body", idempotencyKey: "accepted-planning-task", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    let resolvePending!: (state: IssueWorkflowState) => void;
    let began!: () => void;
    const beganPending = new Promise<void>((resolve) => { began = resolve; });
    const pending = new Promise<IssueWorkflowState>((resolve) => { resolvePending = resolve; });
    let pendingResolved = false;
    void pending.then(() => { pendingResolved = true; });
    value.workflow.acceptPlanning = () => {
      began();
      return pending;
    };

    const command = value.tasks.executeCommand(value.adminId, created.task.id, "start_planning", { expectedRevision: 0 });
    await beganPending;
    const planning = IssueWorkflowStateSchema.parse({ ...initial, ...at("planning"), revision: 1, owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${initial.workflowId}:1` });
    value.stateByTask.set(created.task.id, planning);
    projectState(value.database, planning);
    await expect(command).resolves.toMatchObject({ step: "planning", revision: 1 });
    expect(pendingResolved).toBe(false);
    resolvePending(planning);

    const rejected = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Rejected planning", description: "body", idempotencyKey: "rejected-planning-task", images: [] });
    value.workflow.acceptPlanning = async () => { throw new Error("workflow rejected the update"); };
    await expect(value.tasks.executeCommand(value.adminId, rejected.task.id, "start_planning", { expectedRevision: 0 })).rejects.toMatchObject({ statusCode: 409, findings: [expect.objectContaining({ code: "workflow-update-rejected" })] });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

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
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE idempotency_key = ?").get(conflictKey))).toEqual({ count: 1 });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("creates one durable backlog task, verifies immutable images, and starts planning with an expected revision", async () => {
  const value = await fixture();
  try {
    value.auth.setCompanyIssueCode(value.adminId, value.companyId, "acme");
    const events: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number; attentionChanged: boolean }> = [];
    const unsubscribe = value.tasks.subscribe(value.adminId, (event) => events.push(event));
    const first = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Investigate queue", description: "## Reproduce\n\nPlease inspect the queue.", idempotencyKey: "queue-task-0001", supplementalReview: true, images: [{ filename: "evidence.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
    await expect.poll(() => events).toHaveLength(1);
    unsubscribe();
    expect(first.created).toBe(true);
    expect(first.task.phase).toBe("backlog");
    expect(first.task.issueKey).toBe("ACME-1");
    expect(first.task.pendingAction).toBe("Start planning");
    expect(first.task.description).toContain("Reproduce");
    expect(value.database.authQuery((db) => db.prepare("SELECT t.brief_artifact_id AS briefArtifactId, t.project_configuration_artifact_id AS configurationArtifactId, COUNT(a.id) AS taskBriefArtifacts FROM forge_tasks t LEFT JOIN forge_artifacts a ON a.task_id = t.id AND a.kind = 'task-brief' WHERE t.id = ?").get(first.task.id))).toEqual({ briefArtifactId: first.task.projectRevisionId, configurationArtifactId: first.task.projectRevisionId, taskBriefArtifacts: 0 });
    expect(first.task.images).toHaveLength(1);
    expect(first.task.supplementalReview).toBe(true);
    expect(first.task.roleAgents.planner).toBeTruthy();
    expect(events).toEqual([{ type: "invalidate", taskId: first.task.id, companyId: value.companyId, revision: 0, attentionChanged: false }]);
    const initialSnapshot = value.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(first.task.id) as { state_json: string });
    const initialState = jsonRequired(initialSnapshot.state_json) as IssueWorkflowState;
    expect(initialState).toMatchObject({ issueId: first.task.id, repairCycle: 0 });
    expect(initialState).not.toHaveProperty("taskId");
    expect(() => projectState(value.database, initialState)).not.toThrow();
    const duplicate = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Investigate queue", description: "## Reproduce\n\nPlease inspect the queue.", idempotencyKey: "queue-task-0001", supplementalReview: true, images: [{ filename: "evidence.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
    expect(duplicate.created).toBe(false);
    expect(duplicate.task.id).toBe(first.task.id);
    await expect(value.tasks.executeCommand(value.adminId, first.task.id, "start_planning", { expectedRevision: 9 })).rejects.toMatchObject({ statusCode: 409, findings: [expect.objectContaining({ code: "stale-revision" })] });
    const planning = await value.tasks.executeCommand(value.adminId, first.task.id, "start_planning", { expectedRevision: 0 });
    expect(planning).toMatchObject({ step: "planning", revision: 1, owner: "lead", pendingAction: "Lead planning", allowedCommands: ["cancel_issue", "send_planner_note"] });
    expect(planning.timeline.map((entry) => entry.eventType)).toEqual(["task_created", "planning_started"]);
    expect(planning.activity).toEqual([
      expect.objectContaining({ kind: "workflow", eventType: "task_created", actor: { id: "admin-1", displayName: "Admin", username: "user_v1_admin-1", avatarSeed: "user_v1_admin-1" } }),
      expect.objectContaining({ kind: "member", eventType: "member_action", revision: 1, actor: { id: "admin-1", displayName: "Admin", username: "user_v1_admin-1", avatarSeed: "user_v1_admin-1" }, metadata: expect.objectContaining({ command: "start_planning", actionLabel: "Start planning" }) }),
      expect.objectContaining({ kind: "workflow", eventType: "planning_started", revision: 1 }),
    ]);
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, profile_id, model, reasoning_level, service_priority, started_at, finished_at, failure_code, failure_summary) VALUES ('agent-visible', ?, ?, ?, 'planner', 'failed', 1, ?, 'gpt-5.6-sol', 'medium', 'standard', '2026-08-11T01:00:00.000Z', '2026-08-11T01:00:02.000Z', 'model-unavailable', 'Select a supported model, then retry.')").run(first.task.id, first.task.companyId, first.task.workflowId, value.profileId));
    expect(value.tasks.getTask(value.adminId, first.task.id).agentInvocations).toEqual([expect.objectContaining({ id: "agent-visible", role: "planner", profileName: "Default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", status: "failed", attempt: 1, failureCode: "model-unavailable", failureSummary: "Select a supported model, then retry.", summary: "Select a supported model, then retry." })]);
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("normalizes legacy unknown delivery review attempt codes at the task read boundary", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Readable review attempts", description: "Keep legacy attempts readable.", idempotencyKey: "readable-review-attempts", images: [] });
    const executionId = "legacy-review-execution";
    const finishedAt = "2026-08-30T12:05:00.000Z";
    value.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, finished_at, failure_code, failure_summary) VALUES (?, ?, ?, ?, 'reviewer', 'failed', 1, ?, ?, 'worker-restart-orphan', 'worker stopped')").run(executionId, created.task.id, value.companyId, created.task.workflowId, finishedAt, finishedAt);
      const insertAttempt = db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, lead_session_ref, status, correction_attempts, failure_code, failure_summary, created_at, finished_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)");
      insertAttempt.run("legacy-orphan-attempt", created.task.id, value.companyId, created.task.workflowId, "a".repeat(40), "b".repeat(40), "c".repeat(40), executionId, "legacy-review-session", "failed", "worker-restart-orphan", "worker stopped", finishedAt, finishedAt);
      insertAttempt.run("valid-attempt", created.task.id, value.companyId, created.task.workflowId, "a".repeat(40), "d".repeat(40), "e".repeat(40), executionId, "legacy-review-session", "blocked", "rate-limited", "Retry later", finishedAt, finishedAt);
      insertAttempt.run("null-attempt", created.task.id, value.companyId, created.task.workflowId, "a".repeat(40), "f".repeat(40), "1".repeat(40), executionId, "legacy-review-session", "completed", null, null, finishedAt, finishedAt);
    });

    const parsed = TaskResponseSchema.parse(value.tasks.getTask(value.adminId, created.task.id));
    expect(Object.fromEntries(parsed.reviewLineage.reviewAttempts.map((attempt) => [attempt.id, attempt.code]))).toEqual({
      "legacy-orphan-attempt": "process-failed",
      "valid-attempt": "rate-limited",
      "null-attempt": null,
    });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("forwards an explicit plan auto-approval to the workflow with its creating member", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Auto approve", description: "Proceed after planning.", idempotencyKey: "auto-approve-plan-0001", autoApprovePlan: true, images: [] });
    expect(value.workflowInputsByTask.get(created.task.id)).toMatchObject({ autoApprovePlan: true, autoApprovePlanActorUserId: value.adminId });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("forwards auto-merge pull request handling with its creating member", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Auto merge", description: "Merge after approval.", idempotencyKey: "auto-merge-pull-request-0001", pullRequestMode: "auto_merge", images: [] });
    expect(value.workflowInputsByTask.get(created.task.id)).toMatchObject({ pullRequestMode: "auto_merge", autoMergeActorUserId: value.adminId });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("duplicates a task with the next copy suffix and starts planning", async () => {
  const value = await fixture();
  try {
    const source = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Improve README", description: "Keep this description.", idempotencyKey: "duplicate-source-0001", images: [{ filename: "evidence.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
    const duplicate = await value.tasks.duplicateTask(value.adminId, source.task.id, "duplicate-copy-0001");
    expect(duplicate).toMatchObject({ title: "Improve README (2)", description: "Keep this description.", projectId: source.task.projectId, roleAgents: source.task.roleAgents, step: "planning", images: [{ filename: "evidence.png", mimeType: "image/png" }] });
    expect(duplicate.images[0]?.artifactId).not.toBe(source.task.images[0]?.artifactId);
    const repeated = await value.tasks.duplicateTask(value.adminId, source.task.id, "duplicate-copy-0001");
    expect(repeated.id).toBe(duplicate.id);
    const next = await value.tasks.duplicateTask(value.adminId, source.task.id, "duplicate-copy-0002");
    expect(next.title).toBe("Improve README (3)");
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("normalizes an existing copy suffix when duplicating", async () => {
  const value = await fixture();
  try {
    const source = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Improve README (2)", description: "Keep this description.", idempotencyKey: "duplicate-normalized-source-0001", autoApprovePlan: true, pullRequestMode: "ready", images: [] });
    const duplicate = await value.tasks.duplicateTask(value.adminId, source.task.id, "duplicate-normalized-copy-0001");
    expect(duplicate).toMatchObject({ title: "Improve README (3)", autoApprovePlan: true, pullRequestMode: "ready" });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("updates task title and description without changing its workflow state", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Old title", description: "Old description", idempotencyKey: "edit-task-details-0001", images: [] });
    const updated = await value.tasks.updateTaskDetails(value.adminId, created.task.id, { title: "New title", description: "New description\nwith detail" });
    expect(updated).toMatchObject({ title: "New title", description: "New description\nwith detail", step: "backlog", revision: 0 });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});
test("stores the edited backlog description as runtime data", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Edit before planning", description: "Original brief", idempotencyKey: "edit-before-planning-0001", images: [] });
    const updated = await value.tasks.updateTaskDetails(value.adminId, created.task.id, { description: "Edited brief" });
    await value.tasks.executeCommand(value.adminId, created.task.id, "start_planning", { expectedRevision: updated.revision });
    expect(value.database.authQuery((db) => db.prepare("SELECT description FROM forge_tasks WHERE id = ?").get(created.task.id))).toEqual({ description: "Edited brief" });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts WHERE company_id = ? AND kind = 'task-brief'").get(value.companyId))).toEqual({ count: 0 });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});
test("keeps task descriptions mutable while planning is active", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Mutable planning brief", description: "Original brief", idempotencyKey: "mutable-planning-brief-0001", images: [] });
    await value.tasks.executeCommand(value.adminId, created.task.id, "start_planning", { expectedRevision: created.task.revision });
    await expect(value.tasks.updateTaskDetails(value.adminId, created.task.id, { description: "Changed brief" })).resolves.toMatchObject({ description: "Changed brief", phase: "planning" });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});



test("retries draft publication from a typed provider-failure state", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Retry release", description: "Reviewed delivery", idempotencyKey: "retry-release-0001", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const blocked = IssueWorkflowStateSchema.parse({ ...initial, ...at("releasing"), revision: 1, owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "GitHub provider request failed", blocker: { category: "provider_connectivity_exhausted", summary: "GitHub provider request failed", unblockOwner: "human", actions: [{ command: "publish_draft", label: "Retry publication", requiresNote: false, destructive: false }], evidence: { artifactId: "blocker", kind: "attention-evidence" }, createdAt: "2026-09-01T00:00:00.000Z", retry: null }, releaseStatus: "blocked", releaseFailureCode: "provider-unavailable", releaseFailureSummary: "GitHub provider request failed", lastEventId: `${initial.workflowId}:1` });
    value.stateByTask.set(created.task.id, blocked);
    projectState(value.database, blocked);
    expect(value.tasks.getTask(value.adminId, created.task.id)).toMatchObject({ step: "releasing", blocked: true, pendingAction: "GitHub provider request failed" });

    const retried = await value.tasks.executeCommand(value.adminId, created.task.id, "publish_draft", { expectedRevision: 1 });
    expect(retried).toMatchObject({ step: "releasing", revision: 2, pendingAction: "Publishing one exact draft pull request" });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("tells the operator to refresh when the workflow rejects a stale projected action", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Stale release action", description: "Reviewed delivery", idempotencyKey: "stale-release-action-0001", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const projected = IssueWorkflowStateSchema.parse({ ...initial, revision: 1, ...at("releasing"), owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Publish again", lastEventId: `${initial.workflowId}:1` });
    value.stateByTask.set(created.task.id, projected);
    projectState(value.database, projected);
    value.workflow.execute = async () => {
      const current = IssueWorkflowStateSchema.parse({ ...projected, revision: 2, allowedCommands: ["cancel_issue"], pendingAction: "Publication is unavailable", lastEventId: `${initial.workflowId}:2` });
      value.stateByTask.set(created.task.id, current);
      projectState(value.database, current);
      throw new Error("Draft publication is not available in the current phase");
    };

    await expect(value.tasks.executeCommand(value.adminId, created.task.id, "publish_draft", { expectedRevision: 1 })).rejects.toMatchObject({ message: "Refresh — this action is no longer available" });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("surfaces the durable handler reason when a plan decision is rejected", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Rejected approval", description: "Reviewed delivery", idempotencyKey: "rejected-approval-0001", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const approval = IssueWorkflowStateSchema.parse({ ...initial, revision: 1, ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue"], pendingAction: "Approve final plan", lastEventId: `${initial.workflowId}:1` });
    value.stateByTask.set(created.task.id, approval);
    projectState(value.database, approval);
    value.workflow.execute = async () => {
      const rejected = IssueWorkflowStateSchema.parse({ ...approval, revision: 2, lastEventId: `${approval.workflowId}:2`, lastHandlerError: { command: "approve_plan", reason: "The plan references an unavailable target branch", at: "2026-08-24T00:00:00.000Z" } });
      value.stateByTask.set(created.task.id, rejected);
      projectState(value.database, rejected);
      throw new Error("workflow rejected the update");
    };

    await expect(value.tasks.executeCommand(value.adminId, created.task.id, "approve_plan", { expectedRevision: 1, note: "Ship it", idempotencyKey: "approval-reason-0001" })).rejects.toMatchObject({ message: "The plan references an unavailable target branch" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("shows the current target-base blocker instead of stale Developer recovery text", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Review blocked delivery", description: "Reviewed delivery", idempotencyKey: "review-blocked-0001", images: [] });
    const initial = value.stateByTask.get(created.task.id)!;
    const blocked = IssueWorkflowStateSchema.parse({ ...initial, revision: 1, ...at("delivery_reviewed"), owner: "human", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: "mise run test did not complete successfully", blocker: { category: "agent_exhausted", summary: "mise run test did not complete successfully", unblockOwner: "human", actions: [{ command: "retry_forward_merge_verification", label: "Retry verification", requiresNote: false, destructive: false }], evidence: { artifactId: "blocker", kind: "attention-evidence" }, createdAt: "2026-09-01T00:00:00.000Z", retry: null }, developerRecoveryStatus: "active", developerRecoverySummary: "Developer repair result claimed.", targetBaseBlockerCode: "verification_failed", targetBaseBlockerSummary: "mise run test did not complete successfully", lastEventId: `${initial.workflowId}:1` });
    value.stateByTask.set(created.task.id, blocked);
    projectState(value.database, blocked);

    expect(value.tasks.getTask(value.adminId, created.task.id)).toMatchObject({ step: "delivery_reviewed", blocked: true, pendingAction: "mise run test did not complete successfully" });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("does not rewind the latest projection when a legacy revision-zero seed remains", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Legacy seed", description: "body", idempotencyKey: "legacy-seed-0001", images: [] });
    const snapshot = value.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(created.task.id) as { state_json: string });
    const canonical = jsonRequired(snapshot.state_json) as IssueWorkflowState;
    const planning = IssueWorkflowStateSchema.parse({ ...canonical, revision: 1, ...at("planning"), owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${canonical.workflowId}:1` });
    const approval = IssueWorkflowStateSchema.parse({ ...planning, revision: 2, ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "reject_plan", "cancel_issue"], pendingAction: "Approve final plan", lastEventId: `${canonical.workflowId}:2` });
    projectState(value.database, planning);
    projectState(value.database, approval);
    const { issueId, repairCycle: _repairCycle, ...seed } = canonical;
    void _repairCycle;
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
    expect(jsonRequired(repaired.snapshot.state_json)).toEqual(legacy);
    expect(repaired.timeline.event_hash).toBe(legacyHash);
    expect(repaired.projection).toEqual({ revision: 2, event_hash: projectionStateHash(approval) });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("streams projection changes written by the Engine worker process", async () => {
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
      projectState(workerDatabase, IssueWorkflowStateSchema.parse(jsonRequired(JSON.stringify({ ...created.task, issueId: created.task.id, projectRevisionId: created.task.projectRevisionId, revision: 1, ...at("planning"), owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${created.task.workflowId}:1`, continuationCount: 0, lastSummaryHash: null, repairCycle: 0 }))), "run-worker");
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

/* Projection revisions now follow the workflow after resets. The monotonic
 * projection assertion was removed with that behavior. */
/*
test("projection writes are monotonic and corrupted or traversing artifacts fail closed", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Artifact task", description: "body", idempotencyKey: "artifact-task-0001", images: [{ filename: "proof.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
    const imageId = created.task.images[0]!.artifactId;
    const artifact = value.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ?").get(imageId) as { storage_path: string });
    await writeFile(join(value.root, "artifacts", artifact.storage_path), "corrupted");
    await expect(value.tasks.getTaskImage(value.adminId, created.task.id, imageId)).rejects.toMatchObject({ code: "hash-mismatch" });
    await expect(value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Traversal", description: "body", idempotencyKey: "artifact-task-0002", images: [{ filename: "../secret.png", mimeType: "image/png", base64: Buffer.from("proof").toString("base64") }] })).rejects.toMatchObject({ findings: [expect.objectContaining({ code: "invalid-image-filename" })] });
    const initial = IssueWorkflowStateSchema.parse(jsonRequired(value.database.authQuery((db) => (db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(created.task.id) as { state_json: string }).state_json));
    const newer = IssueWorkflowStateSchema.parse({ ...initial, revision: 4, step: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${created.task.workflowId}:4` });
    const stale = IssueWorkflowStateSchema.parse({ ...initial, revision: 2, lastEventId: `${created.task.workflowId}:2` });
    value.database.projectIssueEvent({ schemaVersion: 1, runId: "run-1", eventId: newer.lastEventId, state: newer });
    value.database.projectIssueEvent({ schemaVersion: 1, runId: "run-1", eventId: stale.lastEventId, state: stale });
    expect(value.database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = ?").get(created.task.id))).toEqual({ revision: 4, phase: "planning" });
    await readFile(join(value.root, "artifacts", artifact.storage_path));
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

*/

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
    value.auth.setCompanyIssueCode(value.adminId, value.companyId, "acme");
    const original = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Finished issue", description: "Preserve this history.", idempotencyKey: "continue-task-0001", images: [] });
    const initialSnapshot = value.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(original.task.id) as { state_json: string });
    const initialState = jsonRequired(initialSnapshot.state_json) as IssueWorkflowState;
    for (let revision = 1; revision < 7; revision += 1) {
      const state = IssueWorkflowStateSchema.parse({ ...initialState, ...at("planning"), revision, owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${original.task.workflowId}:${revision}` });
      value.database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state }));
    }
    const terminalState = IssueWorkflowStateSchema.parse({ ...initialState, ...at("done"), revision: 7, owner: "human", allowedCommands: [], pendingAction: null, lastEventId: `${original.task.workflowId}:7` });
    value.database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: terminalState.lastEventId, state: terminalState }));
    const continued = await value.tasks.continueWork(value.adminId, original.task.id, 7, "Continue implementation after the completed issue.");
    expect([continued.original.issueKey, continued.successor.issueKey]).toEqual(["ACME-1", "ACME-2"]);
    expect(continued.original.phase).toBe("done");
    expect(continued.successor.predecessorTaskId).toBe(original.task.id);
    expect(continued.original.successor).toMatchObject({ id: continued.successor.id, issueKey: "ACME-2", title: continued.successor.title, phase: "backlog" });
    expect(continued.successor.predecessor).toMatchObject({ id: original.task.id, issueKey: "ACME-1", title: original.task.title, phase: "done" });
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

test("pins versioned resolved prompt artifacts at task creation", async () => {
  const value = await fixture();
  try {
    const now = new Date().toISOString();
    value.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_prompt_overrides (id, scope, project_id, scope_key, template_id, mode, content, base_template_sha256, current_revision, updated_by_user_id, created_at, updated_at) VALUES ('prompt-override', 'project', ?, ?, 'lead/plan', 'append', 'project guidance', ?, 1, 'admin-1', ?, ?)").run(value.projectId, value.projectId, "x", now, now);
    });
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Prompt snapshot", description: "body", idempotencyKey: "prompt-snapshot-task", images: [] });
    const artifact = value.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE task_id = ? AND kind = 'task-prompt-set'").get(created.task.id) as { storage_path: string; sha256: string });
    const promptSet = JSON.parse(new ArtifactStore(value.config.artifactRoot).getArtifactSync({ companyId: value.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 }).toString("utf8"));
    expect(promptSet).toMatchObject({ version: 2, prompts: { "lead/plan.md": expect.stringContaining("project guidance") }, provenance: { "lead/plan": expect.any(Object) } });
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("re-resolves a pull request selector and pins source and PR base coordinates", async () => {
  let requestedNumber: number | undefined;
  const pull = { number: 17, url: "https://github.com/acme/forge/pull/17", repository: "acme/forge", headBranch: "feature/source", baseBranch: "release", headSha: "c".repeat(40), baseSha: "d".repeat(40), isDraft: false, state: "open" as const, mergedAt: null };
  const value = await fixture({ githubRelease: { async listOpenPullRequests() { return [pull]; }, async getPullRequest(input) { requestedNumber = input.number; return pull; } } });
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Continue source PR", description: "Use the selected pull request.", idempotencyKey: "source-pr-create-0001", images: [], source: { kind: "pull_request", number: 17 } });
    expect(requestedNumber).toBe(17);
    const configuration = value.database.authQuery((db) => loadTaskConfiguration(db, new ArtifactStore(value.config.artifactRoot, value.database), { taskId: created.task.id, companyId: value.companyId }));
    expect(configuration).toMatchObject({ baseBranch: "release", baseSha: "d".repeat(40), targetBranch: "main", targetSha: "b".repeat(40), source: { kind: "pull_request", number: 17, headBranch: "feature/source", baseBranch: "release", headSha: "c".repeat(40), baseSha: "d".repeat(40) } });
    expect(value.tasks.getTask(value.adminId, created.task.id).source).toEqual({ kind: "pull_request", number: 17, url: pull.url, headBranch: "feature/source", baseBranch: "release" });
    expect(TaskResponseSchema.parse(value.tasks.getTask(value.adminId, created.task.id)).source).toEqual({ kind: "pull_request", number: 17, url: pull.url, headBranch: "feature/source", baseBranch: "release" });
    const duplicate = await value.tasks.duplicateTask(value.adminId, created.task.id, "source-pr-duplicate-0001");
    expect(duplicate.source).toEqual({ kind: "pull_request", number: 17, url: pull.url, headBranch: "feature/source", baseBranch: "release" });
    expect(value.workflowInputsByTask.get(duplicate.id)).toMatchObject({ repository: "acme/forge", source: { kind: "pull_request", number: 17, url: pull.url, headBranch: "feature/source", baseBranch: "release", headSha: "c".repeat(40), baseSha: "d".repeat(40) } });


    const capturedConfiguration = structuredClone(configuration) as Record<string, unknown>;
    delete capturedConfiguration.artifactId;
    delete capturedConfiguration.artifactSha256;
    const branchConfiguration = { ...capturedConfiguration, source: { kind: "branch" as const, branch: "feature/branch", headSha: "e".repeat(40) } };
    const store = new ArtifactStore(value.config.artifactRoot, value.database);
    const artifact = await store.putArtifact(value.companyId, "task-project-configuration", { filename: "task-project-configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(branchConfiguration)) });
    value.database.authTransaction((db) => {
      db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ? WHERE id = ?").run(artifact.id, created.task.id);
    });
    expect(value.tasks.getTask(value.adminId, created.task.id).source).toEqual({ kind: "branch", branch: "feature/branch" });
    expect(TaskResponseSchema.parse(value.tasks.getTask(value.adminId, created.task.id)).source).toEqual({ kind: "branch", branch: "feature/branch" });

    const scratch = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Scratch task", description: "No source.", idempotencyKey: "scratch-source-create-0001", images: [] });
    expect(value.tasks.getTask(value.adminId, scratch.task.id).source).toBeUndefined();
    expect(TaskResponseSchema.parse(value.tasks.getTask(value.adminId, scratch.task.id)).source).toBeUndefined();
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Developer diff follows current release coordinates after a branch rebase", async () => {
  const value = await fixture();
  const repositoryPath = join(value.root, "repositories", "repo");
  const worktreeRoot = join(value.root, "worktrees");
  try {
    await git(["init", "-b", "main"], repositoryPath);
    await git(["config", "user.name", "Forge Test"], repositoryPath);
    await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
    await git(["config", "commit.gpgsign", "false"], repositoryPath);
    await writeFile(join(repositoryPath, "README.md"), "fixture\n");
    await git(["add", "README.md"], repositoryPath);
    await git(["commit", "-m", "fixture"], repositoryPath);
    const staleBaseSha = await git(["rev-parse", "HEAD"], repositoryPath);
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Rebased diff", description: "body", idempotencyKey: "rebased-developer-diff", images: [] });
    const manager = new WorktreeManager();
    const worktree = await manager.create({ repositoryPath, worktreeRoot, taskId: created.task.id, targetBaseSha: staleBaseSha, branchName: "work/rebased-diff" });
    await writeFile(join(worktree.worktreePath, "DELIVERY.md"), "delivery\n");
    await git(["add", "DELIVERY.md"], worktree.worktreePath);
    await git(["commit", "-m", "delivery"], worktree.worktreePath);
    const recordedHeadSha = await git(["rev-parse", "HEAD"], worktree.worktreePath);
    const recordedTreeSha = await git(["rev-parse", "HEAD^{tree}"], worktree.worktreePath);
    await writeFile(join(repositoryPath, "BASE.md"), "new base\n");
    await git(["add", "BASE.md"], repositoryPath);
    await git(["commit", "-m", "advance base"], repositoryPath);
    const currentBaseSha = await git(["rev-parse", "HEAD"], repositoryPath);
    await git(["rebase", currentBaseSha], worktree.worktreePath);
    const currentHeadSha = await git(["rev-parse", "HEAD"], worktree.worktreePath);
    const currentTreeSha = await git(["rev-parse", "HEAD^{tree}"], worktree.worktreePath);
    const now = new Date().toISOString();
    value.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, finished_at, result_commit, result_tree, dirty_state) VALUES ('developer-rebased-diff', ?, ?, ?, 1, 1, 'completed', ?, ?, ?, ?, ?, ?, ?, 'clean')").run(created.task.id, value.companyId, created.task.workflowId, worktree.branchName, worktree.worktreePath, staleBaseSha, now, now, recordedHeadSha, recordedTreeSha);
      db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-rebased-diff', ?, ?, ?, 'release-rebased-diff-key', 'acme/forge', ?, 'main', ?, ?, ?, 'ready', 86, 'https://github.com/acme/forge/pull/86', 'Rebased diff', ?, ?)").run(created.task.id, value.companyId, created.task.workflowId, worktree.branchName, currentBaseSha, currentHeadSha, currentTreeSha, now, now);
    });

    const live = await value.tasks.getDeveloperDiff(value.adminId, created.task.id);
    expect(live.diff).toMatchObject({ branchName: worktree.branchName, baseSha: currentBaseSha, headSha: currentHeadSha });
    expect(live.diff.patch).toContain("diff --git a/DELIVERY.md b/DELIVERY.md");
    expect(live.diff.patch).not.toContain("BASE.md");
    expect(live.etag.startsWith(`${currentBaseSha}:${currentHeadSha}:`)).toBe(true);

    await manager.remove(repositoryPath, worktree.worktreePath);
    const recorded = await value.tasks.getDeveloperDiff(value.adminId, created.task.id);
    expect(recorded.diff).toMatchObject({ branchName: worktree.branchName, baseSha: currentBaseSha, headSha: currentHeadSha });
    expect(recorded.diff.patch).toContain("diff --git a/DELIVERY.md b/DELIVERY.md");
    expect(recorded.diff.patch).not.toContain("BASE.md");
    expect(recorded.etag).toBe(`${currentBaseSha}:${currentHeadSha}:missing:0`);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("branch sync route reports unavailable before a task has a worktree", async () => {
  const value = await fixture();
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", (request, _reply, done) => { request.forgeUser = { id: value.adminId } as never; done(); });
  await app.register(taskBranch, { tasks: value.tasks });
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "No worktree", description: "body", idempotencyKey: "branch-sync-no-worktree", images: [] });
    const response = await app.inject({ method: "GET", url: `/api/tasks/${created.task.id}/branch-sync` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false });
  } finally {
    await app.close(); value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("company branch sync queries only active task branches", async () => {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", (request, _reply, done) => { request.forgeUser = { id: "admin-1" } as never; done(); });
  const queriedTaskIds: string[] = [];
  await app.register(taskBranch, { tasks: {
    listTasks: () => [{ id: "building", phase: "building" }, { id: "done", phase: "done" }, { id: "cancelled", phase: "cancelled" }],
    async getBranchSync(_actorUserId: string, taskId: string) {
      queriedTaskIds.push(taskId);
      return { branchName: "feat/building", worktreePath: "/tmp/building", remoteExists: true, ahead: 0, behind: 0, aheadOfBase: 2, behindBase: 1, conflictsWithBase: false, headSha: "a".repeat(40) };
    },
  } as unknown as TaskService });
  try {
    const response = await app.inject({ method: "GET", url: "/api/companies/company-1/branch-sync" });
    expect(response.statusCode).toBe(200);
    expect(queriedTaskIds).toEqual(["building"]);
    expect(response.json()).toEqual({ building: { ahead: 0, behind: 0, aheadOfBase: 2, behindBase: 1, conflictsWithBase: false, remoteExists: true } });
  } finally { await app.close(); }
});

test("task event polling ignores projection hash changes when list-visible fields are unchanged", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Stable list projection", description: "body", idempotencyKey: "stable-list-projection", images: [] });
    const events: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number; attentionChanged: boolean }> = [];
    const unsubscribe = value.tasks.subscribe(value.adminId, (event) => events.push(event));
    try {
      value.database.authQuery((db) => db.prepare("UPDATE forge_issue_projections SET event_hash = ? WHERE task_id = ?").run("f".repeat(64), created.task.id));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("task event polling invalidates once when pending action changes", async () => {
  const value = await fixture();
  try {
    const created = await value.tasks.createTask(value.adminId, value.companyId, { projectId: value.projectId, title: "Changed list projection", description: "body", idempotencyKey: "changed-list-projection", images: [] });
    const events: Array<{ type: "invalidate"; taskId: string; companyId: string; revision: number; attentionChanged: boolean }> = [];
    const unsubscribe = value.tasks.subscribe(value.adminId, (event) => events.push(event));
    try {
      value.database.authQuery((db) => db.prepare("UPDATE forge_issue_projections SET pending_action = ? WHERE task_id = ?").run("Review the updated task", created.task.id));
      await expect.poll(() => events).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(events).toEqual([{ type: "invalidate", taskId: created.task.id, companyId: value.companyId, revision: 0, attentionChanged: false }]);
    } finally {
      unsubscribe();
    }
  } finally {
    value.database.close(); await rm(value.root, { recursive: true, force: true });
  }
});

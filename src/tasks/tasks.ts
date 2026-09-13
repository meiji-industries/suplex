import type { WorkerReplacementRequest } from "../coordination/worker-replacement-contracts.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TaskAnalyticsStore } from "./analytics/store.js";
import { taskAnalytics } from "./analytics/analytics.js";
import { readTaskTimeline } from "./timeline/timeline.js";
import { removeTaskWorktree } from "./worktree.js";
import { stopIdleArchiveSessions } from "./archive/sessions.js";
import { z } from "zod";
import type { AuthService } from "../identity/auth.js";
import { ArtifactStore, type StoredArtifact } from "../platform/artifacts.js";
import type { ForgeConfig } from "../platform/config.js";
import type { ForgeDatabase } from "../platform/database.js";
import type { HermesPrincipal } from "../identity/hermes-agents.js";
import { HermesSafeTaskProjectionSchema, HermesTaskCommandBodySchema, HermesTaskCreateBodySchema, type HermesSafeTaskProjection, type HermesTaskCreateBody, type HermesTaskFilter, type HermesTaskReadProjection } from "../http/contracts/hermes.js";
import { createGithubReleasePort, GithubReleaseFailure, type GithubReleasePort } from "../integrations/github/delivery.js";
import { deriveActionRequired, deriveTaskIntegration, isUpstreamOf, matchesHermesFilter, observableDelivery, type PullRequestObservationResult } from "./integration.js";
import { ProjectAgentTaskPolicySchema, type ProjectAgentTaskPolicy } from "../http/contracts/projects.js";
import { CreateTaskTemplateBodySchema } from "../http/contracts/task-templates.js";
import { TaskDetailsBodySchema } from "../http/contracts/tasks.js";
import { WorkflowRecordInputSchema } from "../http/contracts/workflows.js";
import type { ProjectService } from "../projects/projects.js";
import { TaskProfileSchema, type TaskProfile } from "./control.js";
import { MAX_TASK_DEPENDENCIES, TaskConfigurationSchema, TaskImageInputSchema, TaskInputSchema, type Task, type TaskInput } from "./contracts.js";
import { replaceTaskDependencies, TaskDependencyFailure } from "./dependencies.js";
import { duplicateTitle } from "./duplicate-title.js";
import { decodeTaskImage } from "./images.js";
import { taskBranchName } from "./branch.js";
import { newTaskId, TaskConflict, TaskRepository, taskRequestHash, type TaskCreator, type TaskRow } from "./repository.js";
import { GithubTriggerDispatchRepository, type GithubTriggerDispatch } from "../integrations/github/trigger-dispatches.js";
import { assertTaskPullRequestsAvailable } from "../delivery/pull-request-ownership.js";
import type { GithubTriggerPort } from "../integrations/github/trigger-inspection.js";
import { matchesGithubTriggerProtectedPaths } from "../integrations/github/trigger-paths.js";
import { normalizeWorkflowInput, roleLabel, workflowDefinition, WorkflowInputFailure, type AdvisorRole } from "../coordination/workflows.js";
import type { TaskLimitDecision } from "./limits/limits.js";
import { CliHerdrClient } from "../integrations/herdr/client.js";
import { ensureTaskShellPane, type TaskPanePort } from "../runtimes/task-display.js";

export class TaskFailure extends Error {
  constructor(readonly publicMessage: string, readonly statusCode = 400, readonly code = "task_failure", options?: { cause?: unknown }) {
    super(publicMessage);
    this.cause = options?.cause;
  }
}
type Authority = { kind: "user"; userId: string } | { kind: "hermes"; principal: HermesPrincipal };
export type HermesGithubPort = Pick<Required<GithubReleasePort>, "observePullRequest">;
type HermesCommand = z.infer<typeof HermesTaskCommandBodySchema>;
const HERMES_COMMAND_AUDITS: Record<HermesCommand["command"], string> = {
  start_task: "task_started", cancel_task: "task_cancelled", archive_task: "task_archived", unarchive_task: "task_unarchived",
  send_task_note: "task_note_added", duplicate_task: "task_duplicated", recheck_delivery_wait: "delivery_wait_recheck_requested",
};
/** Commands running anywhere in this process. Keyed without the service instance so siblings sharing a database agree. */
const hermesCommandsInFlight = new Set<string>();
/** Tasks whose worktree is being removed anywhere in this process. Start and unarchive refuse while a task is listed. */
const archivesInProgress = new Set<string>();
const hermesCommandKey = (agentId: string, taskId: string, key: string): string => JSON.stringify([agentId, taskId, key]);
const hermesDuplicateKey = (taskId: string, key: string): string => `duplicate-${createHash("sha256").update(`${taskId}:${key}`).digest("hex")}`;
/** ponytail: one page of the agent's own tasks feeds upstream dependency lookup; page it if an agent ever owns more. */
const HERMES_UPSTREAM_POOL = 200;
type Projects = Pick<ProjectService, "getProject" | "getProjectInCompany" | "resolveTaskSource" | "captureTaskConfiguration">;
/** Worktree removal defaults to the real host; tests drive a controlled one. */
export type TaskServicePorts = { removeWorktree?: typeof removeTaskWorktree; herdr?: TaskPanePort };
const DetailsSchema = TaskDetailsBodySchema.refine(input => Object.keys(input).length > 0);
const RenameSchema = TaskInputSchema.pick({ title: true });
const DependsOnSchema = z.array(z.string().min(1).max(256)).max(MAX_TASK_DEPENDENCIES);
const BlockedBySchema = z.object({ blockedByTaskId: z.string().min(1).max(256).nullable() }).strict();

export class TaskService {
  private readonly removeWorktree: typeof removeTaskWorktree;
  private readonly herdr: TaskPanePort;
  readonly repository: TaskRepository;
  private readonly artifacts: ArtifactStore;
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly projects: Projects, config: Pick<ForgeConfig, "artifactRoot">, ports: TaskServicePorts = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot, database);
    this.repository = new TaskRepository(database, this.artifacts);
    this.removeWorktree = ports.removeWorktree ?? removeTaskWorktree;
    this.herdr = ports.herdr ?? new CliHerdrClient();
  }

  getTask(userId: string, taskId: string): Task {
    return this.repository.task(this.requireTask({ kind: "user", userId }, taskId));
  }

  analytics(userId: string, companyId: string) {
    const store = new TaskAnalyticsStore(this.database);
    const tasks = [...this.listTasks(userId, companyId), ...this.listTasks(userId, companyId, true)];
    return { generatedAt: new Date().toISOString(), tasks: tasks.map(task => taskAnalytics(task, this.repository.controls.sessions(task.id), store.read(task.id))) };
  }

  async timeline(userId: string, taskIds: string[]) {
    const tasks = taskIds.map(id => this.getTask(userId, id));
    const store = new TaskAnalyticsStore(this.database);
    const result = await readTaskTimeline(this.database.filename(), tasks, tasks.flatMap(task => this.repository.controls.sessions(task.id)), id => store.read(id).usage);
    for (const id of taskIds) this.getTask(userId, id);
    return result;
  }

  listTasks(userId: string, companyId?: string, archived = false): Task[] {
    const companies = new Set(this.auth.listVisibleCompanies(userId).map(company => company.id));
    if (companyId && !companies.has(companyId)) throw new TaskFailure("Not found", 404);
    return this.repository.rows().filter(row => companies.has(row.company_id) && (!companyId || row.company_id === companyId) && Boolean(row.archived_at) === archived).map(row => this.repository.task(row));
  }

  async createTask(userId: string, companyId: string, input: TaskInput): Promise<{ task: Task; created: boolean }> {
    return this.create({ kind: "user", userId }, companyId, input);
  }

  /** Internal-only admission path for an immutable, previously validated trigger dispatch. */
  async createTaskFromGithubTrigger(dispatchId: string): Promise<{ task: Task; created: boolean }> {
    const dispatches = new GithubTriggerDispatchRepository(this.database);
    const dispatch = dispatches.get(dispatchId);
    if (!dispatch) throw new TaskFailure("GitHub trigger dispatch was not found", 404);
    if (dispatch.request.startImmediately || dispatch.request.images.length) throw new TaskFailure("GitHub trigger dispatch is invalid", 422);
    if (dispatch.taskId) return { task: this.getTask(dispatch.authorityUserId, dispatch.taskId), created: false };
    this.requireGithubTriggerAdmission(dispatch);
    return this.create({ kind: "user", userId: dispatch.authorityUserId }, dispatch.companyId, dispatch.request, dispatch);
  }

  async startTaskFromGithubTrigger(dispatchId: string, github: Pick<GithubTriggerPort, "inspectPullRequest">): Promise<Task> {
    const dispatch = new GithubTriggerDispatchRepository(this.database).get(dispatchId);
    if (!dispatch || !dispatch.taskId) throw new TaskFailure("GitHub trigger dispatch is not linked to a task", 404);
    const existing = this.getTask(dispatch.authorityUserId, dispatch.taskId);
    if (existing.archivedAt || existing.status !== "backlog") return existing;
    this.requireGithubTriggerAdmission(dispatch);
    const pull = await github.inspectPullRequest({ repository: dispatch.repositoryName, number: dispatch.pullRequestNumber });
    const protectedPath = pull.files.some(file => [file.filename, file.previousFilename].some(path => path && matchesGithubTriggerProtectedPaths(dispatch.policy.protectedPaths, { filename: path })));
    const valid = pull.number === dispatch.pullRequestNumber && pull.state === "open" && !pull.isDraft && !pull.isCrossRepository && pull.baseRepository.id === dispatch.repositoryId && pull.baseRepository.fullName.toLowerCase() === dispatch.repositoryName && pull.headRepository?.id === dispatch.repositoryId && pull.headRepository.fullName.toLowerCase() === dispatch.repositoryName && pull.headSha === dispatch.policy.headSha && pull.baseSha === dispatch.policy.baseSha && pull.headBranch === dispatch.policy.headBranch && pull.baseBranch === dispatch.policy.baseBranch && pull.labels.includes(this.database.authQuery(db => db.prepare("SELECT label FROM forge_github_trigger_rules WHERE id = ?").get(dispatch.ruleId) as { label: string }).label) && !protectedPath;
    if (!valid) throw new TaskFailure("GitHub trigger pull request is no longer eligible", 409);
    return this.database.authImmediateTransaction(() => {
      const current = new GithubTriggerDispatchRepository(this.database).get(dispatchId);
      if (!current?.taskId) throw new TaskFailure("GitHub trigger dispatch is not linked to a task", 404);
      const task = this.getTask(current.authorityUserId, current.taskId);
      if (task.archivedAt || task.status !== "backlog") return task;
      this.requireGithubTriggerAdmission(current);
      const source = task.configuration.source;
      if (task.configuration.repository.toLowerCase() !== current.repositoryName || task.configuration.startingSha !== current.policy.headSha || task.configuration.baselineSha !== current.policy.baseSha || task.configuration.branch !== current.policy.headBranch || task.configuration.baseBranch !== current.policy.baseBranch || source?.kind !== "pull_request" || source.number !== current.pullRequestNumber) throw new TaskFailure("GitHub trigger task source changed", 409);
      return this.startTask(current.authorityUserId, current.taskId);
    });
  }

  async createTaskForHermes(principal: HermesPrincipal, input: HermesTaskCreateBody, copiedFromTaskId?: string) {
    const untrusted: Record<string, unknown> = { ...input };
    delete untrusted.companyId;
    delete untrusted.agentId;
    delete untrusted.startImmediately;
    let raw: HermesTaskCreateBody;
    try { raw = HermesTaskCreateBodySchema.strict().parse(untrusted); }
    catch { throw new TaskFailure("Invalid request", 400, "request_invalid"); }
    const authority: Authority = { kind: "hermes", principal };
    const creator: TaskCreator = { kind: "agent", id: principal.agentId };
    const requestHash = this.hermesRequestHash(raw, creator);
    this.requireScope(authority, principal.companyId, raw.projectId, true);
    let existing: TaskRow | null;
    try { existing = this.repository.existing(principal.companyId, raw.idempotencyKey, requestHash, creator); }
    catch (error) {
      if (!(error instanceof TaskConflict)) throw error;
      if (!this.isLegacyHermesRequest(input)) throw new TaskFailure(error.message, 409);
      const legacy = taskRequestHash(this.legacyHermesRequest(raw), creator);
      try { existing = this.repository.existing(principal.companyId, raw.idempotencyKey, legacy, creator); }
      catch (legacyError) { if (legacyError instanceof TaskConflict) throw new TaskFailure(legacyError.message, 409); throw legacyError; }
    }
    if (existing) return { created: false, task: this.getHermesTask(principal, existing.id) };
    const resolved = this.resolveHermesRequest(principal.companyId, raw);
    const result = await this.create(authority, principal.companyId, resolved.request, undefined, requestHash, resolved.signature, raw, copiedFromTaskId);
    return { created: result.created, task: this.getHermesTask(principal, result.task.id) };
  }

  getHermesTask(principal: HermesPrincipal, taskId: string) {
    return this.hermesProjection(this.requireTask({ kind: "hermes", principal }, taskId));
  }

  /** The authorized task row for a Hermes agent command. Every agent command resolves its task through this check. */
  hermesTaskRow(principal: HermesPrincipal, taskId: string): TaskRow {
    return this.requireTask({ kind: "hermes", principal }, taskId);
  }

  /** Every task the agent created inside its granted projects, newest activity first. */
  listHermesTaskRows(principal: HermesPrincipal): TaskRow[] {
    return this.repository.rows().filter(row => row.company_id === principal.companyId && row.creator_agent_id === principal.agentId && principal.projectIds.includes(row.project_id) && !row.archived_at);
  }

  setTaskDependencies(userId: string, taskId: string, dependsOn: unknown): Task {
    const task = this.getTask(userId, taskId);
    this.applyDependencies({ kind: "user", userId }, task.companyId, taskId, DependsOnSchema.parse(dependsOn));
    this.audit({ kind: "user", userId }, task.companyId, "task_dependencies_updated", taskId);
    return this.getTask(userId, taskId);
  }

  setHermesTaskDependencies(principal: HermesPrincipal, taskId: string, dependsOn: unknown) {
    const authority: Authority = { kind: "hermes", principal };
    const row = this.requireTask(authority, taskId);
    this.applyDependencies(authority, row.company_id, taskId, DependsOnSchema.parse(dependsOn));
    this.audit(authority, row.company_id, "task_dependencies_updated", taskId);
    return this.getHermesTask(principal, taskId);
  }

  private applyDependencies(authority: Authority, companyId: string, taskId: string, dependsOn: string[]): void {
    for (const dependency of dependsOn) this.requireTask(authority, dependency);
    try { replaceTaskDependencies(this.database, { taskId, companyId, dependsOn }); }
    catch (error) {
      if (error instanceof TaskDependencyFailure) throw new TaskFailure(error.publicMessage, error.statusCode);
      throw error;
    }
  }

  /** The read path adds observed delivery integration health to the stored projection. */
  async readHermesTask(principal: HermesPrincipal, taskId: string, github: HermesGithubPort = createGithubReleasePort()): Promise<HermesTaskReadProjection> {
    const [projection] = await this.withHermesIntegration(principal, [this.getHermesTask(principal, taskId)], github);
    return projection!;
  }

  async readHermesTasks(principal: HermesPrincipal, input: Parameters<TaskService["listHermesTasks"]>[1] & { filter?: HermesTaskFilter }, github: HermesGithubPort = createGithubReleasePort()): Promise<{ tasks: HermesTaskReadProjection[]; nextCursor: string | null }> {
    const page = this.listHermesTasks(principal, input);
    const tasks = await this.withHermesIntegration(principal, page.tasks, github);
    // Integration health comes from GitHub, not the query, so the filter narrows a page already drawn. The cursor still walks every task.
    return { tasks: input.filter ? tasks.filter(projection => matchesHermesFilter(projection, input.filter!)) : tasks, nextCursor: page.nextCursor };
  }

  private async withHermesIntegration(principal: HermesPrincipal, projections: HermesSafeTaskProjection[], github: HermesGithubPort): Promise<HermesTaskReadProjection[]> {
    if (!projections.length) return [];
    const targets = projections.map(projection => this.repository.task(this.repository.row(projection.id)!));
    const pool = this.repository.hermesRows({ agentId: principal.agentId, companyId: principal.companyId, limit: HERMES_UPSTREAM_POOL }).map(row => this.repository.task(row));
    const upstreams = new Map(targets.map(task => [task.id, pool.filter(other => isUpstreamOf(other, task))] as const));
    const observed = new Map<string, Task>();
    for (const task of [...targets, ...[...upstreams.values()].flat()]) observed.set(task.id, task);
    const observedAt = new Date().toISOString();
    const integrations = new Map(await Promise.all([...observed.values()].map(async task => [task.id, deriveTaskIntegration(task, await this.observeTaskPullRequest(task, github), observedAt)] as const)));
    return projections.map((projection, index) => {
      const task = targets[index]!;
      const integration = integrations.get(task.id)!;
      const blocking = upstreams.get(task.id)!.find(other => !integrations.get(other.id)?.integrated);
      return {
        ...projection,
        implementation: { status: projection.status },
        integration,
        actionRequired: deriveActionRequired(task, integration, blocking ? { taskId: blocking.id, pullRequestNumber: blocking.pullRequest?.number ?? null } : null),
      };
    });
  }

  private async observeTaskPullRequest(task: Task, github: HermesGithubPort): Promise<PullRequestObservationResult> {
    if (!observableDelivery(task)) return { observation: null, failureCode: null };
    try {
      return { observation: await github.observePullRequest({ repository: task.configuration.repository, branch: task.configuration.branch, pullRequestNumber: task.pullRequest?.number ?? null }), failureCode: null };
    } catch (error) {
      return { observation: null, failureCode: error instanceof GithubReleaseFailure ? error.code : "provider-unavailable" };
    }
  }

  async commandHermesTask(principal: HermesPrincipal, taskId: string, raw: unknown): Promise<HermesSafeTaskProjection> {
    let input: HermesCommand;
    try { input = HermesTaskCommandBodySchema.parse(raw); }
    catch { throw new TaskFailure("Invalid request", 400, "request_invalid"); }
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const authority: Authority = { kind: "hermes", principal };
    this.requireTask(authority, taskId);
    const stored = this.database.authQuery(db => db.prepare("SELECT request_hash, result_json FROM forge_hermes_task_command_receipts WHERE agent_id = ? AND task_id = ? AND idempotency_key = ?").get(principal.agentId, taskId, input.idempotencyKey) as { request_hash: string; result_json: string } | undefined);
    if (stored) {
      if (stored.request_hash !== requestHash) throw new TaskFailure("This idempotency key belongs to a different request", 409, "idempotency_conflict");
      return HermesSafeTaskProjectionSchema.parse(JSON.parse(stored.result_json));
    }
    const inFlight = hermesCommandKey(principal.agentId, taskId, input.idempotencyKey);
    if (hermesCommandsInFlight.has(inFlight)) throw new TaskFailure("This command is still being processed", 409, "command_in_progress");
    hermesCommandsInFlight.add(inFlight);
    try {
      const row = this.requireTask(authority, taskId);
      const before = this.hermesProjection(row);
      if (before.revision !== input.revision) throw new TaskFailure("Task revision is stale", 412, "revision_stale");
      if (!before.permittedCommands.includes(input.command)) throw new TaskFailure("This command is not legal for the current task", 409, "illegal_command");
      // The revision claim is the optimistic lock: a concurrent command on the same revision loses here.
      const claimed = this.database.authImmediateTransaction(db => db.prepare("UPDATE forge_tasks SET command_revision = command_revision + 1 WHERE id = ? AND command_revision = ?").run(taskId, row.command_revision).changes);
      if (claimed !== 1) throw new TaskFailure("Task revision is stale", 412, "revision_stale");
      let resultTaskId = taskId;
      switch (input.command) {
        case "start_task":
          if (archivesInProgress.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409, "illegal_command");
          this.repository.controls.start(taskId);
          break;
        case "cancel_task": this.repository.controls.cancel(taskId); break;
        case "unarchive_task": this.unarchive(authority, taskId); break;
        case "send_task_note": this.note(authority, taskId, input.note!, `Agent note (${principal.agentId})`); break;
        // TaskHost owns delivery observation; the route schedules that recovery after this returns.
        case "recheck_delivery_wait": break;
        case "archive_task":
          if ("dirtyFileCount" in await this.archive(authority, taskId, false)) throw new TaskFailure("Discard dirty worktree changes before archiving", 409, "illegal_command");
          break;
        case "duplicate_task": resultTaskId = await this.duplicateTaskForHermes(principal, taskId, input.idempotencyKey); break;
      }
      const result = this.getHermesTask(principal, resultTaskId);
      this.database.authTransaction(db => db.prepare("INSERT INTO forge_hermes_task_command_receipts (agent_id, task_id, idempotency_key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(principal.agentId, taskId, input.idempotencyKey, requestHash, JSON.stringify(result), new Date().toISOString()));
      this.audit(authority, principal.companyId, HERMES_COMMAND_AUDITS[input.command], taskId);
      return result;
    } finally { hermesCommandsInFlight.delete(inFlight); }
  }

  hermesIdentity(principal: HermesPrincipal) {
    const projects = this.database.authQuery((db) => db.prepare(`
      SELECT p.id, p.name
      FROM forge_external_agent_project_grants g
      JOIN forge_projects p ON p.id = g.project_id AND p.company_id = g.company_id
      JOIN forge_external_agents a ON a.id = g.agent_id AND a.company_id = g.company_id
      WHERE a.id = ? AND a.company_id = ? AND a.status = 'paired'
      ORDER BY p.name COLLATE NOCASE, p.id
    `).all(principal.agentId, principal.companyId) as Array<{ id: string; name: string }>);
    const withPolicy = projects.map((project) => {
      const policy = ProjectAgentTaskPolicySchema.parse(this.projects.getProjectInCompany(principal.companyId, project.id).agentTaskPolicy);
      // A project fixes exactly one permitted delivery target; the list keeps room for a policy that ever permits several.
      return { ...project, agentTaskPolicy: { deliveryTargets: [policy.deliveryTarget], runProjectTests: policy.runProjectTests, visualEvidence: policy.visualEvidence } };
    });
    return {
      agent: { id: principal.agentId, name: this.database.authQuery(db => (db.prepare("SELECT name FROM forge_agents WHERE id = ?").get(principal.agentId) as { name: string }).name), profileId: principal.profileId },
      capabilities: { taskDiscovery: true as const, taskRead: true as const, taskCreate: true as const, taskCommands: ["start_task", "cancel_task", "archive_task", "unarchive_task", "duplicate_task", "send_task_note", "recheck_delivery_wait"] as Array<z.infer<typeof HermesTaskCommandBodySchema>["command"]> },
      projects: withPolicy,
    };
  }

  listHermesTasks(principal: HermesPrincipal, input: { projectId?: string; status?: string; archived?: boolean; attention?: boolean; blocker?: boolean; updatedSince?: string; cursor?: string; limit: number }) {
    if (input.projectId) this.requireScope({ kind: "hermes", principal }, principal.companyId, input.projectId);
    const filter = { projectId: input.projectId ?? null, status: input.status ?? null, archived: input.archived ?? null, attention: input.attention ?? null, blocker: input.blocker ?? null, updatedSince: input.updatedSince ?? null };
    const cursor = input.cursor ? this.parseHermesCursor(input.cursor, principal, filter) : null;
    const rows = this.repository.hermesRows({
      agentId: principal.agentId,
      companyId: principal.companyId,
      limit: input.limit + 1,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(input.attention === undefined ? {} : { attention: input.attention }),
      ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
      ...(input.updatedSince === undefined ? {} : { updatedSince: input.updatedSince }),
      ...(cursor ? { cursor } : {}),
    });
    const hasMore = rows.length > input.limit;
    const tasks = rows.slice(0, input.limit).map(row => this.hermesProjection(row));
    const last = tasks.at(-1);
    return { tasks, nextCursor: last && hasMore ? this.createHermesCursor(principal, filter, last) : null };
  }

  private async create(authority: Authority, companyId: string, raw: TaskInput, capturedDispatch?: GithubTriggerDispatch, requestHashOverride?: string, hermesPolicySignature?: string, hermesRaw?: HermesTaskCreateBody, copiedFromTaskId?: string): Promise<{ task: Task; created: boolean }> {
    let normalized: TaskInput;
    try { normalized = normalizeWorkflowInput(raw, { requireSource: true }); }
    catch (error) { if (error instanceof WorkflowInputFailure) throw new TaskFailure(error.message, error.statusCode); throw error; }
    const request = TaskInputSchema.parse(normalized);
    if (capturedDispatch && (request.startImmediately || request.images.length)) throw new TaskFailure("GitHub trigger dispatch is invalid", 422);
    this.requireScope(authority, companyId, request.projectId, true);
    const creator: TaskCreator = authority.kind === "user" ? { kind: "user", id: authority.userId } : { kind: "agent", id: authority.principal.agentId };
    const requestHash = requestHashOverride ?? taskRequestHash(request, creator);
    try {
      const existing = this.repository.existing(companyId, request.idempotencyKey, requestHash, creator);
      if (existing) {
        if (!capturedDispatch) return { task: this.repository.task(existing), created: false };
        return this.database.authImmediateTransaction(() => {
          this.requireGithubTriggerAdmission(capturedDispatch);
          const task = this.repository.task(existing);
          new GithubTriggerDispatchRepository(this.database).linkTask(capturedDispatch.id, task.id);
          return { task, created: false };
        });
      }
      const project = this.projects.getProjectInCompany(companyId, request.projectId);
      const projectSnapshot = this.projectConfigurationSignature(project);
      if (!project.repository) throw new TaskFailure("Configure the project repository before creating a task", 422);
      const defaults = this.database.authQuery(db => z.object({ root: z.string(), worker: z.string() }).parse(db.prepare("SELECT root_profile_id AS root, worker_profile_id AS worker FROM forge_projects WHERE id = ? AND company_id = ?").get(project.id, companyId)));
      let rootProfile = capturedDispatch ? (this.profile(capturedDispatch.profiles.root.profileId, "root"), capturedDispatch.profiles.root) : this.profile(request.rootProfileId ?? defaults.root, "root");
      let workerProfile = capturedDispatch ? (this.profile(capturedDispatch.profiles.worker.profileId, "worker"), capturedDispatch.profiles.worker) : this.profile(request.workerProfileId ?? defaults.worker, "worker");
      let advisorProfiles: Partial<Record<AdvisorRole, TaskProfile>> = {};
      for (const role of workflowDefinition(request.workflow).advisorRoles) advisorProfiles[role] = capturedDispatch ? (this.profile(capturedDispatch.profiles.advisors[role]!.profileId, "root"), capturedDispatch.profiles.advisors[role]!) : this.profile(request.advisorProfileIds[role] ?? rootProfile.profileId, "root");
      const images = request.images.map(image => ({ filename: image.filename, mimeType: image.mimeType, bytes: decodeTaskImage(image) }));
      const source = request.source ? await this.projects.resolveTaskSource(project, request.source) : null;
      if (source?.kind === "issue") request.description = request.description ? `${request.description}\n\n${source.context}` : source.context;
      const heads = await this.projects.captureTaskConfiguration(project);
      if (capturedDispatch && (source?.kind !== "pull_request" || source.number !== capturedDispatch.pullRequestNumber || source.headSha !== capturedDispatch.policy.headSha || source.baseSha !== capturedDispatch.policy.baseSha || source.headBranch !== capturedDispatch.policy.headBranch || source.baseBranch !== capturedDispatch.policy.baseBranch || project.repository?.toLowerCase() !== capturedDispatch.repositoryName || project.baseBranch !== capturedDispatch.policy.baseBranch)) throw new TaskFailure("GitHub trigger source changed", 409);
      const taskId = newTaskId();
      const configuration = TaskConfigurationSchema.parse({
        repository: project.repository, repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot,
        branch: source?.kind === "pull_request" ? source.headBranch : source?.kind === "branch" ? source.branch : taskBranchName(request.title, taskId),
        baseBranch: source?.kind === "pull_request" ? source.baseBranch : project.baseBranch,
        baselineSha: source?.kind === "pull_request" ? source.baseSha : heads.baseSha,
        startingSha: source && source.kind !== "issue" ? source.headSha : heads.baseSha, setupCommand: project.setupCommand, verificationCommand: project.verificationCommand,
        runProjectTests: request.runProjectTests, visualEvidence: request.visualEvidence, source: request.source ?? null, capturedAt: new Date().toISOString(),
      });
      return this.database.authImmediateTransaction(() => {
        this.requireScope(authority, companyId, request.projectId, true);
        // A concurrent identical Hermes request is already admitted; only its current scope remains relevant.
        if (authority.kind === "hermes") {
          const existing = this.repository.existing(companyId, request.idempotencyKey, requestHash, creator);
          if (existing) return { task: this.repository.task(existing), created: false };
        }
        if (authority.kind === "hermes" && hermesPolicySignature && hermesRaw) {
          const current = this.resolveHermesRequest(companyId, hermesRaw);
          if (current.signature !== hermesPolicySignature || this.projectConfigurationSignature(this.projects.getProjectInCompany(companyId, request.projectId)) !== projectSnapshot) throw new TaskFailure("Project task configuration changed", 409);
          rootProfile = this.profile(current.request.rootProfileId!, "root");
          workerProfile = this.profile(current.request.workerProfileId!, "worker");
          advisorProfiles = this.hermesAdvisorProfiles(current.request, rootProfile);
        }
        if (capturedDispatch) {
          this.requireGithubTriggerAdmission(capturedDispatch);
          if (this.projectConfigurationSignature(this.projects.getProjectInCompany(companyId, request.projectId)) !== projectSnapshot) throw new TaskFailure("Project configuration changed", 409);
        }
        // A copy commits with the source it was authorized against, and carries that provenance from its first row.
        const result = this.repository.create({ taskId, companyId, creator, request, requestHash, configuration, rootProfile, workerProfile, advisorProfiles, images, ...(copiedFromTaskId ? { copiedFromTaskId } : {}) });
        if (capturedDispatch) new GithubTriggerDispatchRepository(this.database).linkTask(capturedDispatch.id, result.task.id);
        if (result.created) {
          if (request.dependsOn.length) this.applyDependencies(authority, companyId, result.task.id, request.dependsOn);
          this.audit(authority, companyId, "task_created", result.task.id);
          return { task: this.repository.task(this.repository.row(result.task.id)!), created: true };
        }
        return result;
      });
    } catch (error) {
      if (error instanceof TaskConflict) throw new TaskFailure(error.message, 409);
      throw error;
    }
  }

  private requireGithubTriggerAdmission(dispatch: GithubTriggerDispatch): void {
    const authority = this.auth.getUserForAuthority(dispatch.authorityUserId);
    if (!authority || authority.role !== "admin") throw new TaskFailure("GitHub trigger authority is not available", 422);
    const company = this.auth.requireCompanyAccess(dispatch.authorityUserId, dispatch.companyId);
    if (company.status !== "active") throw new TaskFailure("Company is not active", 409);
    const rule = this.database.authQuery(db => db.prepare("SELECT 1 FROM forge_github_trigger_rules WHERE id = ? AND company_id = ? AND project_id = ? AND repository_id = ? AND lower(repository_name) = lower(?) AND authority_user_id = ? AND enabled = 1 AND archived_at IS NULL").get(dispatch.ruleId, dispatch.companyId, dispatch.projectId, dispatch.repositoryId, dispatch.repositoryName, dispatch.authorityUserId));
    if (!rule) throw new TaskFailure("GitHub trigger rule is not available", 409);
    const preset = this.database.authQuery(db => db.prepare("SELECT 1 FROM forge_workflows WHERE id = ? AND archived_at IS NULL").get(dispatch.preset.id));
    if (!preset) throw new TaskFailure("GitHub trigger preset is not available", 422);
    this.profile(dispatch.profiles.root.profileId, "root");
    this.profile(dispatch.profiles.worker.profileId, "worker");
    for (const profile of Object.values(dispatch.profiles.advisors)) this.profile(profile.profileId, "root");
  }

  startTask(userId: string, taskId: string): Task {
    const task = this.getTask(userId, taskId);
    if (archivesInProgress.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409);
    if (task.archivedAt || !["backlog", "active"].includes(task.status)) throw new TaskFailure("This task cannot be started", 409);
    this.repository.controls.start(taskId);
    this.audit({ kind: "user", userId }, task.companyId, "task_started", taskId);
    return this.getTask(userId, taskId);
  }

  answerTask(userId: string, taskId: string, questionId: string, answer: string, confirmCommandsStopped = false): Task {
    const task = this.getTask(userId, taskId);
    if (task.archivedAt || task.humanQuestion?.id !== questionId || !answer.trim()) throw new TaskFailure("The question changed. Read the current question before answering", 409);
    if (task.humanQuestion.kind === "task_limit") throw new TaskFailure("Select a task limit action before you continue", 409);
    if (task.humanQuestion.requiresCommandCleanup && !confirmCommandsStopped) throw new TaskFailure("Confirm that the commands have stopped before you continue", 409);
    this.repository.controls.answerHuman(taskId, questionId, answer, confirmCommandsStopped);
    this.audit({ kind: "user", userId }, task.companyId, "task_answered", taskId);
    return this.getTask(userId, taskId);
  }

  answerTaskLimit(userId: string, taskId: string, questionId: string, decision: TaskLimitDecision): Task {
    const task = this.getTask(userId, taskId);
    if (task.archivedAt || task.humanQuestion?.id !== questionId || task.humanQuestion.kind !== "task_limit") throw new TaskFailure("The question changed. Read the current question before answering", 409);
    this.repository.controls.answerTaskLimit(taskId, questionId, decision);
    this.audit({ kind: "user", userId }, task.companyId, decision.kind === "cancel_task" ? "task_cancelled" : "task_answered", taskId);
    return this.getTask(userId, taskId);
  }

  cancelTask(userId: string, taskId: string): Task {
    const task = this.getTask(userId, taskId);
    if (task.status === "delivered") throw new TaskFailure("Delivered tasks cannot be cancelled", 409);
    this.repository.controls.cancel(taskId);
    this.audit({ kind: "user", userId }, task.companyId, "task_cancelled", taskId);
    return this.getTask(userId, taskId);
  }

  replaceWorker(userId: string, taskId: string, request: WorkerReplacementRequest): Task {
    this.getTask(userId, taskId);
    try { this.repository.controls.replaceWorker(taskId, request); }
    catch (error) { throw new TaskFailure(error instanceof Error ? error.message : "Forge could not replace the Worker.", 409); }
    return this.getTask(userId, taskId);
  }

  sendNote(userId: string, taskId: string, note: string): Task {
    this.note({ kind: "user", userId }, taskId, note, "Human note");
    return this.getTask(userId, taskId);
  }

  /** Wakes the Coordinator with a note from either authority. Hermes replays are already deduped by their receipt. */
  private note(authority: Authority, taskId: string, note: string, label: string): void {
    const task = this.repository.task(this.requireTask(authority, taskId));
    if (task.archivedAt || !["active", "delivered"].includes(task.status)) throw new TaskFailure("Start the task or answer its current decision before you send a message.", 409, authority.kind === "hermes" ? "illegal_command" : "task_failure");
    const prompt = z.string().trim().min(1).max(20_000).parse(note);
    this.repository.controls.sendNote(taskId, prompt, label);
  }

  updateTaskDetails(userId: string, taskId: string, raw: z.input<typeof DetailsSchema>): Task {
    const input = DetailsSchema.parse(raw);
    const task = this.getTask(userId, taskId);
    // The task keeps the source it was created from, so the workflow rules judge the edit against that source.
    let normalized;
    try {
      normalized = normalizeWorkflowInput({
        workflow: input.workflow ?? task.workflow, advisorProfileIds: input.advisorProfileIds ?? {}, source: task.configuration.source ?? undefined,
        ...(input.deliveryTarget !== undefined ? { deliveryTarget: input.deliveryTarget } : {}),
        ...(input.runProjectTests !== undefined ? { runProjectTests: input.runProjectTests } : {}),
      }, { requireSource: true });
    } catch (error) { if (error instanceof WorkflowInputFailure) throw new TaskFailure(error.message, error.statusCode); throw error; }
    // An unchanged selection keeps its stored snapshot, so an archived profile never blocks an unrelated edit.
    const selected = (profileId: string, current: TaskProfile | undefined, role: "root" | "worker"): TaskProfile =>
      current && current.profileId === profileId ? current : this.profile(profileId, role);
    const rootProfile = selected(input.rootProfileId ?? task.rootProfile.profileId, task.rootProfile, "root");
    const workerProfile = selected(input.workerProfileId ?? task.workerProfile.profileId, task.workerProfile, "worker");
    const advisorProfiles: Partial<Record<AdvisorRole, TaskProfile>> = {};
    for (const role of workflowDefinition(normalized.workflow).advisorRoles) {
      // A request that names its Advisors states them all: a role it leaves out falls back to the Coordinator profile, exactly like creation.
      // Only a request without any Advisor selection, such as a title-only edit, keeps the stored Advisors.
      const stored = input.advisorProfileIds === undefined ? task.advisorProfiles[role]?.profileId : undefined;
      const profileId = normalized.advisorProfileIds[role] ?? stored ?? rootProfile.profileId;
      advisorProfiles[role] = profileId === rootProfile.profileId ? rootProfile : selected(profileId, task.advisorProfiles[role], "root");
    }
    const updated = this.repository.updateDetails(taskId, {
      title: input.title ?? task.title, description: input.description ?? task.description, workflow: normalized.workflow,
      deliveryTarget: normalized.deliveryTarget ?? task.deliveryTarget,
      runProjectTests: normalized.runProjectTests ?? task.configuration.runProjectTests,
      visualEvidence: input.visualEvidence ?? task.configuration.visualEvidence,
      rootProfile, workerProfile, advisorProfiles,
    });
    if (!updated) throw new TaskFailure("Only tasks in the backlog can be edited. Open archived tasks before editing them.", 409);
    return this.getTask(userId, taskId);
  }

  renameTask(userId: string, taskId: string, raw: z.input<typeof RenameSchema>): Task {
    const { title } = RenameSchema.parse(raw);
    this.getTask(userId, taskId);
    if (!this.repository.rename(taskId, title)) throw new TaskFailure("Open archived tasks before renaming them.", 409);
    return this.getTask(userId, taskId);
  }

  setTaskBlockedBy(userId: string, taskId: string, raw: z.input<typeof BlockedBySchema>): Task {
    const { blockedByTaskId } = BlockedBySchema.parse(raw);
    const task = this.getTask(userId, taskId);
    if (blockedByTaskId !== null) {
      const blocked = this.requireTask({ kind: "user", userId }, blockedByTaskId);
      if (blocked.id === task.id || blocked.company_id !== task.companyId || blocked.project_id !== task.projectId) throw new TaskFailure("The blocked task is not available", 404);
    }
    if (!this.repository.setBlockedBy(taskId, blockedByTaskId)) throw new TaskFailure("Not found", 404);
    return this.getTask(userId, taskId);
  }

  unarchiveTask(userId: string, taskId: string): Task {
    return this.unarchive({ kind: "user", userId }, taskId);
  }

  private unarchive(authority: Authority, taskId: string): Task {
    const task = this.repository.task(this.requireTask(authority, taskId));
    if (archivesInProgress.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409);
    this.database.authImmediateTransaction(db => { if (["backlog", "active", "waiting_human"].includes(task.status)) assertTaskPullRequestsAvailable(db, taskId); this.repository.setArchived(taskId, false); });
    return this.repository.task(this.requireTask(authority, taskId));
  }

  async archiveTask(userId: string, taskId: string, confirmDiscardDirty = false): Promise<Task | { status: "confirmation_required"; dirtyFileCount: number; dirtyFilePaths: string[] }> {
    return this.archive({ kind: "user", userId }, taskId, confirmDiscardDirty);
  }

  /** Removes the task worktree and archives the task. The in-memory archive set blocks start and unarchive meanwhile. */
  private async archive(authority: Authority, taskId: string, confirmDiscardDirty = false): Promise<Task | { status: "confirmation_required"; dirtyFileCount: number; dirtyFilePaths: string[] }> {
    const task = this.repository.task(this.requireTask(authority, taskId));
    if (archivesInProgress.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409);
    if (!["backlog", "cancelled", "delivered"].includes(task.status)) throw new TaskFailure("Cancel the task before archiving it", 409);
    archivesInProgress.add(taskId);
    try {
      const sessions = this.repository.controls.sessions(taskId);
      const shellPaneId = this.database.authQuery(db => (db.prepare("SELECT shell_pane_id AS id FROM forge_task_controls WHERE task_id = ?").get(taskId) as { id: string | null } | undefined)?.id ?? null);
      const closeDisplays = await stopIdleArchiveSessions(this.database.filename(), taskId, sessions, shellPaneId);
      this.requireTask(authority, taskId);
      const result = await this.removeWorktree({ taskId, ...task.configuration }, task.worktree, confirmDiscardDirty, () => { this.requireTask(authority, taskId); });
      if (result.status === "confirmation_required") return result;
      this.requireTask(authority, taskId);
      await closeDisplays();
      const current = this.repository.task(this.requireTask(authority, taskId));
      if (!["backlog", "cancelled", "delivered"].includes(current.status)) throw new TaskFailure("The task changed while its worktree was removed", 409, "illegal_command");
      this.database.authTransaction(db => {
        db.prepare("UPDATE forge_task_controls SET worktree_json = NULL WHERE task_id = ?").run(taskId);
        this.repository.setArchived(taskId, true);
      });
      return this.repository.task(this.requireTask(authority, taskId));
    } catch (error) {
      if (error instanceof TaskFailure) throw error;
      throw new TaskFailure(error instanceof Error ? error.message : "Worktree cleanup failed", 409);
    } finally { archivesInProgress.delete(taskId); }
  }

  async getTaskArtifact(userId: string, taskId: string, artifactId: string): Promise<{ artifact: StoredArtifact; bytes: Buffer }> {
    const row = this.requireTask({ kind: "user", userId }, taskId);
    const artifact = this.repository.artifact(row, artifactId);
    if (!artifact) throw new TaskFailure("Not found", 404);
    const bytes = await this.artifacts.getArtifact(artifact);
    this.requireTask({ kind: "user", userId }, taskId);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new TaskFailure("The stored artifact failed its integrity check", 409);
    return { artifact, bytes };
  }

  getTaskActivity(userId: string, taskId: string) {
    const task = this.getTask(userId, taskId);
    return {
      sessions: this.repository.controls.sessions(taskId).map(session => ({ id: session.id, kind: session.kind, advisorRole: session.advisorRole, label: roleLabel(session), profileId: this.sessionProfile(task, session).profileId, generation: session.generation, nativeSessionId: session.nativeSessionId, paneId: session.paneId, current: session.current, replacement: session.replacement })),
      turns: this.repository.controls.turns(taskId).map(turn => ({ id: turn.id, sessionId: turn.sessionId, prompt: turn.promptText, status: turn.status, result: turn.terminalObservation })),
      shellPaneId: this.database.authQuery(db => (db.prepare("SELECT shell_pane_id AS id FROM forge_task_controls WHERE task_id = ?").get(taskId) as { id: string | null } | undefined)?.id ?? null),
    };
  }

  /** Resolves the task's Shell pane from Herdr, rediscovering or recreating it when the persisted binding is stale. */
  async taskShellPane(userId: string, taskId: string): Promise<string | null> {
    this.requireTask({ kind: "user", userId }, taskId);
    const control = this.repository.controls.get(taskId);
    const pane = await ensureTaskShellPane(this.herdr, {
      taskId,
      cwd: control.worktree?.path ?? process.cwd(),
      paneId: control.shellPaneId,
      persist: paneId => this.repository.controls.bindShellPane(taskId, paneId),
      excludePaneIds: this.repository.controls.sessions(taskId).map(session => session.paneId),
      create: false,
    }).catch(() => null);
    return pane?.paneId ?? null;
  }

  private sessionProfile(task: Task, session: { kind: "root" | "worker"; advisorRole: AdvisorRole | null; profile?: TaskProfile | null }): TaskProfile {
    if (session.profile) return session.profile;
    if (session.kind === "root") return task.rootProfile;
    return (session.advisorRole && task.advisorProfiles[session.advisorRole]) || (session.advisorRole ? task.rootProfile : task.workerProfile);
  }

  private profile(profileId: string, role: "root" | "worker"): TaskProfile {
    const value = this.database.authQuery(db => db.prepare("SELECT id AS profileId, provider, model, reasoning_level AS reasoningLevel, service_tier AS serviceTier FROM forge_profiles WHERE id = ? AND role = ? AND archived_at IS NULL").get(profileId, role));
    if (!value) throw new TaskFailure("The selected agent profile does not exist", 422);
    return TaskProfileSchema.parse(value);
  }

  private resolveHermesRequest(companyId: string, raw: HermesTaskCreateBody): { request: TaskInput; signature: string } {
    const project = this.projects.getProjectInCompany(companyId, raw.projectId);
    const policy = ProjectAgentTaskPolicySchema.parse(project.agentTaskPolicy);
    const template = raw.templateId ? this.templateForHermes(project.id, policy, raw.templateId) : undefined;
    const workflow = template ? undefined : this.workflowForHermes(policy, raw.workflowId ?? policy.defaultWorkflowId);
    const selected = template ?? workflow!;
    let request: ReturnType<typeof TaskInputSchema.parse>;
    try {
      request = TaskInputSchema.parse(normalizeWorkflowInput({
        projectId: raw.projectId, title: raw.title, description: raw.description === undefined ? selected.description ?? "" : raw.description, idempotencyKey: raw.idempotencyKey, images: raw.images, source: raw.source, dependsOn: raw.dependsOn,
        workflow: selected.workflow ?? "standard", rootProfileId: raw.rootProfileId ?? selected.rootProfileId, workerProfileId: raw.workerProfileId ?? selected.workerProfileId,
        advisorProfileIds: Object.keys(raw.advisorProfileIds).length ? raw.advisorProfileIds : selected.advisorProfileIds ?? {},
        deliveryTarget: policy.deliveryTarget, runProjectTests: policy.runProjectTests, visualEvidence: policy.visualEvidence, startImmediately: false,
      }, { requireSource: true }));
    } catch (error) {
      if (error instanceof WorkflowInputFailure) throw new TaskFailure(error.message, error.statusCode);
      throw error;
    }
    if (raw.deliveryTarget !== undefined && raw.deliveryTarget !== policy.deliveryTarget || raw.runProjectTests !== undefined && raw.runProjectTests !== policy.runProjectTests || raw.visualEvidence !== undefined && raw.visualEvidence !== policy.visualEvidence) throw new TaskFailure(`This project permits deliveryTarget "${policy.deliveryTarget}", runProjectTests ${policy.runProjectTests}, and visualEvidence "${policy.visualEvidence}"`, 422, "delivery_policy_rejected");
    const root = request.rootProfileId ?? project.rootProfileId;
    const worker = request.workerProfileId ?? project.workerProfileId;
    // The allowlist governs what a caller may choose; server-chosen defaults (project defaults, workflow and template records) are already trusted.
    if (raw.rootProfileId !== undefined && !policy.rootProfileIds.includes(raw.rootProfileId) || raw.workerProfileId !== undefined && !policy.workerProfileIds.includes(raw.workerProfileId)) throw new TaskFailure("The selected agent profile is not permitted", 422);
    for (const role of workflowDefinition(request.workflow).advisorRoles) {
      const profileId = request.advisorProfileIds[role] ?? root;
      if (!policy.advisorProfileIds[role].includes(profileId)) throw new TaskFailure("The selected Advisor profile is not permitted", 422);
    }
    const resolved = { ...request, rootProfileId: root, workerProfileId: worker };
    return { request: resolved, signature: JSON.stringify(resolved) };
  }

  private workflowForHermes(policy: ProjectAgentTaskPolicy, workflowId: string): Partial<z.infer<typeof CreateTaskTemplateBodySchema>> {
    if (!policy.workflowIds.includes(workflowId)) throw new TaskFailure("The selected workflow is not permitted", 422);
    const row = this.database.authQuery(db => db.prepare("SELECT name, description, configuration_json, engine FROM forge_workflows WHERE id = ? AND archived_at IS NULL").get(workflowId) as { name: string; description: string; configuration_json: string; engine: string } | undefined);
    if (!row) throw new TaskFailure("The selected workflow is not available", 422);
    const record = WorkflowRecordInputSchema.parse({ ...JSON.parse(row.configuration_json), name: row.name, description: row.description, engine: row.engine });
    return {
      workflow: record.engine,
      advisorProfileIds: record.advisorProfileIds,
      ...(record.rootProfileId ? { rootProfileId: record.rootProfileId } : {}),
      ...(record.workerProfileId ? { workerProfileId: record.workerProfileId } : {}),
    };
  }

  private templateForHermes(projectId: string, policy: ProjectAgentTaskPolicy, templateId: string): z.infer<typeof CreateTaskTemplateBodySchema> {
    if (!policy.templateIds.includes(templateId)) throw new TaskFailure("The selected template is not permitted", 422);
    const row = this.database.authQuery(db => db.prepare("SELECT configuration_json FROM forge_task_templates WHERE id = ? AND project_id = ?").get(templateId, projectId) as { configuration_json: string } | undefined);
    if (!row) throw new TaskFailure("The selected template is not available", 422);
    return CreateTaskTemplateBodySchema.parse(JSON.parse(row.configuration_json));
  }

  private hermesRequestHash(input: HermesTaskCreateBody, creator: TaskCreator): string {
    const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sort(entry)])) : value;
    return createHash("sha256").update(JSON.stringify(sort({ input, creator }))).digest("hex");
  }

  private isLegacyHermesRequest(input: HermesTaskCreateBody): boolean {
    return !input.dependsOn?.length && !input.images.length && !input.source && !input.workflowId && !input.templateId && !input.rootProfileId && !input.workerProfileId && Object.keys(input.advisorProfileIds).length === 0 && input.deliveryTarget === undefined && input.runProjectTests === undefined && input.visualEvidence === undefined;
  }

  private legacyHermesRequest(input: HermesTaskCreateBody): TaskInput {
    return TaskInputSchema.parse(normalizeWorkflowInput({ projectId: input.projectId, title: input.title, description: input.description ?? "", idempotencyKey: input.idempotencyKey }, { requireSource: true }));
  }

  private hermesAdvisorProfiles(request: TaskInput, rootProfile: TaskProfile): Partial<Record<AdvisorRole, TaskProfile>> {
    return Object.fromEntries(workflowDefinition(request.workflow ?? "standard").advisorRoles.map(role => [role, this.profile(request.advisorProfileIds?.[role] ?? rootProfile.profileId, "root")])) as Partial<Record<AdvisorRole, TaskProfile>>;
  }

  private projectConfigurationSignature(project: { repository: string | undefined; repositoryPath: string; worktreeRoot: string; baseBranch: string; setupCommand: string; verificationCommand: string }): string {
    return JSON.stringify({ repository: project.repository, repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot, baseBranch: project.baseBranch, setupCommand: project.setupCommand, verificationCommand: project.verificationCommand });
  }

  private requireTask(authority: Authority, taskId: string): TaskRow {
    const row = this.repository.row(taskId);
    if (!row) throw new TaskFailure("Not found", 404, authority.kind === "hermes" ? "resource_not_found" : "task_failure");
    this.requireScope(authority, row.company_id, row.project_id);
    if (authority.kind === "hermes" && row.creator_agent_id !== authority.principal.agentId) throw new TaskFailure("Not found", 404, "resource_not_found");
    return row;
  }

  private hermesProjection(row: TaskRow): HermesSafeTaskProjection {
    const task = this.repository.task(row);
    const project = this.database.authQuery(db => db.prepare("SELECT id, name FROM forge_projects WHERE id = ? AND company_id = ?").get(row.project_id, row.company_id) as { id: string; name: string } | undefined);
    if (!project) throw new TaskFailure("Not found", 404);
    const humanQuestion = task.humanQuestion?.text ?? null;
    const wait = task.workflowState.deliveryWait;
    const completion = task.workflowState.completion;
    const blocker = humanQuestion ? { kind: "human_question" as const } : wait ? { kind: "delivery_wait" as const, reason: wait.reason } : null;
    const workflowStage = task.status === "cancelled" ? "cancelled" : completion || task.status === "delivered" ? "completed" : humanQuestion ? "waiting_human" : wait ? "waiting_delivery" : task.status === "active" ? "working" : "queued";
    const delivery = task.pullRequest || wait || completion ? { pullRequest: task.pullRequest ? { number: task.pullRequest.number, url: task.pullRequest.url, state: task.pullRequest.state, mergedAt: task.pullRequest.mergedAt } : null, checks: null, waiting: wait ? { reason: wait.reason, since: wait.since } : null, completion: completion ? { kind: completion.kind, pullRequestNumber: completion.pullRequestNumber, observedAt: completion.observedAt } : null } : null;
    const recheck = !task.archivedAt && wait && task.status === "active" ? ["recheck_delivery_wait"] as const : [] as const;
    const permittedCommands = task.archivedAt ? ["unarchive_task"] as const
      : task.status === "backlog" ? ["start_task", "cancel_task", "archive_task", "duplicate_task"] as const
      : task.status === "active" ? ["cancel_task", "duplicate_task", "send_task_note"] as const
      : task.status === "waiting_human" ? ["cancel_task", "duplicate_task"] as const
      : task.status === "cancelled" ? ["archive_task", "duplicate_task"] as const
      : task.status === "delivered" ? ["archive_task", "duplicate_task"] as const
      : ["duplicate_task"] as const;
    const value = { id: task.id, issueKey: task.issueKey, projectId: task.projectId, project, title: task.title, status: task.status, dependsOn: task.dependsOn, archived: task.archivedAt !== null, permittedCommands: [...permittedCommands, ...recheck], humanQuestion, blocker, workflowStage, workflow: task.workflow, deliveryTarget: task.deliveryTarget, runProjectTests: task.configuration.runProjectTests, visualEvidence: task.configuration.visualEvidence, delivery, createdAt: task.createdAt, updatedAt: task.updatedAt };
    return { ...value, revision: createHash("sha256").update(JSON.stringify({ value, commandRevision: row.command_revision })).digest("base64url") };
  }

  private createHermesCursor(principal: HermesPrincipal, filter: object, task: HermesSafeTaskProjection): string {
    const payload = Buffer.from(JSON.stringify({ agentId: principal.agentId, filter, updatedAt: task.updatedAt, id: task.id })).toString("base64url");
    return `${payload}.${createHmac("sha256", principal.cursorKey).update(payload).digest("base64url")}`;
  }

  /** The copy carries the source configuration this project still permits, with provenance written by its creation. */
  private async duplicateTaskForHermes(principal: HermesPrincipal, taskId: string, key: string): Promise<string> {
    const row = this.requireTask({ kind: "hermes", principal }, taskId);
    const source = this.repository.task(row);
    const policy = ProjectAgentTaskPolicySchema.parse(this.projects.getProjectInCompany(principal.companyId, source.projectId).agentTaskPolicy);
    const images = await Promise.all(source.images.map(async image => {
      const artifact = this.repository.artifact(row, image.artifactId);
      if (!artifact) throw new TaskFailure("A source task image is no longer available", 409, "illegal_command");
      return TaskImageInputSchema.parse({ filename: artifact.filename, mimeType: artifact.mimeType, base64: (await this.artifacts.getArtifact(artifact)).toString("base64") });
    }));
    const created = await this.createTaskForHermes(principal, {
      projectId: source.projectId, title: duplicateTitle(source.title, new Set()), description: source.description, idempotencyKey: hermesDuplicateKey(taskId, key),
      workflowId: this.hermesWorkflowIdForEngine(policy, source.workflow), templateId: undefined,
      rootProfileId: policy.rootProfileIds.includes(source.rootProfile.profileId) ? source.rootProfile.profileId : undefined,
      workerProfileId: policy.workerProfileIds.includes(source.workerProfile.profileId) ? source.workerProfile.profileId : undefined,
      advisorProfileIds: Object.fromEntries(Object.entries(source.advisorProfiles).filter(([role, profile]) => policy.advisorProfileIds[role as AdvisorRole]?.includes(profile.profileId)).map(([role, profile]) => [role, profile.profileId])), images,
      ...(source.configuration.source ? { source: source.configuration.source } : {}),
    }, taskId);
    return created.task.id;
  }

  /** Keeps the copy on the source workflow engine when the project still permits a record that runs it. */
  private hermesWorkflowIdForEngine(policy: ProjectAgentTaskPolicy, engine: string): string {
    const engines = this.database.authQuery(db => new Map(policy.workflowIds.map(id => [id, (db.prepare("SELECT engine FROM forge_workflows WHERE id = ? AND archived_at IS NULL").get(id) as { engine: string } | undefined)?.engine])));
    return policy.workflowIds.find(id => engines.get(id) === engine) ?? policy.defaultWorkflowId;
  }

  private parseHermesCursor(value: string, principal: HermesPrincipal, filter: object): { updatedAt: string; id: string } {
    try {
      const [payload, signature, extra] = value.split(".");
      if (!payload || !signature || extra) throw new TaskFailure("Invalid cursor", 400, "cursor_invalid");
      const expected = createHmac("sha256", principal.cursorKey).update(payload).digest("base64url");
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expected);
      if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new TaskFailure("Invalid cursor", 400, "cursor_invalid");
      const cursor = z.object({ agentId: z.string(), filter: z.record(z.string(), z.unknown()), updatedAt: z.string().datetime(), id: z.string() }).strict().parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      if (cursor.agentId !== principal.agentId || JSON.stringify(cursor.filter) !== JSON.stringify(filter)) throw new TaskFailure("Invalid cursor", 400, "cursor_invalid");
      return cursor;
    } catch (error) {
      if (error instanceof TaskFailure) throw error;
      throw new TaskFailure("Invalid cursor", 400, "cursor_invalid", { cause: error });
    }
  }

  private requireScope(authority: Authority, companyId: string, projectId: string, active = false): void {
    if (authority.kind === "user") {
      const company = this.auth.requireCompanyAccess(authority.userId, companyId);
      if (active && company.status !== "active") throw new TaskFailure("The company is not active", 409);
      return;
    }
    const principal = authority.principal;
    if (principal.companyId !== companyId) throw new TaskFailure("Not found", 404, "resource_not_found");
    const allowed = this.database.authQuery(db => db.prepare("SELECT c.status FROM forge_external_agents a JOIN forge_external_agent_project_grants g ON g.agent_id = a.id AND g.company_id = a.company_id JOIN forge_companies c ON c.id = a.company_id WHERE a.id = ? AND a.company_id = ? AND a.status = 'paired' AND a.revoked_at IS NULL AND g.project_id = ?").get(principal.agentId, companyId, projectId));
    if (!allowed) throw new TaskFailure("Not found", 404, "resource_not_found");
    if (active && z.object({ status: z.string() }).parse(allowed).status !== "active") throw new TaskFailure("The company is not active", 409);
  }

  private audit(authority: Authority, companyId: string, action: string, taskId: string): void {
    const task = this.repository.row(taskId);
    const resultingState = task ? JSON.stringify({ status: this.repository.task(task).status, archived: task.archived_at !== null }) : "unknown";
    if (authority.kind === "user") this.auth.recordAuditEvent(authority.userId, action, undefined, companyId, { taskId, resultingState });
    else this.auth.recordAgentAuditEvent(authority.principal.agentId, action, undefined, companyId, { taskId, resultingState });
  }
}

import type { WorkerReplacementRequest } from "../coordination/worker-replacement-contracts.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TaskAnalyticsStore } from "./analytics/store.js";
import { taskAnalytics } from "./analytics/analytics.js";
import { readTaskTimeline } from "./timeline/timeline.js";
import { removeTaskWorktree } from "./worktree.js";
import { stopIdleArchiveSessions } from "./archive/sessions.js";
import { z } from "zod";
import { isProfileAllowed, type ProjectProviderPolicy } from "../projects/provider-policy.js";
import { IssueTracker } from "../integrations/issue-tracker.js";
import { IssueAssociationSchema, type IssueAssociation } from "./issue-association.js";
import { hasStartedNativeWork, taskTracker } from "./issue-context.js";
import type { TrackerConnection } from "../projects/integration-configuration.js";
import { supportsDeliveryTarget } from "../delivery/target-capabilities.js";
import type { AuthService } from "../identity/auth.js";
import { ArtifactStore, type StoredArtifact } from "../platform/artifacts.js";
import type { ForgeConfig } from "../platform/config.js";
import type { ForgeDatabase } from "../platform/database.js";
import type { ExternalAgentPrincipal } from "../identity/external-agents.js";
import { AGENT_API_TASK_COMMANDS, AgentApiSafeTaskProjectionSchema, AgentApiTaskCommandBodySchema, AgentApiTaskCreateBodySchema, AgentApiTaskCreateDryRunResponseSchema, type AgentApiSafeTaskProjection, type AgentApiTaskCreateBody, type AgentApiTaskDependenciesDryRunResponseSchema, type AgentApiTaskFilter, type AgentApiTaskReadProjection, type AgentApiTaskSummaryProjection } from "../http/contracts/agent-api.js";
import { createGithubReleasePort, GithubReleaseFailure, type GithubReleasePort } from "../integrations/github/delivery.js";
import { deriveActionRequired, deriveTaskIntegration, isUpstreamOf, matchesAgentApiFilter, observableDelivery, type PullRequestObservationResult } from "./integration.js";
import { ProjectAgentTaskPolicySchema, type ProjectAgentTaskPolicy } from "../http/contracts/projects.js";
import { CreateTaskTemplateBodySchema } from "../http/contracts/task-templates.js";
import { TaskDetailsBodySchema, type TaskContinueDeliveryBodySchema } from "../http/contracts/tasks.js";
import { WorkflowRecordInputSchema } from "../http/contracts/workflows.js";
import { ProjectFailure, type Project, type ProjectService } from "../projects/projects.js";
import { TaskProfileSchema, type TaskProfile } from "./control.js";
import { MAX_TASK_DEPENDENCIES, TaskConfigurationSchema, TaskImageInputSchema, TaskInputSchema, type Task, type TaskInput } from "./contracts.js";
import { replaceTaskDependencies, TaskDependencyFailure } from "./dependencies.js";
import { replacePullRequestDependenciesInTransaction, type PullRequestDependency } from "./pull-request-dependencies.js";
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
import { TaskSourceFailure } from "./sources.js";

export class TaskFailure extends Error {
  constructor(readonly publicMessage: string, readonly statusCode = 400, readonly code = "task_failure", options?: { cause?: unknown; details?: { field?: string; value?: string; reason?: string; permittedWorkflowIds?: string[]; permittedTemplateIds?: string[] } }) {
    super(publicMessage);
    this.cause = options?.cause;
    this.details = options?.details;
  }

  readonly details: { field?: string; value?: string; reason?: string; permittedWorkflowIds?: string[]; permittedTemplateIds?: string[] } | undefined;
}
type Authority = { kind: "user"; userId: string } | { kind: "agentApi"; principal: ExternalAgentPrincipal };
type TaskCreationResult = { task: Task; created: boolean };
class DryRunRollback extends Error {
  constructor(readonly result: TaskCreationResult) { super("Dry-run rollback"); }
}
export type AgentApiGithubPort = Pick<Required<GithubReleasePort>, "observePullRequest">;
type AgentApiCommand = z.infer<typeof AgentApiTaskCommandBodySchema>;
const AGENT_API_COMMAND_AUDITS: Record<AgentApiCommand["command"], string> = {
  start_task: "task_started", disarm_task: "task_disarmed", cancel_task: "task_cancelled", archive_task: "task_archived", unarchive_task: "task_unarchived",
  send_task_note: "task_note_added", duplicate_task: "task_duplicated", recheck_delivery_wait: "delivery_wait_recheck_requested",
};
/** Commands running anywhere in this process. Keyed without the service instance so siblings sharing a database agree. */
const agentApiCommandsInFlight = new Set<string>();
/** Tasks whose worktree is being removed anywhere in this process. Start and unarchive refuse while a task is listed. */
const archivesInProgress = new Set<string>();
const agentApiCommandKey = (agentId: string, taskId: string, key: string): string => JSON.stringify([agentId, taskId, key]);
const agentApiDuplicateKey = (taskId: string, key: string): string => `duplicate-${createHash("sha256").update(`${taskId}:${key}`).digest("hex")}`;
/** ponytail: one page of the agent's own tasks feeds upstream dependency lookup; page it if an agent ever owns more. */
const AGENT_API_UPSTREAM_POOL = 200;
type Projects = Pick<ProjectService, "getProject" | "getProjectInCompany" | "resolveTaskSource" | "captureTaskConfiguration">;
/** Worktree removal defaults to the real host; tests drive a controlled one. */
export type TaskServicePorts = { removeWorktree?: typeof removeTaskWorktree; herdr?: TaskPanePort; issueTracker?: (connection: TrackerConnection) => Pick<IssueTracker, "read">; pullRequestObserver?: Pick<Required<GithubReleasePort>, "observePullRequest"> };
const DetailsSchema = TaskDetailsBodySchema.refine(input => Object.keys(input).length > 0);
const RenameSchema = TaskInputSchema.pick({ title: true });
const DependenciesSchema = z.object({ dependsOn: z.array(z.string().min(1).max(256)).max(MAX_TASK_DEPENDENCIES), blockedByPullRequests: z.array(z.object({ number: z.number().int().positive() }).strict()).max(MAX_TASK_DEPENDENCIES) }).strict();
const DependsOnSchema = DependenciesSchema.shape.dependsOn;

export class TaskService {
  private readonly removeWorktree: typeof removeTaskWorktree;
  private readonly herdr: TaskPanePort;
  private readonly issueTracker: NonNullable<TaskServicePorts["issueTracker"]>;
  private readonly pullRequestObserver: Pick<Required<GithubReleasePort>, "observePullRequest">;
  readonly repository: TaskRepository;
  private readonly artifacts: ArtifactStore;
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly projects: Projects, config: Pick<ForgeConfig, "artifactRoot">, ports: TaskServicePorts = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot, database);
    this.repository = new TaskRepository(database, this.artifacts);
    this.removeWorktree = ports.removeWorktree ?? removeTaskWorktree;
    this.herdr = ports.herdr ?? new CliHerdrClient();
    this.issueTracker = ports.issueTracker ?? (connection => new IssueTracker(connection));
    this.pullRequestObserver = ports.pullRequestObserver ?? createGithubReleasePort();
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

  async createTaskForAgentApi(principal: ExternalAgentPrincipal, input: AgentApiTaskCreateBody, copiedFromTaskId?: string) {
    const untrusted: Record<string, unknown> = { ...input };
    delete untrusted.companyId;
    delete untrusted.agentId;
    delete untrusted.startImmediately;
    let raw: AgentApiTaskCreateBody;
    try { raw = AgentApiTaskCreateBodySchema.strict().parse(untrusted); }
    catch { throw new TaskFailure("Invalid request", 400, "request_invalid"); }
    const authority: Authority = { kind: "agentApi", principal };
    const creator: TaskCreator = { kind: "agent", id: principal.agentId };
    const requestHash = this.agentApiRequestHash(raw, creator);
    this.requireScope(authority, principal.companyId, raw.projectId, true, { code: "project_not_found", field: "projectId", value: raw.projectId, reason: "The project is not available." });
    let existing: TaskRow | null;
    try { existing = this.repository.existing(principal.companyId, raw.idempotencyKey, requestHash, creator); }
    catch (error) {
      if (!(error instanceof TaskConflict)) throw error;
      if (!this.isLegacyAgentApiRequest(input)) throw new TaskFailure(error.message, 409);
      const legacy = taskRequestHash(this.legacyAgentApiRequest(raw), creator);
      try { existing = this.repository.existing(principal.companyId, raw.idempotencyKey, legacy, creator); }
      catch (legacyError) { if (legacyError instanceof TaskConflict) throw new TaskFailure(legacyError.message, 409); throw legacyError; }
    }
    if (existing) return {
      created: false,
      task: this.getAgentApiTask(principal, existing.id),
      ...(raw.dryRun ? { dryRun: true as const, preview: { dryRun: true as const, status: 200 as const, existingTaskId: existing.id } } : {}),
    };
    const resolved = this.resolveAgentApiRequest(principal.companyId, raw);
    const result = await this.create(authority, principal.companyId, resolved.request, undefined, requestHash, resolved.signature, raw, copiedFromTaskId, resolved.selection, raw.dryRun === true);
    if (raw.dryRun) return { created: false, task: this.agentApiDryRunTaskProjection(principal, result.task), dryRun: true as const, preview: this.agentApiDryRunPreview(principal, result.task) };
    return { created: result.created, task: this.getAgentApiTask(principal, result.task.id) };
  }

  getAgentApiTask(principal: ExternalAgentPrincipal, taskId: string) {
    return this.agentApiProjection(this.requireReadableAgentApiTask(principal, taskId), principal);
  }

  /** The authorized task row for a AgentApi agent command. Every agent command resolves its task through this check. */
  agentApiTaskRow(principal: ExternalAgentPrincipal, taskId: string): TaskRow {
    return this.requireTask({ kind: "agentApi", principal }, taskId);
  }

  /** Every task the agent created inside its current grants, for creator-only delivery management. */
  listAgentApiTaskRows(principal: ExternalAgentPrincipal): TaskRow[] {
    return this.repository.agentApiRows({ agentId: principal.agentId, companyId: principal.companyId, creatorAgentId: principal.agentId, archived: false });
  }

  listAgentApiWorkflows(principal: ExternalAgentPrincipal, projectId: string) {
    this.requireScope({ kind: "agentApi", principal }, principal.companyId, projectId);
    const policy = ProjectAgentTaskPolicySchema.parse(this.projects.getProjectInCompany(principal.companyId, projectId).agentTaskPolicy);
    return this.database.authQuery(db => (db.prepare("SELECT id, name, description FROM forge_workflows WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, id").all() as Array<{ id: string; name: string; description: string }>).map(workflow => ({ ...workflow, permittedForAgentTaskCreation: policy.workflowIds.includes(workflow.id) })));
  }

  listAgentApiTemplates(principal: ExternalAgentPrincipal, projectId: string) {
    this.requireScope({ kind: "agentApi", principal }, principal.companyId, projectId);
    const policy = ProjectAgentTaskPolicySchema.parse(this.projects.getProjectInCompany(principal.companyId, projectId).agentTaskPolicy);
    return this.database.authQuery(db => (db.prepare("SELECT id, name, configuration_json FROM forge_task_templates WHERE project_id = ? ORDER BY name COLLATE NOCASE, id").all(projectId) as Array<{ id: string; name: string; configuration_json: string }>).map(template => ({ id: template.id, name: template.name, description: CreateTaskTemplateBodySchema.parse(JSON.parse(template.configuration_json)).description, permittedForAgentTaskCreation: policy.templateIds.includes(template.id) })));
  }

  setTaskDependencies(userId: string, taskId: string, dependencies: string[]): Task;
  setTaskDependencies(userId: string, taskId: string, dependencies: unknown): Promise<Task>;
  setTaskDependencies(userId: string, taskId: string, dependencies: unknown): Task | Promise<Task> {
    if (Array.isArray(dependencies)) {
      const task = this.getTask(userId, taskId);
      try { replaceTaskDependencies(this.database, { taskId, companyId: task.companyId, dependsOn: dependencies }, (db, wasBlocked) => { if (wasBlocked) this.repository.controls.reconcileDependencyReleaseInTransaction(db, taskId); }); }
      catch (error) { if (error instanceof TaskDependencyFailure) throw new TaskFailure(error.publicMessage, error.statusCode); throw error; }
      this.repository.controls.admitQueued([taskId]);
      return this.getTask(userId, taskId);
    }
    return this.setTaskDependenciesAsync(userId, taskId, dependencies);
  }

  private async setTaskDependenciesAsync(userId: string, taskId: string, dependencies: unknown): Promise<Task> {
    const task = this.getTask(userId, taskId);
    await this.applyDependencies({ kind: "user", userId }, task.companyId, taskId, DependenciesSchema.parse(dependencies));
    this.audit({ kind: "user", userId }, task.companyId, "task_dependencies_updated", taskId);
    return this.getTask(userId, taskId);
  }

  setAgentApiTaskDependencies(principal: ExternalAgentPrincipal, taskId: string, dependencies: string[]): AgentApiSafeTaskProjection;
  setAgentApiTaskDependencies(principal: ExternalAgentPrincipal, taskId: string, dependencies: unknown): Promise<AgentApiSafeTaskProjection>;
  setAgentApiTaskDependencies(principal: ExternalAgentPrincipal, taskId: string, dependencies: unknown): AgentApiSafeTaskProjection | Promise<AgentApiSafeTaskProjection> {
    if (Array.isArray(dependencies)) {
      const authority: Authority = { kind: "agentApi", principal };
      const row = this.requireTask(authority, taskId);
      for (const dependency of dependencies) this.requireReadableAgentApiTask(principal, dependency);
      try { replaceTaskDependencies(this.database, { taskId, companyId: row.company_id, dependsOn: dependencies }, (db, wasBlocked) => { if (wasBlocked) this.repository.controls.reconcileDependencyReleaseInTransaction(db, taskId); }); }
      catch (error) { if (error instanceof TaskDependencyFailure) throw new TaskFailure(error.publicMessage, error.statusCode); throw error; }
      this.audit(authority, row.company_id, "task_dependencies_updated", taskId);
      return this.getAgentApiTask(principal, taskId);
    }
    return this.setAgentApiTaskDependenciesAsync(principal, taskId, dependencies);
  }

  private async setAgentApiTaskDependenciesAsync(principal: ExternalAgentPrincipal, taskId: string, dependencies: unknown): Promise<AgentApiSafeTaskProjection> {
    const authority: Authority = { kind: "agentApi", principal };
    const row = this.requireTask(authority, taskId);
    await this.applyDependencies(authority, row.company_id, taskId, DependenciesSchema.parse(dependencies));
    this.audit(authority, row.company_id, "task_dependencies_updated", taskId);
    return this.getAgentApiTask(principal, taskId);
  }

  previewAgentApiTaskDependencies(principal: ExternalAgentPrincipal, taskId: string, dependsOn: unknown): z.infer<typeof AgentApiTaskDependenciesDryRunResponseSchema> {
    const requested = DependsOnSchema.parse(dependsOn);
    return this.dryRunTransaction(() => {
      this.setAgentApiTaskDependencies(principal, taskId, requested);
      const task = this.getAgentApiTask(principal, taskId);
      return { dryRun: true, dependsOn: task.dependsOn, ...this.wouldStart(task.queue) };
    });
  }

  private async applyDependencies(authority: Authority, companyId: string, taskId: string, dependencies: z.infer<typeof DependenciesSchema>): Promise<void> {
    for (const dependency of dependencies.dependsOn) {
      if (authority.kind === "user") {
        this.requireTask(authority, dependency);
        continue;
      }
      const unavailable = () => new TaskFailure("The dependency is not available.", 422, "dependency_not_found", { details: { field: "dependsOn", value: dependency, reason: "The dependency is not available." } });
      if (!this.repository.row(dependency)) throw unavailable();
      try { this.requireReadableAgentApiTask(authority.principal, dependency); }
      catch { throw new TaskFailure("The dependency is not available.", 422, "dependency_not_found", { details: { field: "dependsOn", value: dependency, reason: "The dependency is not available." } }); }
    }
    const task = this.repository.row(taskId);
    if (!task) throw new TaskFailure("Not found", 404);
    const configuration = TaskConfigurationSchema.parse(JSON.parse(task.configuration_json));
    const pullRequests = await this.observePullRequestDependencies(configuration.repository, dependencies.blockedByPullRequests, authority.kind === "agentApi");
    try { replaceTaskDependencies(this.database, { taskId, companyId, dependsOn: dependencies.dependsOn }); }
    catch (error) {
      if (error instanceof TaskDependencyFailure) throw new TaskFailure(error.publicMessage, error.statusCode);
      throw error;
    }
    // Replace every prerequisite before a queued task is considered for admission.
    this.database.authImmediateTransaction(db => {
      replacePullRequestDependenciesInTransaction(db, taskId, pullRequests);
      this.repository.controls.reconcileDependencyReleaseInTransaction(db, taskId);
    });
  }

  private async observePullRequestDependencies(repository: string, inputs: Array<{ number: number }>, agentApi = false): Promise<PullRequestDependency[]> {
    const observed: PullRequestDependency[] = [];
    for (const input of [...new Map(inputs.map(value => [value.number, value])).values()]) {
      let value;
      const unavailable = () => new TaskFailure("The pull request is not available.", 422, "dependency_not_found", { details: { field: "blockedByPullRequests", value: String(input.number), reason: "The pull request is not available." } });
      try { value = await this.pullRequestObserver.observePullRequest({ repository, branch: "", pullRequestNumber: input.number }); }
      catch { throw agentApi ? unavailable() : new TaskFailure(`Forge cannot observe pull request #${input.number}. Try again when GitHub is available.`, 422); }
      if (!value.exists || value.number !== input.number || !value.state || !value.url) throw agentApi ? unavailable() : new TaskFailure(`Pull request #${input.number} was not found`, 422);
      observed.push({ number: input.number, state: value.state, title: value.title ?? `Pull request #${input.number}`, url: value.url, observedAt: new Date().toISOString() });
    }
    return observed;
  }

  /** The read path adds observed delivery integration health to the stored projection. */
  async readAgentApiTask(principal: ExternalAgentPrincipal, taskId: string, github: AgentApiGithubPort = createGithubReleasePort()): Promise<AgentApiTaskReadProjection> {
    const [projection] = await this.withAgentApiIntegration(principal, [this.getAgentApiTask(principal, taskId)], github);
    return projection!;
  }

  async readAgentApiTasks(principal: ExternalAgentPrincipal, input: Parameters<TaskService["listAgentApiTasks"]>[1] & { filter?: AgentApiTaskFilter; view?: "summary" | "full" }, github: AgentApiGithubPort = createGithubReleasePort()): Promise<{ tasks: Array<AgentApiTaskReadProjection | AgentApiTaskSummaryProjection>; nextCursor: string | null }> {
    const page = this.listAgentApiTasks(principal, input);
    const filter = input.filter;
    if (input.view === "summary" && !filter) return { tasks: page.tasks.map(task => this.agentApiTaskSummary(task)), nextCursor: page.nextCursor };
    const tasks = await this.withAgentApiIntegration(principal, page.tasks, github);
    // Integration health comes from GitHub, not the query, so the filter narrows a page already drawn. The cursor still walks every task.
    const filtered = filter === undefined ? tasks : tasks.filter(projection => matchesAgentApiFilter(projection, filter));
    return { tasks: input.view === "summary" ? filtered.map(task => this.agentApiTaskSummary(task)) : filtered, nextCursor: page.nextCursor };
  }

  private async withAgentApiIntegration(principal: ExternalAgentPrincipal, projections: AgentApiSafeTaskProjection[], github: AgentApiGithubPort): Promise<AgentApiTaskReadProjection[]> {
    if (!projections.length) return [];
    const targetRows = projections.map(projection => this.repository.row(projection.id)!);
    const targets = targetRows.map(row => this.repository.task(row));
    const pool = this.repository.agentApiRows({ agentId: principal.agentId, companyId: principal.companyId, limit: AGENT_API_UPSTREAM_POOL }).map(row => this.repository.task(row));
    const upstreams = new Map(targets.map(task => [task.id, pool.filter(other => isUpstreamOf(other, task))] as const));
    const observed = new Map<string, Task>();
    for (const task of [...targets, ...[...upstreams.values()].flat()]) observed.set(task.id, task);
    const observedAt = new Date().toISOString();
    const integrations = new Map(await Promise.all([...observed.values()].map(async task => [task.id, deriveTaskIntegration(task, await this.observeTaskPullRequest(task, github), observedAt)] as const)));
    return projections.map((projection, index) => {
      const task = targets[index]!;
      const integration = integrations.get(task.id)!;
      const blocking = upstreams.get(task.id)!.find(other => !integrations.get(other.id)?.integrated);
      const actionRequired = deriveActionRequired(task, integration, blocking ? { taskId: blocking.id, pullRequestNumber: blocking.pullRequest?.number ?? null } : null);
      return {
        ...projection,
        implementation: { status: projection.status },
        integration,
        actionRequired: actionRequired?.owner === "agent" && targetRows[index]!.creator_agent_id !== principal.agentId
          ? { ...actionRequired, owner: "task_owner" as const, suggestedCommands: [] }
          : actionRequired,
      };
    });
  }

  private async observeTaskPullRequest(task: Task, github: AgentApiGithubPort): Promise<PullRequestObservationResult> {
    if (!observableDelivery(task)) return { observation: null, failureCode: null };
    try {
      return { observation: await github.observePullRequest({ repository: task.configuration.repository, branch: task.configuration.branch, pullRequestNumber: task.pullRequest?.number ?? null }), failureCode: null };
    } catch (error) {
      return { observation: null, failureCode: error instanceof GithubReleaseFailure ? error.code : "provider-unavailable" };
    }
  }

  async commandAgentApiTask(principal: ExternalAgentPrincipal, taskId: string, raw: unknown): Promise<AgentApiSafeTaskProjection> {
    let input: AgentApiCommand;
    try { input = AgentApiTaskCommandBodySchema.parse(raw); }
    catch { throw new TaskFailure("Invalid request", 400, "request_invalid"); }
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const authority: Authority = { kind: "agentApi", principal };
    this.requireTask(authority, taskId);
    // This historical table name preserves existing idempotency receipts across the public rename.
    const stored = this.database.authQuery(db => db.prepare("SELECT request_hash, result_json FROM forge_hermes_task_command_receipts WHERE agent_id = ? AND task_id = ? AND idempotency_key = ?").get(principal.agentId, taskId, input.idempotencyKey) as { request_hash: string; result_json: string } | undefined);
    if (stored) {
      if (stored.request_hash !== requestHash) throw new TaskFailure("This idempotency key belongs to a different request", 409, "idempotency_conflict");
      return AgentApiSafeTaskProjectionSchema.parse(JSON.parse(stored.result_json));
    }
    const inFlight = agentApiCommandKey(principal.agentId, taskId, input.idempotencyKey);
    if (agentApiCommandsInFlight.has(inFlight)) throw new TaskFailure("This command is still being processed", 409, "command_in_progress");
    agentApiCommandsInFlight.add(inFlight);
    try {
      const row = this.requireTask(authority, taskId);
      const before = this.agentApiProjection(row, principal);
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
        case "disarm_task": this.repository.controls.disarm(taskId); break;
        case "cancel_task": this.repository.controls.cancel(taskId); break;
        case "unarchive_task": this.unarchive(authority, taskId); break;
        case "send_task_note": this.note(authority, taskId, input.note!, `Agent note (${principal.agentId})`); break;
        // TaskHost owns delivery observation; the route schedules that recovery after this returns.
        case "recheck_delivery_wait": break;
        case "archive_task":
          if ("dirtyFileCount" in await this.archive(authority, taskId, false)) throw new TaskFailure("Discard dirty worktree changes before archiving", 409, "illegal_command");
          break;
        case "duplicate_task": resultTaskId = await this.duplicateTaskForAgentApi(principal, taskId, input.idempotencyKey); break;
      }
      const result = this.getAgentApiTask(principal, resultTaskId);
      this.database.authTransaction(db => db.prepare("INSERT INTO forge_hermes_task_command_receipts (agent_id, task_id, idempotency_key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(principal.agentId, taskId, input.idempotencyKey, requestHash, JSON.stringify(result), new Date().toISOString()));
      this.audit(authority, principal.companyId, AGENT_API_COMMAND_AUDITS[input.command], taskId);
      return result;
    } finally { agentApiCommandsInFlight.delete(inFlight); }
  }

  agentApiIdentity(principal: ExternalAgentPrincipal) {
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
      capabilities: { taskDiscovery: true as const, taskRead: true as const, taskCreate: true as const, taskCommands: [...AGENT_API_TASK_COMMANDS] },
      projects: withPolicy,
    };
  }

  listAgentApiTasks(principal: ExternalAgentPrincipal, input: { projectId?: string; status?: string; pullRequestNumber?: number; sourceBranch?: string; titleContains?: string; archived?: boolean; attention?: boolean; blocker?: boolean; updatedSince?: string; cursor?: string; limit: number }) {
    if (input.projectId) this.requireScope({ kind: "agentApi", principal }, principal.companyId, input.projectId);
    const filter = { projectId: input.projectId ?? null, status: input.status ?? null, pullRequestNumber: input.pullRequestNumber ?? null, sourceBranch: input.sourceBranch ?? null, titleContains: input.titleContains ?? null, archived: input.archived ?? null, attention: input.attention ?? null, blocker: input.blocker ?? null, updatedSince: input.updatedSince ?? null };
    const cursor = input.cursor ? this.parseAgentApiCursor(input.cursor, principal, filter) : null;
    const rows = this.repository.agentApiRows({
      agentId: principal.agentId,
      companyId: principal.companyId,
      limit: input.limit + 1,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.pullRequestNumber === undefined ? {} : { pullRequestNumber: input.pullRequestNumber }),
      ...(input.sourceBranch === undefined ? {} : { sourceBranch: input.sourceBranch }),
      ...(input.titleContains === undefined ? {} : { titleContains: input.titleContains }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(input.attention === undefined ? {} : { attention: input.attention }),
      ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
      ...(input.updatedSince === undefined ? {} : { updatedSince: input.updatedSince }),
      ...(cursor ? { cursor } : {}),
    });
    const hasMore = rows.length > input.limit;
    const tasks = rows.slice(0, input.limit).map(row => this.agentApiProjection(row, principal));
    const last = tasks.at(-1);
    return { tasks, nextCursor: last && hasMore ? this.createAgentApiCursor(principal, filter, last) : null };
  }

  private async create(authority: Authority, companyId: string, raw: TaskInput, capturedDispatch?: GithubTriggerDispatch, requestHashOverride?: string, agentApiPolicySignature?: string, agentApiRaw?: AgentApiTaskCreateBody, copiedFromTaskId?: string, hermesSelection?: { workflowId: string | null; workflowName: string | null; templateId: string | null }, dryRun = false): Promise<TaskCreationResult> {
    let normalized: TaskInput;
    try { normalized = normalizeWorkflowInput(raw, { requireSource: true }); }
    catch (error) { if (error instanceof WorkflowInputFailure) throw new TaskFailure(error.message, error.statusCode); throw error; }
    const request = TaskInputSchema.parse(normalized);
    if (capturedDispatch && (request.startImmediately || request.images.length)) throw new TaskFailure("GitHub trigger dispatch is invalid", 422);
    this.requireScope(authority, companyId, request.projectId, true, agentApiRaw ? { code: "project_not_found", field: "projectId", value: request.projectId, reason: "The project is not available." } : undefined);
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
      if (!supportsDeliveryTarget(project.integration?.repository, request.deliveryTarget)) throw new TaskFailure("Bitbucket supports draft pull requests. Select a supported delivery target.", 422);
      const projectSnapshot = this.projectConfigurationSignature(project);
      if (!project.repository) throw new TaskFailure("Configure the project repository before creating a task", 422);
      if (authority.kind === "agentApi") for (const dependency of request.dependsOn) {
        if (!this.repository.row(dependency)) throw new TaskFailure("The dependency is not available.", 422, "dependency_not_found", { details: { field: "dependsOn", value: dependency, reason: "The dependency is not available." } });
        try { this.requireReadableAgentApiTask(authority.principal, dependency); }
        catch { throw new TaskFailure("The dependency is not available.", 422, "dependency_not_found", { details: { field: "dependsOn", value: dependency, reason: "The dependency is not available." } }); }
      }
      const pullRequestDependencies = await this.observePullRequestDependencies(project.repository, request.blockedByPullRequests, authority.kind === "agentApi");
      const defaults = this.database.authQuery(db => z.object({ root: z.string(), worker: z.string() }).parse(db.prepare("SELECT root_profile_id AS root, worker_profile_id AS worker FROM forge_projects WHERE id = ? AND company_id = ?").get(project.id, companyId)));
      let rootProfile = capturedDispatch ? (this.profile(capturedDispatch.profiles.root.profileId, "root"), capturedDispatch.profiles.root) : this.projectProfile(request.rootProfileId, defaults.root, "root", project.providerPolicy);
      let workerProfile = capturedDispatch ? (this.profile(capturedDispatch.profiles.worker.profileId, "worker"), capturedDispatch.profiles.worker) : this.projectProfile(request.workerProfileId, defaults.worker, "worker", project.providerPolicy);
      let advisorProfiles: Partial<Record<AdvisorRole, TaskProfile>> = {};
      for (const role of workflowDefinition(request.workflow).advisorRoles) advisorProfiles[role] = capturedDispatch ? (this.profile(capturedDispatch.profiles.advisors[role]!.profileId, "root"), capturedDispatch.profiles.advisors[role]!) : this.profile(request.advisorProfileIds[role] ?? rootProfile.profileId, "root");
      const images = request.images.map(image => ({ filename: image.filename, mimeType: image.mimeType, bytes: decodeTaskImage(image) }));
      const legacyIssueSource = request.issue === undefined;
      let source = null;
      try { source = request.source ? await this.projects.resolveTaskSource(project, request.source) : null; }
      catch (error) {
        if (authority.kind !== "agentApi" || !request.source || !(error instanceof TaskSourceFailure || error instanceof ProjectFailure)) throw error;
        if (error.statusCode >= 500) throw error;
        const field = request.source.kind === "issue" ? "source.issue" : request.source.kind === "pull_request" ? "source.pullRequest" : "source.branch";
        const value = request.source.kind === "branch" ? request.source.branch : String(request.source.number);
        const code = request.source.kind === "issue" ? "source_issue_rejected" : request.source.kind === "pull_request" ? "source_pull_request_rejected" : "source_branch_rejected";
        const reason = error instanceof ProjectFailure ? error.publicMessage : error.message;
        throw new TaskFailure(reason, 422, code, { details: { field, value, reason } });
      }
      if (request.issue) request.issue = (await this.issueTracker(taskTracker({ repository: project.repository, ...(project.integration ? { integration: project.integration } : {}) })).read(request.issue)).issue;
      else if (request.issue === undefined && request.source?.kind === "issue") request.issue = IssueAssociationSchema.parse({ kind: "github", repository: project.repository, number: request.source.number, id: String(request.source.number), key: `#${request.source.number}`, title: request.title, url: `https://github.com/${project.repository}/issues/${request.source.number}` });
      if (source?.kind === "issue" && legacyIssueSource) request.description = request.description ? `${request.description}\n\n${source.context}` : source.context;
      const heads = await this.projects.captureTaskConfiguration(project);
      if (capturedDispatch && (source?.kind !== "pull_request" || source.number !== capturedDispatch.pullRequestNumber || source.headSha !== capturedDispatch.policy.headSha || source.baseSha !== capturedDispatch.policy.baseSha || source.headBranch !== capturedDispatch.policy.headBranch || source.baseBranch !== capturedDispatch.policy.baseBranch || project.repository?.toLowerCase() !== capturedDispatch.repositoryName || project.baseBranch !== capturedDispatch.policy.baseBranch)) throw new TaskFailure("GitHub trigger source changed", 409);
      const taskId = newTaskId();
      const configuration = TaskConfigurationSchema.parse({
        providerPolicy: project.providerPolicy,
        integration: project.integration,
        execution: project.execution,
        repository: project.repository, repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot,
        branch: source?.kind === "pull_request" ? source.headBranch : source?.kind === "branch" ? source.branch : taskBranchName(request.title, taskId),
        baseBranch: source?.kind === "pull_request" ? source.baseBranch : project.baseBranch,
        baselineSha: source?.kind === "pull_request" ? source.baseSha : heads.baseSha,
        startingSha: source && source.kind !== "issue" ? source.headSha : heads.baseSha, setupCommand: project.setupCommand, verificationCommand: project.verificationCommand,
        runProjectTests: request.runProjectTests, visualEvidence: request.visualEvidence, source: request.source ?? null, capturedAt: new Date().toISOString(),
        ...(hermesSelection ? { hermesSelection } : {}),
      });
      return this.database.authImmediateTransaction(db => {
        this.requireScope(authority, companyId, request.projectId, true);
        // A concurrent identical AgentApi request is already admitted; only its current scope remains relevant.
        if (authority.kind === "agentApi") {
          const existing = this.repository.existing(companyId, request.idempotencyKey, requestHash, creator);
          if (existing) {
            const result = { task: this.repository.task(existing), created: false };
            if (dryRun) throw new DryRunRollback(result);
            return result;
          }
        }
        if (authority.kind === "agentApi" && agentApiPolicySignature && agentApiRaw) {
          const current = this.resolveAgentApiRequest(companyId, agentApiRaw);
          if (current.signature !== agentApiPolicySignature || this.projectConfigurationSignature(this.projects.getProjectInCompany(companyId, request.projectId)) !== projectSnapshot) throw new TaskFailure("Project task configuration changed", 409);
          rootProfile = this.profile(current.request.rootProfileId!, "root");
          workerProfile = this.profile(current.request.workerProfileId!, "worker");
          advisorProfiles = this.agentApiAdvisorProfiles(current.request, rootProfile);
        }
        if (capturedDispatch) {
          this.requireGithubTriggerAdmission(capturedDispatch);
          if (this.projectConfigurationSignature(this.projects.getProjectInCompany(companyId, request.projectId)) !== projectSnapshot) throw new TaskFailure("Project configuration changed", 409);
        }
        this.requireEligibleProfiles(project.providerPolicy, [rootProfile, workerProfile, ...Object.values(advisorProfiles)]);
        if (this.projectConfigurationSignature(this.projects.getProjectInCompany(companyId, request.projectId)) !== projectSnapshot) throw new TaskFailure("Project configuration changed", 409);
        // A copy commits with the source it was authorized against, and carries that provenance from its first row.
        const result = this.repository.create({ taskId, companyId, creator, request, requestHash, configuration, rootProfile, workerProfile, advisorProfiles, images: dryRun ? [] : images, startQueued: request.startImmediately, ...(copiedFromTaskId ? { copiedFromTaskId } : {}) });
        if (capturedDispatch) new GithubTriggerDispatchRepository(this.database).linkTask(capturedDispatch.id, result.task.id);
        if (result.created) {
          for (const dependency of request.dependsOn) {
            if (authority.kind === "agentApi") this.requireReadableAgentApiTask(authority.principal, dependency);
            else this.requireTask(authority, dependency);
          }
          const stamp = new Date().toISOString();
          for (const dependency of [...new Set(request.dependsOn)].sort()) db.prepare("INSERT INTO forge_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)").run(result.task.id, dependency, stamp);
          if (pullRequestDependencies.length) replacePullRequestDependenciesInTransaction(db, result.task.id, pullRequestDependencies);
          // The prerequisites are written first, so a queued task starts now only when every one is already complete.
          if (request.startImmediately) this.repository.controls.admitQueued([result.task.id]);
          this.audit(authority, companyId, "task_created", result.task.id);
          const created = { task: this.repository.task(this.repository.row(result.task.id)!), created: true };
          if (dryRun) throw new DryRunRollback(created);
          return created;
        }
        if (dryRun) throw new DryRunRollback(result);
        return result;
      });
    } catch (error) {
      if (error instanceof DryRunRollback) return error.result;
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

  /** Queues the task. It starts now when every prerequisite is complete; otherwise it stays queued and starts when they are. */
  startTask(userId: string, taskId: string): Task {
    const task = this.getTask(userId, taskId);
    if (archivesInProgress.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409);
    if (task.archivedAt || !["backlog", "active"].includes(task.status)) throw new TaskFailure("This task cannot be started", 409);
    this.repository.controls.start(taskId);
    this.audit({ kind: "user", userId }, task.companyId, "task_started", taskId);
    return this.getTask(userId, taskId);
  }

  /** Returns a queued task to the manual backlog. The same people who can start a task can disarm it. */
  disarmTask(userId: string, taskId: string): Task {
    const task = this.getTask(userId, taskId);
    if (task.archivedAt || !this.repository.controls.disarm(taskId)) throw new TaskFailure("Only a task in the backlog can be disarmed", 409);
    this.audit({ kind: "user", userId }, task.companyId, "task_disarmed", taskId);
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

  continueDelivery(userId: string, taskId: string, deliveryTarget: z.infer<typeof TaskContinueDeliveryBodySchema>["deliveryTarget"]): Task {
    const task = this.getTask(userId, taskId);
    if (archivesInProgress.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409);
    if (task.archivedAt) throw new TaskFailure("Open the archived task before you continue delivery.", 409);
    if (!supportsDeliveryTarget(task.configuration.integration?.repository, deliveryTarget)) throw new TaskFailure("Bitbucket supports draft pull requests. Select a supported delivery target.", 422);
    try { this.repository.controls.continueDelivery(taskId, deliveryTarget); }
    catch (error) { throw new TaskFailure(error instanceof Error ? error.message : "Forge could not continue delivery.", 409); }
    return this.getTask(userId, taskId);
  }

  /** Wakes the Coordinator with a note from either authority. AgentApi replays are already deduped by their receipt. */
  private note(authority: Authority, taskId: string, note: string, label: string): void {
    const task = this.repository.task(this.requireTask(authority, taskId));
    if (task.archivedAt || !["active", "delivered"].includes(task.status)) throw new TaskFailure("Start the task or answer its current decision before you send a message.", 409, authority.kind === "agentApi" ? "illegal_command" : "task_failure");
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
    this.requireEligibleProfiles(task.configuration.providerPolicy, [rootProfile, workerProfile, ...Object.values(advisorProfiles)]);
    if (!supportsDeliveryTarget(task.configuration.integration?.repository, normalized.deliveryTarget ?? task.deliveryTarget)) throw new TaskFailure("Bitbucket supports draft pull requests. Select a supported delivery target.", 422);
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

  async setTaskIssue(userId: string, taskId: string, raw: IssueAssociation | null): Promise<Task> {
    const issue = IssueAssociationSchema.nullable().parse(raw);
    const task = this.getTask(userId, taskId);
    const resolved = issue ? (await this.issueTracker(taskTracker(task.configuration)).read(issue)).issue : null;
    return this.database.authImmediateTransaction(db => {
      const current = this.getTask(userId, taskId);
      db.prepare("UPDATE forge_tasks SET issue_json = ?, updated_at = ? WHERE id = ?").run(resolved ? JSON.stringify(resolved) : null, new Date().toISOString(), taskId);
      if (current.status === "backlog" && !hasStartedNativeWork(this.database, taskId)) db.prepare("UPDATE forge_tasks SET issue_context_json = NULL WHERE id = ?").run(taskId);
      return this.getTask(userId, taskId);
    });
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
      sessions: this.repository.controls.sessions(taskId).map(session => {
        const profile = this.sessionProfile(task, session);
        return { id: session.id, kind: session.kind, advisorRole: session.advisorRole, label: roleLabel(session), profileId: profile.profileId, harness: profile.provider, generation: session.generation, nativeSessionId: session.nativeSessionId, paneId: session.paneId, current: session.current, replacement: session.replacement };
      }),
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
    const value = this.database.authQuery(db => db.prepare("SELECT p.id AS profileId, p.provider, p.model, p.reasoning_level AS reasoningLevel, p.service_tier AS serviceTier, p.provider_instance_id AS providerInstanceId, i.home_directory AS instanceHomeDirectory FROM forge_profiles p LEFT JOIN forge_provider_instances i ON i.id = p.provider_instance_id WHERE p.id = ? AND p.role = ? AND p.archived_at IS NULL").get(profileId, role));
    if (!value) throw new TaskFailure("The selected agent profile does not exist", 422);
    return TaskProfileSchema.parse(value);
  }

  private requireEligibleProfiles(policy: ProjectProviderPolicy | null | undefined, profiles: TaskProfile[]): void {
    if (profiles.some(profile => !isProfileAllowed(policy, profile))) throw new TaskFailure("Select agents with providers and logins allowed by this project", 422);
  }

  private projectProfile(explicit: string | undefined, defaultId: string, role: "root" | "worker", policy: ProjectProviderPolicy | null | undefined): TaskProfile {
    if (explicit) return this.profile(explicit, role);
    const preferred = this.profile(defaultId, role);
    if (isProfileAllowed(policy, preferred)) return preferred;
    const ids = this.database.authQuery(db => z.array(z.object({ id: z.string() })).parse(db.prepare("SELECT id FROM forge_profiles WHERE role = ? AND archived_at IS NULL ORDER BY created_at, id").all(role)));
    const eligible = ids.map(({ id }) => this.profile(id, role)).find(profile => isProfileAllowed(policy, profile));
    if (!eligible) throw new TaskFailure("Create an agent with a provider and login allowed by this project", 422);
    return eligible;
  }

  private resolveAgentApiRequest(companyId: string, raw: AgentApiTaskCreateBody): { request: TaskInput; selection: { workflowId: string | null; workflowName: string | null; templateId: string | null }; signature: string } {
    const project = this.projects.getProjectInCompany(companyId, raw.projectId);
    const policy = ProjectAgentTaskPolicySchema.parse(project.agentTaskPolicy);
    const template = raw.templateId ? this.templateForAgentApi(project.id, policy, raw.templateId) : undefined;
    const workflow = template ? undefined : this.workflowForAgentApi(policy, raw.workflowId ?? policy.defaultWorkflowId);
    const selected = template?.request ?? workflow!.request;
    const selection = template ? { workflowId: null, workflowName: null, templateId: raw.templateId! } : { workflowId: workflow!.id, workflowName: workflow!.name, templateId: null };
    let request: ReturnType<typeof TaskInputSchema.parse>;
    try {
      request = TaskInputSchema.parse(normalizeWorkflowInput({
        projectId: raw.projectId, title: raw.title, description: raw.description === undefined ? selected.description ?? "" : raw.description, idempotencyKey: raw.idempotencyKey, images: raw.images, source: raw.source, dependsOn: raw.dependsOn, blockedByPullRequests: raw.blockedByPullRequests,
        workflow: selected.workflow ?? "standard", rootProfileId: raw.rootProfileId ?? selected.rootProfileId, workerProfileId: raw.workerProfileId ?? selected.workerProfileId,
        advisorProfileIds: Object.keys(raw.advisorProfileIds).length ? raw.advisorProfileIds : selected.advisorProfileIds ?? {},
        deliveryTarget: policy.deliveryTarget, runProjectTests: policy.runProjectTests, visualEvidence: policy.visualEvidence, startImmediately: raw.queue ?? false,
      }, { requireSource: true }));
    } catch (error) {
      if (error instanceof WorkflowInputFailure) throw new TaskFailure(error.message, error.statusCode);
      throw error;
    }
    if (raw.deliveryTarget !== undefined && raw.deliveryTarget !== policy.deliveryTarget || raw.runProjectTests !== undefined && raw.runProjectTests !== policy.runProjectTests || raw.visualEvidence !== undefined && raw.visualEvidence !== policy.visualEvidence) throw new TaskFailure(`This project permits deliveryTarget "${policy.deliveryTarget}", runProjectTests ${policy.runProjectTests}, and visualEvidence "${policy.visualEvidence}"`, 422, "delivery_policy_rejected");
    if (raw.rootProfileId !== undefined) this.agentApiProfile(raw.rootProfileId, "root", "rootProfileId");
    if (raw.workerProfileId !== undefined) this.agentApiProfile(raw.workerProfileId, "worker", "workerProfileId");
    const root = this.projectProfile(request.rootProfileId, project.rootProfileId, "root", project.providerPolicy).profileId;
    const worker = this.projectProfile(request.workerProfileId, project.workerProfileId, "worker", project.providerPolicy).profileId;
    // The allowlist governs what a caller may choose; server-chosen defaults (project defaults, workflow and template records) are already trusted.
    if (raw.rootProfileId !== undefined && !policy.rootProfileIds.includes(raw.rootProfileId)) throw new TaskFailure("The selected root profile is not permitted.", 422, "root_profile_not_permitted", { details: { field: "rootProfileId", value: raw.rootProfileId, reason: "The selected root profile is not permitted." } });
    if (raw.workerProfileId !== undefined && !policy.workerProfileIds.includes(raw.workerProfileId)) throw new TaskFailure("The selected worker profile is not permitted.", 422, "worker_profile_not_permitted", { details: { field: "workerProfileId", value: raw.workerProfileId, reason: "The selected worker profile is not permitted." } });
    for (const role of workflowDefinition(request.workflow).advisorRoles) {
      const profileId = request.advisorProfileIds[role] ?? root;
      if (raw.advisorProfileIds[role] !== undefined) this.agentApiProfile(profileId, "root", `advisorProfileIds.${role}`);
      if (!policy.advisorProfileIds[role].includes(profileId)) throw new TaskFailure("The selected Advisor profile is not permitted.", 422, "advisor_profile_not_permitted", { details: { field: `advisorProfileIds.${role}`, value: profileId, reason: "The selected Advisor profile is not permitted." } });
    }
    const resolved = { ...request, rootProfileId: root, workerProfileId: worker };
    return { request: resolved, selection, signature: JSON.stringify({ request: resolved, selection }) };
  }

  private workflowForAgentApi(policy: ProjectAgentTaskPolicy, workflowId: string): { id: string; name: string; request: Partial<z.infer<typeof CreateTaskTemplateBodySchema>> } {
    const row = this.database.authQuery(db => db.prepare("SELECT name, description, configuration_json, engine FROM forge_workflows WHERE id = ? AND archived_at IS NULL").get(workflowId) as { name: string; description: string; configuration_json: string; engine: string } | undefined);
    if (!row) throw new TaskFailure("The selected workflow is not available", 422, "workflow_not_found", { details: { field: "workflowId", value: workflowId, reason: "The selected workflow is not available.", permittedWorkflowIds: policy.workflowIds } });
    if (!policy.workflowIds.includes(workflowId)) throw new TaskFailure("The selected workflow is not permitted", 422, "workflow_not_permitted", { details: { field: "workflowId", value: workflowId, reason: "The selected workflow is not permitted.", permittedWorkflowIds: policy.workflowIds } });
    const record = WorkflowRecordInputSchema.parse({ ...JSON.parse(row.configuration_json), name: row.name, description: row.description, engine: row.engine });
    return { id: workflowId, name: record.name, request: {
      workflow: record.engine,
      advisorProfileIds: record.advisorProfileIds,
      ...(record.rootProfileId ? { rootProfileId: record.rootProfileId } : {}),
      ...(record.workerProfileId ? { workerProfileId: record.workerProfileId } : {}),
    } };
  }

  private templateForAgentApi(projectId: string, policy: ProjectAgentTaskPolicy, templateId: string): { request: z.infer<typeof CreateTaskTemplateBodySchema> } {
    const row = this.database.authQuery(db => db.prepare("SELECT configuration_json FROM forge_task_templates WHERE id = ? AND project_id = ?").get(templateId, projectId) as { configuration_json: string } | undefined);
    if (!row) throw new TaskFailure("The selected template is not available", 422, "template_not_found", { details: { field: "templateId", value: templateId, reason: "The selected template is not available.", permittedTemplateIds: policy.templateIds } });
    if (!policy.templateIds.includes(templateId)) throw new TaskFailure("The selected template is not permitted", 422, "template_not_permitted", { details: { field: "templateId", value: templateId, reason: "The selected template is not permitted.", permittedTemplateIds: policy.templateIds } });
    return { request: CreateTaskTemplateBodySchema.parse(JSON.parse(row.configuration_json)) };
  }

  private agentApiDryRunPreview(principal: ExternalAgentPrincipal, task: Task): z.infer<typeof AgentApiTaskCreateDryRunResponseSchema> {
    const project = this.projects.getProjectInCompany(principal.companyId, task.projectId);
    const selection = task.configuration.hermesSelection;
    return AgentApiTaskCreateDryRunResponseSchema.parse({
      dryRun: true,
      projectId: task.projectId,
      project: { id: project.id, name: project.name },
      title: task.title,
      workflow: { id: selection?.workflowId ?? null, engine: task.workflow, name: selection?.workflowName ?? null },
      templateId: selection?.templateId ?? null,
      deliveryTarget: task.deliveryTarget,
      branch: task.configuration.branch,
      dependsOn: task.dependsOn,
      ...this.wouldStart(task.queue),
    });
  }

  private agentApiDryRunTaskProjection(principal: ExternalAgentPrincipal, task: Task): AgentApiSafeTaskProjection {
    const project = this.projects.getProjectInCompany(principal.companyId, task.projectId);
    const selection = task.configuration.hermesSelection;
    return AgentApiSafeTaskProjectionSchema.parse({
      id: task.id,
      issueKey: task.issueKey,
      projectId: task.projectId,
      project: { id: project.id, name: project.name },
      title: task.title,
      source: task.configuration.source,
      status: task.status,
      queue: task.queue,
      dependsOn: task.dependsOn,
      blockedBy: task.blockedBy.map(({ id, title, status }) => ({ id, title, status })),
      archived: false,
      revision: "dry-run",
      permittedCommands: [],
      humanQuestion: null,
      blocker: null,
      workflowStage: task.queue.state,
      workflow: { id: selection?.workflowId ?? null, engine: task.workflow, name: selection?.workflowName ?? null },
      templateId: selection?.templateId ?? null,
      deliveryTarget: task.deliveryTarget,
      runProjectTests: task.configuration.runProjectTests,
      visualEvidence: task.configuration.visualEvidence,
      delivery: null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  private wouldStart(queue: Task["queue"]): { wouldStart: "now" | "waiting" | "backlog"; blockingPrerequisiteIds: string[] } {
    if (queue.startIntent === "manual") return { wouldStart: "backlog", blockingPrerequisiteIds: [] };
    if (queue.state === "running") return { wouldStart: "now", blockingPrerequisiteIds: [] };
    return { wouldStart: "waiting", blockingPrerequisiteIds: queue.waitingOn.map(prerequisite => prerequisite.id) };
  }

  private dryRunTransaction<T>(operation: () => T): T {
    const rollback = {};
    let result!: T;
    try {
      this.database.authImmediateTransaction(() => {
        result = operation();
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return result;
  }

  private agentApiRequestHash(input: AgentApiTaskCreateBody, creator: TaskCreator): string {
    const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sort(entry)])) : value;
    const request = { ...input };
    delete request.dryRun;
    return createHash("sha256").update(JSON.stringify(sort({ input: request, creator }))).digest("hex");
  }

  private agentApiProfile(profileId: string, role: "root" | "worker", field: string): TaskProfile {
    try { return this.profile(profileId, role); }
    catch (error) {
      if (!(error instanceof TaskFailure)) throw error;
      const code = role === "worker" ? "worker_profile_not_found" : field === "rootProfileId" ? "root_profile_not_found" : "advisor_profile_not_found";
      const reason = "The selected agent profile is not available.";
      throw new TaskFailure(reason, 422, code, { details: { field, value: profileId, reason } });
    }
  }

  private isLegacyAgentApiRequest(input: AgentApiTaskCreateBody): boolean {
    return !input.queue && !input.dependsOn?.length && !input.images.length && !input.source && !input.workflowId && !input.templateId && !input.rootProfileId && !input.workerProfileId && Object.keys(input.advisorProfileIds).length === 0 && input.deliveryTarget === undefined && input.runProjectTests === undefined && input.visualEvidence === undefined;
  }

  private legacyAgentApiRequest(input: AgentApiTaskCreateBody): TaskInput {
    return TaskInputSchema.parse(normalizeWorkflowInput({ projectId: input.projectId, title: input.title, description: input.description ?? "", idempotencyKey: input.idempotencyKey }, { requireSource: true }));
  }

  private agentApiAdvisorProfiles(request: TaskInput, rootProfile: TaskProfile): Partial<Record<AdvisorRole, TaskProfile>> {
    return Object.fromEntries(workflowDefinition(request.workflow ?? "standard").advisorRoles.map(role => [role, this.profile(request.advisorProfileIds?.[role] ?? rootProfile.profileId, "root")])) as Partial<Record<AdvisorRole, TaskProfile>>;
  }

  private projectConfigurationSignature(project: Project): string {
    return JSON.stringify({ repository: project.repository, repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot, baseBranch: project.baseBranch, setupCommand: project.setupCommand, verificationCommand: project.verificationCommand, providerPolicy: project.providerPolicy, integration: project.integration, execution: project.execution });
  }

  private requireTask(authority: Authority, taskId: string): TaskRow {
    const row = this.repository.row(taskId);
    if (!row) throw new TaskFailure("Not found", 404, authority.kind === "agentApi" ? "resource_not_found" : "task_failure");
    this.requireScope(authority, row.company_id, row.project_id);
    if (authority.kind === "agentApi" && row.creator_agent_id !== authority.principal.agentId) throw new TaskFailure("Not found", 404, "resource_not_found");
    return row;
  }

  private requireReadableAgentApiTask(principal: ExternalAgentPrincipal, taskId: string): TaskRow {
    const row = this.repository.row(taskId);
    if (!row) throw new TaskFailure("Not found", 404, "resource_not_found");
    this.requireScope({ kind: "agentApi", principal }, row.company_id, row.project_id);
    return row;
  }

  private agentApiProjection(row: TaskRow, principal: ExternalAgentPrincipal): AgentApiSafeTaskProjection {
    const task = this.repository.task(row);
    const project = this.database.authQuery(db => db.prepare("SELECT id, name FROM forge_projects WHERE id = ? AND company_id = ?").get(row.project_id, row.company_id) as { id: string; name: string } | undefined);
    if (!project) throw new TaskFailure("Not found", 404);
    const humanQuestion = task.humanQuestion?.text ?? null;
    const wait = task.workflowState.deliveryWait;
    const completion = task.workflowState.completion;
    const blocker = humanQuestion ? { kind: "human_question" as const } : wait ? { kind: "delivery_wait" as const, reason: wait.reason } : null;
    const workflowStage = task.status === "cancelled" ? "cancelled" : completion || task.status === "delivered" ? "completed" : humanQuestion ? "waiting_human" : wait ? "waiting_delivery" : task.status === "active" ? "working" : task.queue.state;
    const delivery = task.pullRequest || wait || completion ? { pullRequest: task.pullRequest ? { number: task.pullRequest.number, url: task.pullRequest.url, state: task.pullRequest.state, mergedAt: task.pullRequest.mergedAt } : null, checks: null, waiting: wait ? { reason: wait.reason, since: wait.since } : null, completion: completion ? { kind: completion.kind, pullRequestNumber: completion.pullRequestNumber, observedAt: completion.observedAt } : null } : null;
    const recheck = !task.archivedAt && wait && task.status === "active" ? ["recheck_delivery_wait"] as const : [] as const;
    const lifecycleCommands = task.archivedAt ? ["unarchive_task"] as const
      : task.status === "backlog" ? [task.queue.startIntent === "queued" ? "disarm_task" : "start_task", "cancel_task", "archive_task", "duplicate_task"] as const
      : task.status === "active" ? ["cancel_task", "duplicate_task", "send_task_note"] as const
      : task.status === "waiting_human" ? ["cancel_task", "duplicate_task"] as const
      : task.status === "cancelled" ? ["archive_task", "duplicate_task"] as const
      : task.status === "delivered" ? ["archive_task", "duplicate_task"] as const
      : ["duplicate_task"] as const;
    const permittedCommands = row.creator_agent_id === principal.agentId ? [...lifecycleCommands, ...recheck] : [];
    const selection = task.configuration.hermesSelection;
    const value = { id: task.id, issueKey: task.issueKey, projectId: task.projectId, project, title: task.title, source: task.configuration.source, status: task.status, queue: task.queue, dependsOn: task.dependsOn, blockedBy: task.blockedBy.map(({ queued: _queued, ...blocker }) => blocker), archived: task.archivedAt !== null, permittedCommands, humanQuestion, blocker, workflowStage, workflow: { id: selection?.workflowId ?? null, engine: task.workflow, name: selection?.workflowName ?? null }, templateId: selection?.templateId ?? null, deliveryTarget: task.deliveryTarget, runProjectTests: task.configuration.runProjectTests, visualEvidence: task.configuration.visualEvidence, delivery, createdAt: task.createdAt, updatedAt: task.updatedAt };
    return { ...value, revision: createHash("sha256").update(JSON.stringify({ value, commandRevision: row.command_revision })).digest("base64url") };
  }

  private agentApiTaskSummary(task: AgentApiSafeTaskProjection): AgentApiTaskSummaryProjection {
    return {
      id: task.id, title: task.title, status: task.status, archived: task.archived, queue: task.queue.state, dependsOn: task.dependsOn, updatedAt: task.updatedAt,
      ...(task.workflow.name === null ? {} : { workflow: task.workflow.name }),
      ...(task.source === null ? {} : { source: task.source }),
      ...(task.delivery?.pullRequest === null || task.delivery === null ? {} : { pullRequestNumber: task.delivery.pullRequest.number }),
    };
  }

  private createAgentApiCursor(principal: ExternalAgentPrincipal, filter: object, task: AgentApiSafeTaskProjection): string {
    const payload = Buffer.from(JSON.stringify({ agentId: principal.agentId, filter, updatedAt: task.updatedAt, id: task.id })).toString("base64url");
    return `${payload}.${createHmac("sha256", principal.cursorKey).update(payload).digest("base64url")}`;
  }

  /** The copy carries the source configuration this project still permits, with provenance written by its creation. */
  private async duplicateTaskForAgentApi(principal: ExternalAgentPrincipal, taskId: string, key: string): Promise<string> {
    const row = this.requireTask({ kind: "agentApi", principal }, taskId);
    const source = this.repository.task(row);
    const policy = ProjectAgentTaskPolicySchema.parse(this.projects.getProjectInCompany(principal.companyId, source.projectId).agentTaskPolicy);
    const images = await Promise.all(source.images.map(async image => {
      const artifact = this.repository.artifact(row, image.artifactId);
      if (!artifact) throw new TaskFailure("A source task image is no longer available", 409, "illegal_command");
      return TaskImageInputSchema.parse({ filename: artifact.filename, mimeType: artifact.mimeType, base64: (await this.artifacts.getArtifact(artifact)).toString("base64") });
    }));
    const created = await this.createTaskForAgentApi(principal, {
      projectId: source.projectId, title: duplicateTitle(source.title, new Set()), description: source.description, idempotencyKey: agentApiDuplicateKey(taskId, key),
      workflowId: this.agentApiWorkflowIdForEngine(policy, source.workflow), templateId: undefined,
      rootProfileId: policy.rootProfileIds.includes(source.rootProfile.profileId) ? source.rootProfile.profileId : undefined,
      workerProfileId: policy.workerProfileIds.includes(source.workerProfile.profileId) ? source.workerProfile.profileId : undefined,
      advisorProfileIds: Object.fromEntries(Object.entries(source.advisorProfiles).filter(([role, profile]) => policy.advisorProfileIds[role as AdvisorRole]?.includes(profile.profileId)).map(([role, profile]) => [role, profile.profileId])), images,
      ...(source.configuration.source ? { source: source.configuration.source } : {}),
    }, taskId);
    return created.task.id;
  }

  /** Keeps the copy on the source workflow engine when the project still permits a record that runs it. */
  private agentApiWorkflowIdForEngine(policy: ProjectAgentTaskPolicy, engine: string): string {
    const engines = this.database.authQuery(db => new Map(policy.workflowIds.map(id => [id, (db.prepare("SELECT engine FROM forge_workflows WHERE id = ? AND archived_at IS NULL").get(id) as { engine: string } | undefined)?.engine])));
    return policy.workflowIds.find(id => engines.get(id) === engine) ?? policy.defaultWorkflowId;
  }

  private parseAgentApiCursor(value: string, principal: ExternalAgentPrincipal, filter: object): { updatedAt: string; id: string } {
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

  private requireScope(authority: Authority, companyId: string, projectId: string, active = false, agentApiFailure?: { code: string; field: string; value: string; reason: string }): void {
    if (authority.kind === "user") {
      const company = this.auth.requireCompanyAccess(authority.userId, companyId);
      if (active && company.status !== "active") throw new TaskFailure("The company is not active", 409);
      return;
    }
    const principal = authority.principal;
    if (principal.companyId !== companyId) throw agentApiFailure ? new TaskFailure(agentApiFailure.reason, 422, agentApiFailure.code, { details: agentApiFailure }) : new TaskFailure("Not found", 404, "resource_not_found");
    const allowed = this.database.authQuery(db => db.prepare("SELECT c.status FROM forge_external_agents a JOIN forge_external_agent_project_grants g ON g.agent_id = a.id AND g.company_id = a.company_id JOIN forge_companies c ON c.id = a.company_id WHERE a.id = ? AND a.company_id = ? AND a.status = 'paired' AND a.revoked_at IS NULL AND g.project_id = ?").get(principal.agentId, companyId, projectId));
    if (!allowed) throw agentApiFailure ? new TaskFailure(agentApiFailure.reason, 422, agentApiFailure.code, { details: agentApiFailure }) : new TaskFailure("Not found", 404, "resource_not_found");
    if (active && z.object({ status: z.string() }).parse(allowed).status !== "active") throw new TaskFailure("The company is not active", 409);
  }

  private audit(authority: Authority, companyId: string, action: string, taskId: string): void {
    const task = this.repository.row(taskId);
    const resultingState = task ? JSON.stringify({ status: this.repository.task(task).status, archived: task.archived_at !== null }) : "unknown";
    if (authority.kind === "user") this.auth.recordAuditEvent(authority.userId, action, undefined, companyId, { taskId, resultingState });
    else this.auth.recordAgentAuditEvent(authority.principal.agentId, action, undefined, companyId, { taskId, resultingState });
  }
}

import { createHash } from "node:crypto";
import { TaskAnalyticsStore } from "./analytics/store.js";
import { taskAnalytics } from "./analytics/analytics.js";
import { readTaskTimeline } from "./timeline/timeline.js";
import { removeTaskWorktree } from "./worktree.js";
import { stopIdleArchiveSessions } from "./archive/sessions.js";
import { z } from "zod";
import { AuthFailure, type AuthService } from "../identity/auth.js";
import { ArtifactStore, type StoredArtifact } from "../platform/artifacts.js";
import type { ForgeConfig } from "../platform/config.js";
import type { ForgeDatabase } from "../platform/database.js";
import type { HermesPrincipal } from "../identity/hermes-agents.js";
import type { ProjectService } from "../projects/projects.js";
import { TaskProfileSchema, type TaskProfile } from "./control.js";
import { TaskConfigurationSchema, TaskInputSchema, type Task, type TaskInput } from "./contracts.js";
import { decodeTaskImage } from "./images.js";
import { taskBranchName } from "./branch.js";
import { newTaskId, TaskConflict, TaskRepository, taskRequestHash, type TaskCreator, type TaskRow } from "./repository.js";
import { GithubTriggerDispatchRepository, type GithubTriggerDispatch } from "../integrations/github/trigger-dispatches.js";
import { assertTaskPullRequestsAvailable } from "../delivery/pull-request-ownership.js";
import type { GithubTriggerPort } from "../integrations/github/trigger-inspection.js";
import { matchesGithubTriggerProtectedPaths } from "../integrations/github/trigger-paths.js";
import { normalizeWorkflowInput, roleLabel, workflowDefinition, WorkflowInputFailure, type AdvisorRole } from "../coordination/workflows.js";
import type { TaskLimitDecision } from "./limits/limits.js";

export class TaskFailure extends Error {
  constructor(readonly publicMessage: string, readonly statusCode = 400) { super(publicMessage); }
}
type Authority = { kind: "user"; userId: string } | { kind: "hermes"; principal: HermesPrincipal };
type Projects = Pick<ProjectService, "getProject" | "getProjectInCompany" | "resolveTaskSource" | "captureTaskConfiguration">;
const DetailsSchema = TaskInputSchema.pick({ title: true, description: true }).partial().strict().refine(input => input.title !== undefined || input.description !== undefined);

export class TaskService {
  private readonly archives = new Set<string>();
  readonly repository: TaskRepository;
  private readonly artifacts: ArtifactStore;
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly projects: Projects, config: Pick<ForgeConfig, "artifactRoot">) {
    this.artifacts = new ArtifactStore(config.artifactRoot, database);
    this.repository = new TaskRepository(database, this.artifacts);
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

  async createTaskForHermes(principal: HermesPrincipal, input: Pick<TaskInput, "projectId" | "title" | "description" | "idempotencyKey">) {
    const result = await this.create({ kind: "hermes", principal }, principal.companyId, input);
    return { created: result.created, task: this.getHermesTask(principal, result.task.id) };
  }

  getHermesTask(principal: HermesPrincipal, taskId: string) {
    const task = this.repository.task(this.requireTask({ kind: "hermes", principal }, taskId));
    return { id: task.id, issueKey: task.issueKey, projectId: task.projectId, title: task.title, status: task.status, humanQuestion: task.humanQuestion?.text ?? null, createdAt: task.createdAt, updatedAt: task.updatedAt };
  }

  private async create(authority: Authority, companyId: string, raw: TaskInput, capturedDispatch?: GithubTriggerDispatch): Promise<{ task: Task; created: boolean }> {
    let normalized: TaskInput;
    try { normalized = normalizeWorkflowInput(raw, { requireSource: true }); }
    catch (error) { if (error instanceof WorkflowInputFailure) throw new TaskFailure(error.message, error.statusCode); throw error; }
    const request = TaskInputSchema.parse(normalized);
    if (capturedDispatch && (request.startImmediately || request.images.length)) throw new TaskFailure("GitHub trigger dispatch is invalid", 422);
    this.requireScope(authority, companyId, request.projectId, true);
    const creator: TaskCreator = authority.kind === "user" ? { kind: "user", id: authority.userId } : { kind: "agent", id: authority.principal.agentId };
    const requestHash = taskRequestHash(request, creator);
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
      const projectSnapshot = JSON.stringify(project);
      if (!project.repository) throw new TaskFailure("Configure the project repository before creating a task", 422);
      const defaults = this.database.authQuery(db => z.object({ root: z.string(), worker: z.string() }).parse(db.prepare("SELECT root_profile_id AS root, worker_profile_id AS worker FROM forge_projects WHERE id = ? AND company_id = ?").get(project.id, companyId)));
      const rootProfile = capturedDispatch ? (this.profile(capturedDispatch.profiles.root.profileId, "root"), capturedDispatch.profiles.root) : this.profile(request.rootProfileId ?? defaults.root, "root");
      const workerProfile = capturedDispatch ? (this.profile(capturedDispatch.profiles.worker.profileId, "worker"), capturedDispatch.profiles.worker) : this.profile(request.workerProfileId ?? defaults.worker, "worker");
      const advisorProfiles: Partial<Record<AdvisorRole, TaskProfile>> = {};
      for (const role of workflowDefinition(request.workflow).advisorRoles) advisorProfiles[role] = capturedDispatch ? (this.profile(capturedDispatch.profiles.advisors[role]!.profileId, "root"), capturedDispatch.profiles.advisors[role]!) : this.profile(request.advisorProfileIds[role] ?? rootProfile.profileId, "root");
      const images = request.images.map(image => ({ filename: image.filename, mimeType: image.mimeType, bytes: decodeTaskImage(image) }));
      const source = request.source ? await this.projects.resolveTaskSource(project, request.source) : null;
      if (source?.kind === "issue") request.description += `\n\n${source.context}`;
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
        if (capturedDispatch) {
          this.requireGithubTriggerAdmission(capturedDispatch);
          if (JSON.stringify(this.projects.getProjectInCompany(companyId, request.projectId)) !== projectSnapshot) throw new TaskFailure("Project configuration changed", 409);
        }
        const result = this.repository.create({ taskId, companyId, creator, request, requestHash, configuration, rootProfile, workerProfile, advisorProfiles, images });
        if (capturedDispatch) new GithubTriggerDispatchRepository(this.database).linkTask(capturedDispatch.id, result.task.id);
        if (result.created) this.audit(authority, companyId, "task_created", result.task.id);
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
    if (this.archives.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409);
    const task = this.getTask(userId, taskId);
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

  sendNote(userId: string, taskId: string, note: string): Task {
    const task = this.getTask(userId, taskId);
    const root = this.repository.controls.currentSession(taskId, "root");
    if (task.archivedAt || task.status !== "active" || !root) throw new TaskFailure("Start the task before sending a note", 409);
    const prompt = z.string().trim().min(1).max(20_000).parse(note);
    this.repository.controls.wakeRoot({ taskId, rootSessionId: root.id, generation: root.generation, prompt: `Human note:\n${prompt}` });
    return this.getTask(userId, taskId);
  }

  updateTaskDetails(userId: string, taskId: string, raw: z.input<typeof DetailsSchema>): Task {
    const input = DetailsSchema.parse(raw);
    this.getTask(userId, taskId);
    if (!this.repository.updateDetails(taskId, input)) throw new TaskFailure("Only tasks in the backlog can be edited. Open archived tasks before editing them.", 409);
    return this.getTask(userId, taskId);
  }

  unarchiveTask(userId: string, taskId: string): Task {
    const task = this.getTask(userId, taskId);
    if (this.archives.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409);
    this.database.authImmediateTransaction(db => { if (["backlog", "active", "waiting_human"].includes(task.status)) assertTaskPullRequestsAvailable(db, taskId); this.repository.setArchived(taskId, false); });
    return this.getTask(userId, taskId);
  }

  async archiveTask(userId: string, taskId: string, confirmDiscardDirty = false): Promise<Task | { status: "confirmation_required"; dirtyFileCount: number; dirtyFilePaths: string[] }> {
    const task = this.getTask(userId, taskId);
    if (this.archives.has(taskId)) throw new TaskFailure("Archive cleanup is in progress", 409);
    if (!["backlog", "cancelled", "delivered"].includes(task.status)) throw new TaskFailure("Cancel the task before archiving it", 409);
    this.archives.add(taskId);
    try {
      const sessions = this.repository.controls.sessions(taskId);
      const closeDisplays = await stopIdleArchiveSessions(this.database.filename(), sessions);
      this.getTask(userId, taskId);
      const result = await removeTaskWorktree({ taskId, ...task.configuration }, task.worktree, confirmDiscardDirty, () => { this.getTask(userId, taskId); });
      if (result.status === "confirmation_required") return result;
      this.getTask(userId, taskId);
      await closeDisplays();
      this.getTask(userId, taskId);
      this.database.authTransaction(db => {
        db.prepare("UPDATE forge_task_controls SET worktree_json = NULL WHERE task_id = ?").run(taskId);
        this.repository.setArchived(taskId, true);
      });
      return this.getTask(userId, taskId);
    } catch (error) {
      if (error instanceof TaskFailure) throw error;
      throw new TaskFailure(error instanceof Error ? error.message : "Worktree cleanup failed", 409);
    } finally { this.archives.delete(taskId); }
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
      sessions: this.repository.controls.sessions(taskId).map(session => ({ id: session.id, kind: session.kind, advisorRole: session.advisorRole, label: roleLabel(session), profileId: this.sessionProfile(task, session).profileId, generation: session.generation, nativeSessionId: session.nativeSessionId, paneId: session.paneId, current: session.current })),
      turns: this.repository.controls.turns(taskId).map(turn => ({ id: turn.id, sessionId: turn.sessionId, prompt: turn.promptText, status: turn.status, result: turn.terminalObservation })),
    };
  }

  private sessionProfile(task: Task, session: { kind: "root" | "worker"; advisorRole: AdvisorRole | null }): TaskProfile {
    if (session.kind === "root") return task.rootProfile;
    return (session.advisorRole && task.advisorProfiles[session.advisorRole]) || (session.advisorRole ? task.rootProfile : task.workerProfile);
  }

  private profile(profileId: string, role: "root" | "worker"): TaskProfile {
    const value = this.database.authQuery(db => db.prepare("SELECT id AS profileId, provider, model, reasoning_level AS reasoningLevel, service_tier AS serviceTier FROM forge_profiles WHERE id = ? AND role = ? AND archived_at IS NULL").get(profileId, role));
    if (!value) throw new TaskFailure("The selected agent profile does not exist", 422);
    return TaskProfileSchema.parse(value);
  }

  private requireTask(authority: Authority, taskId: string): TaskRow {
    const row = this.repository.row(taskId);
    if (!row) throw new TaskFailure("Not found", 404);
    this.requireScope(authority, row.company_id, row.project_id);
    if (authority.kind === "hermes" && row.creator_agent_id !== authority.principal.agentId) throw new TaskFailure("Not found", 404);
    return row;
  }

  private requireScope(authority: Authority, companyId: string, projectId: string, active = false): void {
    if (authority.kind === "user") {
      const company = this.auth.requireCompanyAccess(authority.userId, companyId);
      if (active && company.status !== "active") throw new TaskFailure("The company is not active", 409);
      return;
    }
    const principal = authority.principal;
    if (principal.companyId !== companyId || !principal.projectIds.includes(projectId)) throw new TaskFailure("Not found", 404);
    const allowed = this.database.authQuery(db => db.prepare("SELECT c.status FROM forge_external_agents a JOIN forge_external_agent_project_grants g ON g.agent_id = a.id JOIN forge_companies c ON c.id = a.company_id WHERE a.id = ? AND a.company_id = ? AND a.status = 'paired' AND g.project_id = ?").get(principal.agentId, companyId, projectId));
    if (!allowed) throw new AuthFailure("Not found", 404);
    if (active && z.object({ status: z.string() }).parse(allowed).status !== "active") throw new TaskFailure("The company is not active", 409);
  }

  private audit(authority: Authority, companyId: string, action: string, taskId: string): void {
    if (authority.kind === "user") this.auth.recordAuditEvent(authority.userId, action, undefined, companyId, { taskId });
    else this.auth.recordAgentAuditEvent(authority.principal.agentId, action, undefined, companyId, { taskId });
  }
}

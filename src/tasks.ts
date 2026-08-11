import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

import type { AuthUser } from "./auth.js";
import { AuthFailure, AuthService } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import { ArtifactFailure, ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { LeadOutputSchema, type LeadOutput } from "./codex-lead.js";
import { ForgeDatabase } from "./database.js";
import { ProjectFailure, ProjectService, type ProjectRole } from "./projects.js";
import { acceptIssueDelivery, approveIssuePlan, cancelIssue, cancelIssueDevelopment, finalReviewIssue, publishIssueDraft, recordIssueDeliveryDecision, reconcileIssueCI, reconcileIssueMerge, rejectIssuePlan, repairIssueCI, repairIssueDelivery, requestIssueDeliveryChanges, requestIssueSupplementalReview, resolveIssueMergeConflict, retryIssueDevelopment, reviewIssueDelivery, startIssueDevelopment, startIssuePlanning, startIssueWorkflow } from "./temporal/service.js";
import type { IssueWorkflowInput, IssueWorkflowState, PlanCommandInput, StartPlanningInput } from "./temporal/issue-contracts.js";

export type TaskPhase = "backlog" | "planning" | "approval" | "ready_for_development" | "development" | "delivery_ready" | "reviewing_delivery" | "repair_required" | "delivery_reviewed" | "releasing" | "ci_waiting" | "ci_repair_required" | "final_review" | "accepted" | "manual_merge" | "done" | "delivery_blocked" | "cancelled" | "failed";

export interface TaskFinding {
  code: string;
  field: string;
  message: string;
}

export class TaskFailure extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly findings: TaskFinding[];

  constructor(publicMessage: string, findings: TaskFinding[] = [], statusCode = 400) {
    super(publicMessage);
    this.name = "TaskFailure";
    this.publicMessage = publicMessage;
    this.findings = findings;
    this.statusCode = statusCode;
  }
}

export interface TaskImageInput {
  filename: string;
  mimeType: string;
  base64: string;
}

export interface TaskInput {
  projectId: string;
  title: string;
  description: string;
  idempotencyKey: string;
  images: TaskImageInput[];
  roleProfiles?: Partial<Record<ProjectRole, string>>;
  supplementalReview?: boolean;
}

export interface TaskImage {
  artifactId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
}

export interface TaskTimelineEntry {
  id: string;
  revision: number;
  eventType: string;
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface ForgeTask {
  id: string;
  companyId: string;
  projectId: string;
  title: string;
  description: string;
  briefArtifactId: string;
  images: TaskImage[];
  roleProfiles: Partial<Record<ProjectRole, string>>;
  supplementalReview: boolean;
  workflowId: string;
  projectRevisionId: string;
  phase: TaskPhase;
  revision: number;
  owner: "human" | "lead";
  allowedCommands: string[];
  pendingAction: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: TaskTimelineEntry[];
  planRevision?: number | null;
  planMaterial?: boolean | null;
  materialCategories?: string[];
  supplementalReviewUsed?: boolean;
  supplementalReviewArtifactId?: string | null;
  decisionId?: string | null;
  deliveryDecisionArtifactId?: string | null;
  predecessorTaskId?: string | null;
  successorTaskId?: string | null;
  deliveryReview?: {
    id: string;
    outcome: "approved" | "blocking";
    summary: string;
    planRevision: number;
    baseSha: string;
    subjectCommit: string;
    subjectTree: string;
    leadExecutionId: string;
    sessionRef: string;
    opinionArtifactId: string;
    evidenceArtifactId: string;
    repairCycle: number;
    findings: Array<{ id: string; severity: "blocking" | "advisory"; rationale: string; evidenceRef: string; disposition: string; repairInstruction: string | null }>;
  };
  developerExecution?: {
    id: string;
    status: string;
    attempt: number;
    branchName: string;
    worktreePath: string;
    targetBaseSha: string;
    sessionRef?: string | null;
    currentStep?: number | null;
    resultCommit?: string | null;
    resultTree?: string | null;
    dirtyState?: string | null;
    deliveryArtifactId?: string | null;
    evidenceArtifactId?: string | null;
    failureCode?: string | null;
    failureSummary?: string | null;
  };
  leadOutput?: {
    kind: "plan" | "decision_blocker";
    summary: string;
    sessionRef: string;
    executionId: string;
    outputArtifactId: string;
    evidenceArtifactId: string;
    content: LeadOutput;
  };
}

export interface TaskEvent {
  type: "invalidate";
  taskId: string;
  companyId: string;
  revision: number;
}

export interface IssueWorkflowPort {
  start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string }>;
  startPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState>;
  requestSupplementalReview?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  approvePlan?: (workflowId: string, input: StartPlanningInput & { note?: string }) => Promise<IssueWorkflowState>;
  rejectPlan?: (workflowId: string, input: StartPlanningInput & { note?: string }) => Promise<IssueWorkflowState>;
  startDevelopment?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  retryDevelopment?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  cancelDevelopment?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  continueWork?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  reviewDelivery?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  repairDelivery?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  recordDeliveryDecision?: (workflowId: string, input: StartPlanningInput & { note?: string }) => Promise<IssueWorkflowState>;
  publishDraft?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  resolveMergeConflict?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  reconcileCI?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  repairCI?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  finalReview?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  acceptDelivery?: (workflowId: string, input: PlanCommandInput) => Promise<IssueWorkflowState>;
  requestDeliveryChanges?: (workflowId: string, input: PlanCommandInput) => Promise<IssueWorkflowState>;
  cancelIssue?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  reconcileMerge?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
}

interface TaskServiceOptions {
  artifactStore?: ArtifactStore;
  workflow?: IssueWorkflowPort;
  now?: () => Date;
}

interface TaskRow {
  id: string;
  company_id: string;
  project_id: string;
  title: string;
  brief_artifact_id: string;
  image_artifact_ids_json: string;
  role_profiles_json: string;
  supplemental_review: number;
  workflow_id: string;
  project_revision_id: string;
  created_at: string;
  updated_at: string;
  description: string;
  projection_revision: number;
  phase: TaskPhase;
  owner: "human" | "lead";
  allowed_commands_json: string;
  pending_action: string | null;
  predecessor_task_id: string | null;
  successor_task_id: string | null;
}

interface ArtifactRow {
  id: string;
  company_id: string;
  kind: "task-brief" | "task-image";
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  storage_path: string;
  created_at: string;
}

interface TimelineRow {
  id: string;
  revision: number;
  event_type: string;
  metadata_json: string;
  created_at: string;
}

interface LeadOutputRow {
  company_id: string;
  kind: "plan" | "decision_blocker";
  summary: string;
  session_ref: string;
  execution_id: string;
  output_artifact_id: string;
  evidence_artifact_id: string;
  storage_path: string;
  sha256: string;
}

const titlePattern = /^\S[\s\S]{0,159}$/;
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function json<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function finding(code: string, field: string, message: string): TaskFinding {
  return { code, field, message };
}

function parseImageIds(raw: string): string[] {
  return json<string[]>(raw, []).filter((value) => typeof value === "string");
}

function parseProfiles(raw: string): Partial<Record<ProjectRole, string>> {
  return json<Partial<Record<ProjectRole, string>>>(raw, {});
}

function parseMetadata(raw: string): Record<string, string | number | boolean> {
  return json<Record<string, string | number | boolean>>(raw, {});
}

export class TaskService {
  private readonly now: () => Date;
  private readonly artifacts: ArtifactStore;
  private readonly workflow: IssueWorkflowPort;
  private readonly events = new EventEmitter();

  constructor(
    private readonly database: ForgeDatabase,
    private readonly auth: AuthService,
    private readonly projects: ProjectService,
    private readonly config: ForgeConfig,
    options: TaskServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.artifacts = options.artifactStore ?? new ArtifactStore(config.artifactRoot);
    this.workflow = options.workflow ?? {
      start: (input) => startIssueWorkflow(config, input),
      startPlanning: (workflowId, input) => startIssuePlanning(config, workflowId, input),
      requestSupplementalReview: (workflowId, input) => requestIssueSupplementalReview(config, workflowId, input),
      approvePlan: (workflowId, input) => approveIssuePlan(config, workflowId, input),
      rejectPlan: (workflowId, input) => rejectIssuePlan(config, workflowId, input),
      startDevelopment: (workflowId, input) => startIssueDevelopment(config, workflowId, input),
      retryDevelopment: (workflowId, input) => retryIssueDevelopment(config, workflowId, input),
      cancelDevelopment: (workflowId, input) => cancelIssueDevelopment(config, workflowId, input),
      reviewDelivery: (workflowId, input) => reviewIssueDelivery(config, workflowId, input),
      repairDelivery: (workflowId, input) => repairIssueDelivery(config, workflowId, input),
      recordDeliveryDecision: (workflowId, input) => recordIssueDeliveryDecision(config, workflowId, input),
      publishDraft: (workflowId, input) => publishIssueDraft(config, workflowId, input),
      resolveMergeConflict: (workflowId, input) => resolveIssueMergeConflict(config, workflowId, input),
      reconcileCI: (workflowId, input) => reconcileIssueCI(config, workflowId, input),
      repairCI: (workflowId, input) => repairIssueCI(config, workflowId, input),
      finalReview: (workflowId, input) => finalReviewIssue(config, workflowId, input),
      acceptDelivery: (workflowId, input) => acceptIssueDelivery(config, workflowId, input),
      requestDeliveryChanges: (workflowId, input) => requestIssueDeliveryChanges(config, workflowId, input),
      cancelIssue: (workflowId, input) => cancelIssue(config, workflowId, input),
      reconcileMerge: (workflowId, input) => reconcileIssueMerge(config, workflowId, input),
    };
  }

  subscribe(actorUserId: string, listener: (event: TaskEvent) => void): () => void {
    const wrapped = (event: TaskEvent): void => {
      try {
        this.auth.requireCompanyAccess(actorUserId, event.companyId);
        listener(event);
      } catch {
        // Scope is checked again at delivery time; a revoked membership receives no event.
      }
    };
    this.events.on("task", wrapped);
    return () => this.events.off("task", wrapped);
  }

  listTasks(actorUserId: string, companyId?: string): ForgeTask[] {
    if (companyId) this.auth.requireCompanyAccess(actorUserId, companyId);
    const user = this.user(actorUserId);
    const rows = this.database.authQuery((db) => {
      const query = user.role === "admin"
        ? companyId ? db.prepare(this.taskQuery("t.company_id = ?")) : db.prepare(this.taskQuery("1 = 1"))
        : companyId ? db.prepare(this.taskQuery("m.user_id = ? AND t.company_id = ?")) : db.prepare(this.taskQuery("m.user_id = ?"));
      const result = companyId
        ? user.role === "admin" ? query.all(companyId) : query.all(actorUserId, companyId)
        : user.role === "admin" ? query.all() : query.all(actorUserId);
      return result as TaskRow[];
    });
    return rows.map((row) => this.publicTask(actorUserId, row));
  }

  getTask(actorUserId: string, taskId: string): ForgeTask {
    const user = this.user(actorUserId);
    const row = this.database.authQuery((db) => {
      const query = user.role === "admin"
        ? db.prepare(this.taskQuery("t.id = ?"))
        : db.prepare(this.taskQuery("t.id = ? AND m.user_id = ?"));
      return (user.role === "admin" ? query.get(taskId) : query.get(taskId, actorUserId)) as TaskRow | undefined;
    });
    if (!row) throw new TaskFailure("Not found", [], 404);
    return this.publicTask(actorUserId, row);
  }

  async createTask(actorUserId: string, companyId: string, input: TaskInput): Promise<{ task: ForgeTask; created: boolean }> {
    const company = this.auth.requireCompanyAccess(actorUserId, companyId);
    if (company.status !== "active") throw new TaskFailure("Task creation failed", [finding("company-inactive", "companyId", "Task creation requires an active company")], 409);
    const project = this.projects.getProject(actorUserId, input.projectId);
    if (project.companyId !== companyId) throw new TaskFailure("Not found", [], 404);
    if (project.status !== "active" || !project.activeRevisionId) throw new TaskFailure("Task creation failed", [finding("project-inactive", "projectId", "Tasks require an active project")], 409);
    const validation = this.validateTaskInput(input);
    if (validation.length) throw new TaskFailure("Task brief is invalid", validation, 422);

    const existingId = this.database.authQuery((db) => (db.prepare("SELECT id FROM forge_tasks WHERE company_id = ? AND idempotency_key = ?").get(companyId, input.idempotencyKey.trim()) as { id: string } | undefined)?.id);
    if (existingId) return { task: this.getTask(actorUserId, existingId), created: false };

    const roleProfiles = this.resolveRoleProfiles(project.roleDefaults, project.allowedProfileIds, input.roleProfiles ?? {});
    const imageArtifacts: StoredArtifact[] = [];
    let briefArtifact: StoredArtifact | undefined;
    try {
      briefArtifact = await this.artifacts.put(companyId, "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from(input.description, "utf8") });
      for (const image of input.images) {
        const bytes = this.decodeImage(image);
        imageArtifacts.push(await this.artifacts.put(companyId, "task-image", { filename: image.filename, mimeType: image.mimeType, bytes }));
      }
      const taskId = id("task");
      const workflowId = `${this.config.installationId ? `workflow-${this.config.installationId}` : "workflow"}-issue-${taskId}`;
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        db.prepare(`INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(briefArtifact!.id, companyId, briefArtifact!.kind, briefArtifact!.filename, briefArtifact!.mimeType, briefArtifact!.byteSize, briefArtifact!.sha256, briefArtifact!.storagePath, briefArtifact!.createdAt);
        for (const artifact of imageArtifacts) db.prepare(`INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
        db.prepare(`INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, companyId, input.projectId, input.title.trim(), briefArtifact!.id, JSON.stringify(imageArtifacts.map((artifact) => artifact.id)), JSON.stringify(roleProfiles), input.supplementalReview === true ? 1 : 0, workflowId, project.activeRevisionId, input.idempotencyKey.trim(), now, now);
        db.prepare(`INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES (?, ?, ?, ?, 0, 'backlog', 'human', ?, ?, ?, ?)`).run(taskId, companyId, input.projectId, workflowId, JSON.stringify(["start_planning"]), "Start planning", now, `${workflowId}:0`);
        db.prepare(`INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, 0, 'task_created', ?, ?)`).run(`${workflowId}:0`, taskId, companyId, workflowId, JSON.stringify({ revision: 0 }), now);
        db.prepare(`INSERT OR IGNORE INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, 0, ?, ?)`).run(taskId, companyId, workflowId, JSON.stringify({ taskId, companyId, projectId: input.projectId, workflowId, projectRevisionId: project.activeRevisionId, phase: "backlog", revision: 0, owner: "human", allowedCommands: ["start_planning"], pendingAction: "Start planning", lastEventId: `${workflowId}:0`, continuationCount: 0, lastSummaryHash: null }), now);
        this.auth.recordAuditEventInTransaction(db, actorUserId, "task_created", undefined, companyId, { taskId, projectId: input.projectId, workflowId });
      });
      try {
        await this.workflow.start({ companyId, projectId: input.projectId, issueId: taskId, projectRevisionId: project.activeRevisionId, briefArtifactId: briefArtifact.id, briefSha256: briefArtifact.sha256, imageArtifactIds: imageArtifacts.map((artifact) => artifact.id), roleProfiles, supplementalReview: input.supplementalReview === true, repairCycleLimit: this.config.deliveryRepairCycleLimit, workflowId });
      } catch {
        this.deleteTask(taskId, [briefArtifact, ...imageArtifacts]);
        throw new TaskFailure("Task workflow could not be started", [finding("workflow-unavailable", "workflow", "The durable issue workflow is unavailable")], 503);
      }
      const task = this.getTask(actorUserId, taskId);
      this.events.emit("task", { type: "invalidate", taskId, companyId, revision: task.revision });
      return { task, created: true };
    } catch (error) {
      if (error instanceof TaskFailure || error instanceof ArtifactFailure) {
        if (error instanceof ArtifactFailure) throw new TaskFailure("Task brief is invalid", [finding(error.code, "images", error.message)], 422);
        throw error;
      }
      if (error instanceof ProjectFailure || error instanceof AuthFailure) throw error;
      if (error instanceof Error && /UNIQUE constraint failed: forge_tasks/.test(error.message)) throw new TaskFailure("Task already exists", [], 409);
      throw new TaskFailure("Task creation failed", [], 400);
    }
  }

  async startPlanning(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before starting planning")], 409);
    if (!task.allowedCommands.includes("start_planning")) throw new TaskFailure("Planning cannot start from the current state", [finding("illegal-command", "phase", "Start planning is not available")], 409);
    let state: IssueWorkflowState;
    try {
      state = await this.workflow.startPlanning(task.workflowId, { expectedRevision, actorUserId });
    } catch (error) {
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Planning command could not be accepted";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409);
    }
    this.database.projectIssueState({ taskId: state.issueId, companyId: state.companyId, projectId: state.projectId, workflowId: state.workflowId, revision: state.revision, phase: state.phase, owner: state.owner, allowedCommands: state.allowedCommands, pendingAction: state.pendingAction, lastEventId: state.lastEventId, ...(state.planRevision !== undefined ? { planRevision: state.planRevision } : {}), ...(state.planMaterial !== undefined ? { planMaterial: state.planMaterial } : {}), ...(state.materialCategories !== undefined ? { materialCategories: state.materialCategories } : {}), ...(state.supplementalReviewUsed !== undefined ? { supplementalReviewUsed: state.supplementalReviewUsed } : {}), ...(state.supplementalReviewArtifactId !== undefined ? { supplementalReviewArtifactId: state.supplementalReviewArtifactId } : {}), ...(state.decisionId !== undefined ? { decisionId: state.decisionId } : {}) });
    const updated = this.getTask(actorUserId, taskId);
    this.events.emit("task", { type: "invalidate", taskId, companyId: updated.companyId, revision: updated.revision });
    return updated;
  }

  async requestSupplementalReview(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "request_supplemental_review", (workflowId, input) => this.workflow.requestSupplementalReview ? this.workflow.requestSupplementalReview(workflowId, input) : Promise.reject(new Error("Supplemental review workflow is unavailable")));
  }

  async startDevelopment(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "start_development", (workflowId, input) => this.workflow.startDevelopment ? this.workflow.startDevelopment(workflowId, input) : Promise.reject(new Error("Developer workflow is unavailable")));
  }

  async retryDevelopment(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "retry_development", (workflowId, input) => this.workflow.retryDevelopment ? this.workflow.retryDevelopment(workflowId, input) : Promise.reject(new Error("Developer retry workflow is unavailable")));
  }

  async cancelDevelopment(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "cancel_development", (workflowId, input) => this.workflow.cancelDevelopment ? this.workflow.cancelDevelopment(workflowId, input) : Promise.reject(new Error("Developer cancellation workflow is unavailable")));
  }

  async reviewDelivery(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "review_delivery", (workflowId, input) => this.workflow.reviewDelivery ? this.workflow.reviewDelivery(workflowId, input) : Promise.reject(new Error("Delivery review workflow is unavailable")));
  }

  async repairDelivery(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "repair_delivery", (workflowId, input) => this.workflow.repairDelivery ? this.workflow.repairDelivery(workflowId, input) : Promise.reject(new Error("Delivery repair workflow is unavailable")));
  }

  async recordDeliveryDecision(actorUserId: string, taskId: string, expectedRevision: number, note?: string): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409);
    if (!task.allowedCommands.includes("record_delivery_decision")) throw new TaskFailure("A delivery decision is not available", [finding("illegal-command", "phase", "A member decision is not available")], 409);
    let state: IssueWorkflowState;
    try {
      state = await (this.workflow.recordDeliveryDecision ? this.workflow.recordDeliveryDecision(task.workflowId, { expectedRevision, actorUserId, ...(note !== undefined ? { note } : {}) }) : Promise.reject(new Error("Delivery decision workflow is unavailable")));
    } catch (error) {
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Delivery decision could not be accepted";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409);
    }
    this.database.projectIssueState({ taskId: state.issueId, companyId: state.companyId, projectId: state.projectId, workflowId: state.workflowId, revision: state.revision, phase: state.phase, owner: state.owner, allowedCommands: state.allowedCommands, pendingAction: state.pendingAction, lastEventId: state.lastEventId });
    const updated = this.getTask(actorUserId, taskId);
    this.events.emit("task", { type: "invalidate", taskId, companyId: updated.companyId, revision: updated.revision });
    return updated;
  }

  async approvePlan(actorUserId: string, taskId: string, expectedRevision: number, note?: string): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "approve_plan", (workflowId, input) => this.workflow.approvePlan ? this.workflow.approvePlan(workflowId, { ...input, ...(note !== undefined ? { note } : {}) }) : Promise.reject(new Error("Plan approval workflow is unavailable")));
  }

  async rejectPlan(actorUserId: string, taskId: string, expectedRevision: number, note?: string): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "reject_plan", (workflowId, input) => this.workflow.rejectPlan ? this.workflow.rejectPlan(workflowId, { ...input, ...(note !== undefined ? { note } : {}) }) : Promise.reject(new Error("Plan revision workflow is unavailable")));
  }

  async publishDraft(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "publish_draft", (workflowId, input) => this.workflow.publishDraft ? this.workflow.publishDraft(workflowId, input) : Promise.reject(new Error("Draft publication workflow is unavailable")));
  }

  async resolveMergeConflict(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "resolve_merge_conflict", (workflowId, input) => this.workflow.resolveMergeConflict ? this.workflow.resolveMergeConflict(workflowId, input) : Promise.reject(new Error("Merge-conflict resolution workflow is unavailable")));
  }

  async reconcileCI(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "reconcile_ci", (workflowId, input) => this.workflow.reconcileCI ? this.workflow.reconcileCI(workflowId, input) : Promise.reject(new Error("CI reconciliation workflow is unavailable")));
  }

  async finalReview(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "final_review", (workflowId, input) => this.workflow.finalReview ? this.workflow.finalReview(workflowId, input) : Promise.reject(new Error("Final review workflow is unavailable")));
  }

  async repairCI(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "repair_ci", (workflowId, input) => this.workflow.repairCI ? this.workflow.repairCI(workflowId, input) : Promise.reject(new Error("CI repair workflow is unavailable")));
  }

  async acceptDelivery(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.memberCommand(actorUserId, taskId, expectedRevision, "accept_delivery", (workflowId, input) => this.workflow.acceptDelivery ? this.workflow.acceptDelivery(workflowId, input) : Promise.reject(new Error("Delivery acceptance workflow is unavailable")));
  }

  async requestDeliveryChanges(actorUserId: string, taskId: string, expectedRevision: number, note?: string): Promise<ForgeTask> {
    return this.memberCommand(actorUserId, taskId, expectedRevision, "request_delivery_changes", (workflowId, input) => this.workflow.requestDeliveryChanges ? this.workflow.requestDeliveryChanges(workflowId, { ...input, ...(note !== undefined ? { note } : {}) }) : Promise.reject(new Error("Delivery change workflow is unavailable")));
  }

  async cancelIssue(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "cancel_issue", (workflowId, input) => this.workflow.cancelIssue ? this.workflow.cancelIssue(workflowId, input) : Promise.reject(new Error("Issue cancellation workflow is unavailable")));
  }

  async reconcileMerge(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "reconcile_merge", (workflowId, input) => this.workflow.reconcileMerge ? this.workflow.reconcileMerge(workflowId, input) : Promise.reject(new Error("Merge reconciliation workflow is unavailable")));
  }

  async continueWork(actorUserId: string, taskId: string): Promise<{ original: ForgeTask; successor: ForgeTask }> {
    const original = this.getTask(actorUserId, taskId);
    if (!(["done", "cancelled", "failed"].includes(original.phase) && original.allowedCommands.includes("record_delivery_decision") === false)) throw new TaskFailure("Continue work is not available", [finding("terminal-state-required", "phase", "Continue work requires a terminal or cancelled issue")], 409);
    const result = await this.createTask(actorUserId, original.companyId, { projectId: original.projectId, title: `Continue: ${original.title}`.slice(0, 160), description: `${original.description}\n\nContinued from Forge issue ${original.id}.`, idempotencyKey: `continue_${original.id}_${original.revision}_${Date.now()}`, images: [], roleProfiles: original.roleProfiles, supplementalReview: original.supplementalReview });
    this.database.authTransaction((db) => {
      const updatedAt = this.now().toISOString();
      db.prepare("UPDATE forge_tasks SET predecessor_task_id = ?, updated_at = ? WHERE id = ? AND company_id = ?").run(original.id, updatedAt, result.task.id, original.companyId);
      db.prepare("UPDATE forge_tasks SET successor_task_id = ?, updated_at = ? WHERE id = ? AND company_id = ?").run(result.task.id, updatedAt, original.id, original.companyId);
      db.prepare("INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, 'successor_created', ?, ?)").run(`${original.workflowId}:successor:${result.task.id}`, original.id, original.companyId, original.workflowId, original.revision + 1, JSON.stringify({ successorTaskId: result.task.id }), updatedAt);
      db.prepare("INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, 'successor_linked', ?, ?)").run(`${result.task.workflowId}:predecessor:${original.id}`, result.task.id, original.companyId, result.task.workflowId, 1, JSON.stringify({ predecessorTaskId: original.id }), updatedAt);
    });
    return { original: this.getTask(actorUserId, original.id), successor: this.getTask(actorUserId, result.task.id) };
  }

  private async planCommand(actorUserId: string, taskId: string, expectedRevision: number, commandName: string, command: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409);
    if (!task.allowedCommands.includes(commandName)) throw new TaskFailure("Plan action is not available", [finding("illegal-command", "phase", "This plan action is not available")], 409);
    let state: IssueWorkflowState;
    try { state = await command(task.workflowId, { expectedRevision, actorUserId }); } catch (error) {
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Plan action could not be accepted";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409);
    }
    this.database.projectIssueState({ taskId: state.issueId, companyId: state.companyId, projectId: state.projectId, workflowId: state.workflowId, revision: state.revision, phase: state.phase, owner: state.owner, allowedCommands: state.allowedCommands, pendingAction: state.pendingAction, lastEventId: state.lastEventId, ...(state.planRevision !== undefined ? { planRevision: state.planRevision } : {}), ...(state.planMaterial !== undefined ? { planMaterial: state.planMaterial } : {}), ...(state.materialCategories !== undefined ? { materialCategories: state.materialCategories } : {}), ...(state.supplementalReviewUsed !== undefined ? { supplementalReviewUsed: state.supplementalReviewUsed } : {}), ...(state.supplementalReviewArtifactId !== undefined ? { supplementalReviewArtifactId: state.supplementalReviewArtifactId } : {}), ...(state.decisionId !== undefined ? { decisionId: state.decisionId } : {}) });
    const updated = this.getTask(actorUserId, taskId);
    this.events.emit("task", { type: "invalidate", taskId, companyId: updated.companyId, revision: updated.revision });
    return updated;
  }

  private async memberCommand(actorUserId: string, taskId: string, expectedRevision: number, commandName: string, command: (workflowId: string, input: PlanCommandInput) => Promise<IssueWorkflowState>): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409);
    if (!task.allowedCommands.includes(commandName)) throw new TaskFailure("Task action is not available", [finding("illegal-command", "phase", "This task action is not available")], 409);
    let state: IssueWorkflowState;
    try { state = await command(task.workflowId, { expectedRevision, actorUserId }); } catch (error) {
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Task action could not be accepted";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409);
    }
    this.database.projectIssueState({ taskId: state.issueId, companyId: state.companyId, projectId: state.projectId, workflowId: state.workflowId, revision: state.revision, phase: state.phase, owner: state.owner, allowedCommands: state.allowedCommands, pendingAction: state.pendingAction, lastEventId: state.lastEventId, state });
    const updated = this.getTask(actorUserId, taskId);
    this.events.emit("task", { type: "invalidate", taskId, companyId: updated.companyId, revision: updated.revision });
    return updated;
  }

  async getTaskImage(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: TaskImage; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const artifact = this.database.authQuery((db) => db.prepare("SELECT id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-image'").get(artifactId, task.companyId) as ArtifactRow | undefined);
    if (!artifact || !parseImageIds(JSON.stringify(task.images.map((image) => image.artifactId))).includes(artifactId)) throw new TaskFailure("Not found", [], 404);
    const bytes = await this.artifacts.read({ companyId: task.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 });
    return { artifact: { artifactId: artifact.id, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }, bytes };
  }

  private validateTaskInput(input: TaskInput): TaskFinding[] {
    const findings: TaskFinding[] = [];
    if (!titlePattern.test(input.title.trim())) findings.push(finding("invalid-title", "title", "Title must contain 1 to 160 characters"));
    if (!input.description.trim() || input.description.length > 200_000) findings.push(finding("invalid-description", "description", "Markdown description is required and must be at most 200,000 characters"));
    if (!idempotencyPattern.test(input.idempotencyKey.trim())) findings.push(finding("invalid-idempotency-key", "idempotencyKey", "Idempotency key must be 8 to 128 safe characters"));
    if (!Array.isArray(input.images) || input.images.length > 8) findings.push(finding("invalid-images", "images", "At most eight images may be attached"));
    for (const image of input.images) {
      if (!imageMimeTypes.has(image.mimeType)) findings.push(finding("invalid-image-type", "images", "Only PNG, JPEG, WebP, and GIF images are accepted"));
      if (!image.filename || image.filename.includes("/") || image.filename.includes("\\") || image.filename.includes("..")) findings.push(finding("invalid-image-filename", "images", "Image filenames cannot contain paths"));
      if (typeof image.base64 !== "string" || image.base64.length > 12_000_000) findings.push(finding("invalid-image-data", "images", "Image data is invalid or too large"));
    }
    return findings;
  }

  private resolveRoleProfiles(defaults: Partial<Record<ProjectRole, string>>, allowed: string[], overrides: Partial<Record<ProjectRole, string>>): Partial<Record<ProjectRole, string>> {
    const result: Partial<Record<ProjectRole, string>> = { ...defaults };
    for (const role of ["lead", "developer", "reviewer"] as const) {
      const selected = overrides[role];
      if (selected !== undefined) {
        if (!allowed.includes(selected)) throw new TaskFailure("Task brief is invalid", [finding("profile-ineligible", `roleProfiles.${role}`, "Selected role profile is not allowed by the project")], 422);
        result[role] = selected;
      }
    }
    return result;
  }

  private decodeImage(image: TaskImageInput): Buffer {
    try {
      const bytes = Buffer.from(image.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("size");
      return bytes;
    } catch {
      throw new ArtifactFailure("invalid-image-data", "Image data is invalid or too large");
    }
  }

  private publicTask(actorUserId: string, row: TaskRow): ForgeTask {
    const imageIds = parseImageIds(row.image_artifact_ids_json);
    const artifacts = this.database.authQuery((db) => {
      if (!imageIds.length) return [] as ArtifactRow[];
      const placeholders = imageIds.map(() => "?").join(",");
      return db.prepare(`SELECT id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at FROM forge_artifacts WHERE company_id = ? AND id IN (${placeholders})`).all(row.company_id, ...imageIds) as ArtifactRow[];
    });
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    const brief = this.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-brief'").get(row.brief_artifact_id, row.company_id) as Pick<ArtifactRow, "storage_path" | "sha256"> | undefined);
    if (!brief) throw new TaskFailure("Task artifact is unavailable", [], 500);
    const description = this.artifacts.readSync({ companyId: row.company_id, storagePath: brief.storage_path, sha256: brief.sha256 }).toString("utf8");
    void actorUserId;
    const timeline = this.database.authQuery((db) => db.prepare("SELECT id, revision, event_type, metadata_json, created_at FROM forge_issue_timeline WHERE task_id = ? ORDER BY revision, id").all(row.id) as TimelineRow[]).map((entry) => ({ id: entry.id, revision: entry.revision, eventType: entry.event_type, metadata: parseMetadata(entry.metadata_json), createdAt: entry.created_at }));
    const leadOutput = this.leadOutput(row.id, row.company_id);
    const developerExecution = this.database.authQuery((db) => db.prepare("SELECT id, status, attempt, branch_name, worktree_path, target_base_sha, session_ref, current_step, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id, failure_code, failure_summary FROM forge_developer_executions WHERE task_id = ? AND company_id = ? ORDER BY attempt DESC, started_at DESC LIMIT 1").get(row.id, row.company_id) as { id: string; status: string; attempt: number; branch_name: string; worktree_path: string; target_base_sha: string; session_ref: string | null; current_step: number | null; result_commit: string | null; result_tree: string | null; dirty_state: string | null; delivery_artifact_id: string | null; evidence_artifact_id: string | null; failure_code: string | null; failure_summary: string | null } | undefined);
    const governance = this.database.authQuery((db) => db.prepare("SELECT plan_revision, plan_material, material_categories_json, supplemental_review_used, supplemental_review_artifact_id, decision_id FROM forge_issue_governance WHERE task_id = ? AND company_id = ?").get(row.id, row.company_id) as { plan_revision: number | null; plan_material: number | null; material_categories_json: string | null; supplemental_review_used: number; supplemental_review_artifact_id: string | null; decision_id: string | null } | undefined);
    const review = this.database.authQuery((db) => db.prepare("SELECT id, outcome, summary, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, opinion_artifact_id, evidence_artifact_id, repair_cycle FROM forge_delivery_reviews WHERE task_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id, row.company_id) as { id: string; outcome: "approved" | "blocking"; summary: string; plan_revision: number; base_sha: string; subject_commit: string; subject_tree: string; lead_execution_id: string; session_ref: string; opinion_artifact_id: string; evidence_artifact_id: string; repair_cycle: number } | undefined);
    const findings = review ? this.database.authQuery((db) => db.prepare("SELECT id, severity, rationale, evidence_ref, disposition, repair_instruction FROM forge_delivery_findings WHERE review_id = ? AND task_id = ? AND company_id = ? ORDER BY id").all(review.id, row.id, row.company_id) as Array<{ id: string; severity: "blocking" | "advisory"; rationale: string; evidence_ref: string; disposition: string; repair_instruction: string | null }>) : [];
    const decision = this.database.authQuery((db) => db.prepare("SELECT artifact_id FROM forge_delivery_decisions WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id, row.company_id, row.workflow_id) as { artifact_id: string } | undefined);
    return { id: row.id, companyId: row.company_id, projectId: row.project_id, title: row.title, description, briefArtifactId: row.brief_artifact_id, images: imageIds.flatMap((artifactId) => { const artifact = artifactById.get(artifactId); return artifact ? [{ artifactId, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }] : []; }), roleProfiles: parseProfiles(row.role_profiles_json), supplementalReview: row.supplemental_review === 1, workflowId: row.workflow_id, projectRevisionId: row.project_revision_id, phase: row.phase, revision: row.projection_revision, owner: row.owner, allowedCommands: json<string[]>(row.allowed_commands_json, []), pendingAction: row.pending_action, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.predecessor_task_id ? { predecessorTaskId: row.predecessor_task_id } : {}), ...(row.successor_task_id ? { successorTaskId: row.successor_task_id } : {}), timeline, ...(governance ? { planRevision: governance.plan_revision, planMaterial: governance.plan_material === null ? null : governance.plan_material === 1, materialCategories: json<string[]>(governance.material_categories_json ?? "[]", []), supplementalReviewUsed: governance.supplemental_review_used === 1, ...(governance.supplemental_review_artifact_id ? { supplementalReviewArtifactId: governance.supplemental_review_artifact_id } : {}), ...(governance.decision_id ? { decisionId: governance.decision_id } : {}) } : {}), ...(decision ? { deliveryDecisionArtifactId: decision.artifact_id } : {}), ...(review ? { deliveryReview: { id: review.id, outcome: review.outcome, summary: review.summary, planRevision: review.plan_revision, baseSha: review.base_sha, subjectCommit: review.subject_commit, subjectTree: review.subject_tree, leadExecutionId: review.lead_execution_id, sessionRef: review.session_ref, opinionArtifactId: review.opinion_artifact_id, evidenceArtifactId: review.evidence_artifact_id, repairCycle: review.repair_cycle, findings: findings.map((finding) => ({ id: finding.id, severity: finding.severity, rationale: finding.rationale, evidenceRef: finding.evidence_ref, disposition: finding.disposition, repairInstruction: finding.repair_instruction })) } } : {}), ...(leadOutput ? { leadOutput } : {}), ...(developerExecution ? { developerExecution: { id: developerExecution.id, status: developerExecution.status, attempt: developerExecution.attempt, branchName: developerExecution.branch_name, worktreePath: developerExecution.worktree_path, targetBaseSha: developerExecution.target_base_sha, sessionRef: developerExecution.session_ref, currentStep: developerExecution.current_step, resultCommit: developerExecution.result_commit, resultTree: developerExecution.result_tree, dirtyState: developerExecution.dirty_state, deliveryArtifactId: developerExecution.delivery_artifact_id, evidenceArtifactId: developerExecution.evidence_artifact_id, failureCode: developerExecution.failure_code, failureSummary: developerExecution.failure_summary } } : {}) };
  }

  private leadOutput(taskId: string, companyId: string): ForgeTask["leadOutput"] {
    const row = this.database.authQuery((db) => db.prepare(`SELECT o.company_id, o.kind, o.summary, o.session_ref, o.execution_id, o.output_artifact_id, o.evidence_artifact_id, a.storage_path, a.sha256
      FROM forge_issue_outputs o JOIN forge_artifacts a ON a.id = o.output_artifact_id
      WHERE o.task_id = ? AND o.company_id = ? ORDER BY o.revision DESC LIMIT 1`).get(taskId, companyId) as LeadOutputRow | undefined);
    if (!row) return undefined;
    const content = LeadOutputSchema.parse(JSON.parse(this.artifacts.readSync({ companyId: row.company_id, storagePath: row.storage_path, sha256: row.sha256 }).toString("utf8")));
    return { kind: row.kind, summary: row.summary, sessionRef: row.session_ref, executionId: row.execution_id, outputArtifactId: row.output_artifact_id, evidenceArtifactId: row.evidence_artifact_id, content };
  }

  private taskQuery(scope: string): string {
    return `SELECT t.id, t.company_id, t.project_id, t.title, t.brief_artifact_id, t.image_artifact_ids_json, t.role_profiles_json, t.supplemental_review, t.workflow_id, t.project_revision_id, t.predecessor_task_id, t.successor_task_id, t.created_at, t.updated_at, ip.revision AS projection_revision, ip.phase, ip.owner, ip.allowed_commands_json, ip.pending_action, (SELECT a.filename FROM forge_artifacts a WHERE a.id = t.brief_artifact_id) AS description FROM forge_tasks t JOIN forge_issue_projections ip ON ip.task_id = t.id LEFT JOIN forge_memberships m ON m.company_id = t.company_id WHERE ${scope} ORDER BY t.created_at, t.id`;
  }

  private deleteTask(taskId: string, artifacts: Array<StoredArtifact | undefined>): void {
    this.database.authTransaction((db) => {
      db.prepare("DELETE FROM forge_tasks WHERE id = ?").run(taskId);
      db.prepare("DELETE FROM forge_artifacts WHERE id IN (SELECT id FROM forge_artifacts WHERE id = ?)").run(artifacts[0]?.id ?? "");
      for (const artifact of artifacts.slice(1)) if (artifact) db.prepare("DELETE FROM forge_artifacts WHERE id = ?").run(artifact.id);
    });
  }

  private user(userId: string): AuthUser {
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new AuthFailure("Authentication required", 401);
    return user;
  }
}

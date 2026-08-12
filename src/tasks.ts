import { createHash, randomBytes } from "node:crypto";

import type { AuthUser } from "./auth.js";
import { AuthFailure, AuthService } from "./auth.js";
import type { CheckConclusion, CheckStatus, CiOutcome, CiOwner } from "./ci.js";
import type { ForgeConfig } from "./config.js";
import { ArtifactFailure, ArtifactManifestEntrySchema, ArtifactStore, type ArtifactManifestEntry, type PlannedArtifact, type StoredArtifact } from "./artifacts.js";
import { LeadOutputSchema, type LeadOutput } from "./codex-lead.js";
import { CapacityManager } from "./capacity.js";
import type { PublicCapacityStatus } from "./capacity-contracts.js";
import { ForgeDatabase } from "./database.js";
import { canonicalJson } from "./canonical-json.js";
import { redact } from "./logging.js";
import { ProjectFailure, ProjectService, type ProjectRole } from "./projects.js";
import { ReleaseFailureCodeSchema, type ReleaseFailureCode } from "./release-failures.js";
import { acceptIssueDelivery, acceptIssuePlanning, approveIssuePlan, cancelIssue, cancelIssueDevelopment, continueIssueWork, finalReviewIssue, IssueWorkflowStartFailure, publishIssueDraft, recordIssueDeliveryDecision, reconcileIssueAcceptance, reconcileIssueCI, reconcileIssueMerge, rejectIssuePlan, repairIssueCI, repairIssueDelivery, requestIssueDeliveryChanges, requestIssueSupplementalReview, resolveIssueMergeConflict, reviseIssuePlan, retryIssueCapacity, retryIssueDevelopment, retryIssueForwardMergeVerification, retryIssueTargetBaseReconciliation, reviewIssueDelivery, startIssueDevelopment, startIssueWorkflow, verifyIssueDeveloperOwnership } from "./temporal/service.js";
import { IssueWorkflowStateSchema, type ContinueWorkCommand, type DeliveryOperationBlockCode, type DeliveryWorkflowBlockCode, type IssueWorkflowInput, type IssueWorkflowState, type PlanCommandInput, type PlanRevisionCommand, type StartPlanningInput } from "./temporal/issue-contracts.js";
import { WorktreeFailure, WorktreeManager } from "./worktrees.js";

export type TaskPhase = "backlog" | "planning" | "approval" | "ready_for_development" | "development" | "delivery_ready" | "reviewing_delivery" | "repair_required" | "delivery_reviewed" | "releasing" | "merge_conflict_reviewing" | "merge_conflict_required" | "merge_conflict_resolving" | "ci_waiting" | "ci_repair_planning" | "ci_repairing" | "ci_repair_required" | "final_review" | "accepted" | "ready_reconciliation" | "manual_merge" | "done" | "delivery_blocked" | "cancelled" | "failed";

export interface TaskFinding {
  code: string;
  field: string;
  message: string;
}

export class TaskFailure extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly findings: TaskFinding[];
  readonly current: ForgeTask | undefined;

  constructor(publicMessage: string, findings: TaskFinding[] = [], statusCode = 400, current?: ForgeTask) {
    super(publicMessage);
    this.name = "TaskFailure";
    this.publicMessage = publicMessage;
    this.findings = findings;
    this.statusCode = statusCode;
    this.current = current;
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

export interface TaskAgentInvocation {
  id: string;
  role: "lead" | "reviewer" | "developer";
  status: string;
  attempt: number;
  sessionPresent: boolean;
  startedAt: string;
  finishedAt: string | null;
  failureCode: string | null;
  failureSummary: string | null;
  evidenceArtifactId: string | null;
}

export interface ReviewFindingDto {
  id: string;
  severity: "blocking" | "advisory";
  rationale: string;
  evidenceRef: string;
  disposition: "open" | "accepted" | "repaired";
  repairInstruction: string | null;
}

export interface ReviewDto {
  id: string;
  outcome: "approved" | "blocking";
  summary: string;
  planRevision: number;
  baseSha: string;
  baseShaAbbrev: string;
  subjectCommit: string;
  subjectCommitAbbrev: string;
  subjectTree: string;
  subjectTreeAbbrev: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
  correctionAttempts: number | null;
  supersedesReviewId: string | null;
  successorReviewId: string | null;
  leadSessionContinued: boolean;
  developerSessionContinued: boolean;
  createdAt: string;
  findings: ReviewFindingDto[];
}

export interface ReviewAttemptDto {
  id: string;
  status: string;
  code: DeliveryOperationBlockCode | null;
  summary: string | null;
  correctionAttempts: number | null;
  planRevision: number;
  baseSha: string;
  baseShaAbbrev: string;
  subjectCommit: string;
  subjectCommitAbbrev: string;
  subjectTree: string;
  subjectTreeAbbrev: string;
  developerExecutionId: string | null;
  deliveryArtifactId: string | null;
  developerEvidenceArtifactId: string | null;
  evidenceArtifactId: string | null;
  completedReviewId: string | null;
  supersedesReviewId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RepairAttemptDto {
  id: string;
  reviewId: string;
  cycle: number;
  status: string;
  code: DeliveryOperationBlockCode | null;
  summary: string | null;
  priorCommit: string;
  priorCommitAbbrev: string;
  priorTree: string | null;
  priorTreeAbbrev: string | null;
  resultCommit: string | null;
  resultCommitAbbrev: string | null;
  resultTree: string | null;
  resultTreeAbbrev: string | null;
  deliveryArtifactId: string | null;
  evidenceArtifactId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ReviewLineage {
  currentReview: ReviewDto | null;
  priorReviews: ReviewDto[];
  reviewAttempts: ReviewAttemptDto[];
  repairAttempts: RepairAttemptDto[];
}

export interface TaskLinkSummary {
  id: string;
  title: string;
  phase: TaskPhase;
}

export interface TaskPlanHistoryEntry {
  revision: number;
  kind: "plan" | "decision_blocker";
  summary: string;
  executionId: string;
  outputArtifactId: string;
  evidenceArtifactId: string;
  createdAt: string;
}

export interface TaskPlanDecisionHistoryEntry {
  id: string;
  planRevision: number;
  decision: string;
  noteArtifactId: string;
  createdAt: string;
}

export interface TaskRevisionHistoryEntry {
  id: string;
  requestRevision: number;
  disposition: "reuse" | "new";
  status: "accepted" | "blocked" | "authorized";
  blockerCode: string | null;
  developerExecutionId: string | null;
  branchName: string | null;
  baseSha: string | null;
  headSha: string | null;
  treeSha: string | null;
  exactBaseSha: string | null;
  authorizedPlanRevision: number | null;
  reasonArtifactId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDeveloperExecutionHistoryEntry {
  id: string;
  planRevision: number;
  attempt: number;
  status: string;
  branchName: string;
  targetBaseSha: string;
  resultCommit: string | null;
  resultTree: string | null;
  dirtyState: string | null;
  deliveryArtifactId: string | null;
  evidenceArtifactId: string | null;
  failureCode: string | null;
  failureSummary: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TaskDeliveryReviewHistoryEntry {
  id: string;
  planRevision: number;
  outcome: "approved" | "blocking";
  summary: string;
  baseSha: string;
  subjectCommit: string;
  subjectTree: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
  repairCycle: number;
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
  agentInvocations: TaskAgentInvocation[];
  capacity: PublicCapacityStatus | null;
  planHistory: TaskPlanHistoryEntry[];
  planDecisionHistory: TaskPlanDecisionHistoryEntry[];
  revisionHistory: TaskRevisionHistoryEntry[];
  developerExecutionHistory: TaskDeveloperExecutionHistoryEntry[];
  deliveryReviewHistory: TaskDeliveryReviewHistoryEntry[];
  projection: { authoritativeRevision: number; projectedRevision: number; projectedAt: string; status: "current" | "lagging" };
  planRevision?: number | null;
  planMaterial?: boolean | null;
  materialCategories?: string[];
  supplementalReviewUsed?: boolean;
  supplementalReviewArtifactId?: string | null;
  decisionId?: string | null;
  deliveryDecisionArtifactId?: string | null;
  predecessorTaskId?: string | null;
  successorTaskId?: string | null;
  reviewLineage: ReviewLineage;
  deliveryReviewBlockerCode?: DeliveryWorkflowBlockCode | null;
  deliveryReviewBlockerSummary?: string | null;
  deliveryReviewBlockerEvidenceArtifactId?: string | null;
  deliveryRepairBlockerCode?: DeliveryWorkflowBlockCode | null;
  deliveryRepairBlockerSummary?: string | null;
  deliveryRepairBlockerEvidenceArtifactId?: string | null;
  predecessor?: TaskLinkSummary;
  successor?: TaskLinkSummary;
  ci?: TaskCiProjection;
  release?: TaskRelease | null;
  deliveryReview?: {
    id: string;
    outcome: "approved" | "blocking";
    summary: string;
    planRevision: number;
    baseSha: string;
    subjectCommit: string;
    subjectTree: string;
    leadExecutionId: string;
    opinionArtifactId: string;
    evidenceArtifactId: string;
    repairCycle: number;
    findings: Array<{ id: string; severity: "blocking" | "advisory"; rationale: string; evidenceRef: string; disposition: string; repairInstruction: string | null }>;
  };
  deliveryGate?: {
    release: { id: string; repository: string; pullRequestNumber: number; pullRequestUrl: string; baseBranch: string; baseSha: string; headSha: string; headTree: string; state: "draft" | "ready" | "merged" | "closed" };
    ci: { id: string; status: string; summary: string; updatedAt: string; checks: Array<{ name: string; status: string; conclusion: string | null; detailsUrl: string | null }> } | null;
    finalReview: { id: string; outcome: "approved" | "blocking"; summary: string; sessionRef: string; opinionArtifactId: string; evidenceArtifactId: string; findings: Array<{ id: string; severity: string; rationale: string; evidenceRef: string; disposition: string; repairInstruction: string | null }> } | null;
    acceptance: { id: string; decision: "accept" | "request_changes" | "cancel"; status: string; actorUserId: string; decidedAt: string; readyAt: string | null; reasonArtifactId: string | null; evidenceArtifactId: string | null } | null;
    merge: { outcome: string | null; observationId: string | null; observedAt: string | null; mergedAt: string | null; receiptId: string | null; receiptArtifactId: string | null; evidenceArtifactId: string | null };
    deployment: { status: "unknown"; summary: "Out of scope" };
  };
  developerExecution?: {
    id: string;
    status: string;
    attempt: number;
    branchName: string;
    targetBaseSha: string;
    currentStep?: number | null;
    resultCommit?: string | null;
    resultTree?: string | null;
    dirtyState?: string | null;
    deliveryArtifactId?: string | null;
    evidenceArtifactId?: string | null;
    failureCode?: string | null;
    failureSummary?: string | null;
  };
  developerRecovery?: {
    status: "starting" | "active" | "reconnecting" | "result_pending_claim" | "interrupted" | "ownership_ambiguous" | "cancellation_requested" | "cancelling" | "cancelled" | "failed";
    reasonCode: string | null;
    summary: string | null;
    lastHeartbeatAt: string | null;
    currentOwner: "forge" | "operator";
    evidenceArtifactId: string | null;
    nextAction: { command: "retry_development" | "cancel_development" | "verify_developer_ownership" | "cancel_issue"; label: string; requiresConfirmation: boolean } | null;
  };
  leadOutput?: {
    kind: "plan" | "decision_blocker";
    summary: string;
    executionId: string;
    outputArtifactId: string;
    evidenceArtifactId: string;
    content: LeadOutput;
  };
  targetBaseReconciliation: {
    checkId: string | null;
    checkpoint: "pre_release" | "pre_final_review" | "pre_acceptance" | null;
    status: "no_drift" | "revalidated" | "conflict" | "blocked" | null;
    expectedBaseSha: string | null;
    observedBaseSha: string | null;
    priorHead: string | null;
    priorTree: string | null;
    resultHead: string | null;
    resultTree: string | null;
    conflictFileCount: number | null;
    conflictArtifact: { id: string; sha256: string; kind: string } | null;
    verificationArtifact: { id: string; sha256: string; kind: string } | null;
    deliveryArtifact: { id: string; sha256: string; kind: string } | null;
    invalidatedDeliveryReviewId: string | null;
    invalidatedCiRunId: string | null;
    invalidatedFinalReviewId: string | null;
    invalidatedAcceptanceId: string | null;
    releaseId: string | null;
    pullRequestNumber: number | null;
    pullRequestUrl: string | null;
    blockerCode: string | null;
    blockerOwner: string | null;
    retryable: boolean | null;
    summary: string | null;
    actions: string[];
  };
}

export interface TaskCiProjection {
  runId: string;
  releaseId: string;
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  baseBranch: string;
  headBranch: string;
  expectedHeadSha: string;
  expectedHeadTree: string;
  status: string;
  outcome: CiOutcome | null;
  reason: string | null;
  owner: CiOwner;
  repairable: boolean;
  policyHash: string;
  policy: { projectRevisionId: string; requiredChecks: string[]; acceptedConclusions: ["success"] };
  leadSessionContinuity: boolean;
  developerSessionContinuity: boolean;
  firstObservedAt: string | null;
  propagationDeadline: string | null;
  overallDeadline: string | null;
  nextRetryAt: string | null;
  completedAt: string | null;
  supersededAt: string | null;
  supersededRuns: Array<{ runId: string; releaseId: string; expectedHeadSha: string; expectedHeadTree: string | null; status: string; supersededAt: string | null }>;
  attempts: Array<{
    id: string;
    attemptNumber: number;
    observedRepository: string | null;
    observedPrNumber: number | null;
    observedBaseBranch: string | null;
    observedBaseSha: string | null;
    observedHeadBranch: string | null;
    observedHeadSha: string | null;
    outcome: CiOutcome;
    reason: string;
    owner: CiOwner;
    repairable: boolean;
    retryAt: string | null;
    summary: string;
    evidenceArtifactId: string | null;
    createdAt: string;
    checks: Array<{ providerCheckId: string; name: string; headSha: string; status: CheckStatus; conclusion: CheckConclusion; detailsUrl: string | null; summary: string | null; startedAt: string | null; completedAt: string | null; selectedForEvaluation: boolean }>;
  }>;
  repairPlan: { id: string; status: string; ciRunId: string; ciAttemptId: string; failedHeadSha: string; planArtifactId: string; evidenceArtifactId: string; summary: string; steps: Array<{ number: number; instruction: string; verification: string }>; createdAt: string; updatedAt: string; consumedAt: string | null; supersededAt: string | null } | null;
  repairs: Array<{ id: string; repairPlanId: string; priorCommit: string; priorTree: string; newCommit: string | null; newTree: string | null; deliveryArtifactId: string | null; evidenceArtifactId: string | null; status: string; summary: string | null; createdAt: string; completedAt: string | null }>;
}

export interface TaskRelease {
  id: string;
  status: "reconciling" | "draft" | "blocked";
  failureCode: ReleaseFailureCode | null;
  failureSummary: string | null;
  retryAt: string | null;
  repository: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  headTree: string;
  reviewedCommit: { abbreviated: string; full: string };
  reviewedTree: { abbreviated: string; full: string };
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  isDraft: boolean;
  reused: boolean;
  bodyArtifactId: string | null;
  title: string;
  bodyPreview: string | null;
  operation: { kind: string; status: string; attempt: number | null; startedAt: string | null; observedAt: string | null; completedAt: string | null } | null;
}

export interface TaskEvent {
  type: "invalidate";
  taskId: string;
  companyId: string;
  revision: number;
  attentionChanged: boolean;
}

export interface TaskDeveloperDiff {
  patch: string;
  branchName: string;
  baseSha: string;
  headSha: string;
}

export interface IssueWorkflowPort {
  start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string; existing?: boolean }>;
  startPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState>;
  requestSupplementalReview?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  approvePlan?: (workflowId: string, input: StartPlanningInput & { note?: string }) => Promise<IssueWorkflowState>;
  rejectPlan?: (workflowId: string, input: StartPlanningInput & { note?: string }) => Promise<IssueWorkflowState>;
  revisePlan?: (workflowId: string, input: PlanRevisionCommand) => Promise<IssueWorkflowState>;
  startDevelopment?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  retryDevelopment?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  cancelDevelopment?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  continueWork?: (workflowId: string, input: ContinueWorkCommand) => Promise<IssueWorkflowState>;
  verifyDeveloperOwnership?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  reviewDelivery?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  repairDelivery?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  recordDeliveryDecision?: (workflowId: string, input: StartPlanningInput & { note?: string }) => Promise<IssueWorkflowState>;
  publishDraft?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  resolveMergeConflict?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  retryTargetBaseReconciliation?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  retryForwardMergeVerification?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  reconcileCI?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  repairCI?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  finalReview?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  acceptDelivery?: (workflowId: string, input: PlanCommandInput) => Promise<IssueWorkflowState>;
  requestDeliveryChanges?: (workflowId: string, input: PlanCommandInput) => Promise<IssueWorkflowState>;
  cancelIssue?: (workflowId: string, input: PlanCommandInput) => Promise<IssueWorkflowState>;
  reconcileAcceptance?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  reconcileMerge?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
  retryCapacity?: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>;
}

interface TaskServiceOptions {
  artifactStore?: ArtifactStore;
  workflow?: IssueWorkflowPort;
  now?: () => Date;
  fault?: (point: TaskCreationFaultPoint, ids: { intentId: string; taskId: string; artifactIndex?: number }) => void | Promise<void>;
  capacity?: CapacityManager;
}

export type TaskCreationFaultPoint = "after_intent_reserved" | "after_manifest_persisted" | "after_artifact_staged" | "after_artifact_finalized" | "after_task_committed" | "before_workflow_start" | "after_workflow_accepted" | "after_projection_applied" | "before_response";

class CreationLeaseLost extends Error {
  constructor() {
    super("Task creation lease was lost");
    this.name = "CreationLeaseLost";
  }
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
  authoritative_revision: number;
  projected_at: string;
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

interface CreationIntentRow {
  id: string;
  company_id: string;
  project_id: string;
  task_id: string;
  workflow_id: string;
  idempotency_key: string;
  request_hash: string;
  project_revision_id: string;
  artifact_ids_json: string;
  artifact_manifest_json: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  state: "staging" | "workflow_starting" | "started" | "failed_before_start";
  attempt: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentInvocationRow {
  id: string;
  role: "lead" | "reviewer" | "developer";
  status: string;
  attempt: number;
  session_ref: string | null;
  started_at: string;
  finished_at: string | null;
  failure_code: string | null;
  failure_summary: string | null;
  evidence_artifact_id: string | null;
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

function shaAbbrev(value: string | null): string | null {
  return value === null ? null : value.slice(0, 8);
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

function normalizeText(value: string): string {
  return value.trim().replace(/\r\n?/g, "\n");
}

export function creationRequestHash(input: {
  companyId: string;
  projectId: string;
  title: string;
  description: string;
  imageHashes: string[];
  roleProfiles: Partial<Record<ProjectRole, string>>;
  supplementalReview: boolean;
  projectRevisionId: string;
}): string {
  const roles = Object.fromEntries(Object.entries(input.roleProfiles).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(canonicalJson({
    companyId: normalizeText(input.companyId),
    projectId: normalizeText(input.projectId),
    title: normalizeText(input.title),
    description: normalizeText(input.description),
    imageHashes: input.imageHashes,
    roleProfiles: roles,
    supplementalReview: input.supplementalReview,
    projectRevisionId: normalizeText(input.projectRevisionId),
  })).digest("hex");
}

export class TaskService {
  private readonly now: () => Date;
  private readonly fault?: TaskServiceOptions["fault"];
  private readonly artifacts: ArtifactStore;
  private readonly workflow: IssueWorkflowPort;
  private readonly capacity: CapacityManager;
  private readonly eventListeners = new Set<{ afterCursor: number; send: (event: TaskEvent, cursor: number) => void }>();
  private eventCursor: number | undefined;
  private eventPoller: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: ForgeDatabase,
    private readonly auth: AuthService,
    private readonly projects: ProjectService,
    private readonly config: ForgeConfig,
    options: TaskServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fault = options.fault;
    this.artifacts = options.artifactStore ?? new ArtifactStore(config.artifactRoot);
    this.capacity = options.capacity ?? new CapacityManager(database, config);
    this.workflow = options.workflow ?? {
      start: (input) => startIssueWorkflow(config, input),
      startPlanning: (workflowId, input) => acceptIssuePlanning(config, workflowId, input),
      requestSupplementalReview: (workflowId, input) => requestIssueSupplementalReview(config, workflowId, input),
      approvePlan: (workflowId, input) => approveIssuePlan(config, workflowId, input),
      rejectPlan: (workflowId, input) => rejectIssuePlan(config, workflowId, input),
      revisePlan: (workflowId, input) => reviseIssuePlan(config, workflowId, input),
      startDevelopment: (workflowId, input) => startIssueDevelopment(config, workflowId, input),
      retryDevelopment: (workflowId, input) => retryIssueDevelopment(config, workflowId, input),
      cancelDevelopment: (workflowId, input) => cancelIssueDevelopment(config, workflowId, input),
      verifyDeveloperOwnership: (workflowId, input) => verifyIssueDeveloperOwnership(config, workflowId, input),
      reviewDelivery: (workflowId, input) => reviewIssueDelivery(config, workflowId, input),
      repairDelivery: (workflowId, input) => repairIssueDelivery(config, workflowId, input),
      recordDeliveryDecision: (workflowId, input) => recordIssueDeliveryDecision(config, workflowId, input),
      publishDraft: (workflowId, input) => publishIssueDraft(config, workflowId, input),
      resolveMergeConflict: (workflowId, input) => resolveIssueMergeConflict(config, workflowId, input),
      retryTargetBaseReconciliation: (workflowId, input) => retryIssueTargetBaseReconciliation(config, workflowId, input),
      retryForwardMergeVerification: (workflowId, input) => retryIssueForwardMergeVerification(config, workflowId, input),
      reconcileCI: (workflowId, input) => reconcileIssueCI(config, workflowId, input),
      repairCI: (workflowId, input) => repairIssueCI(config, workflowId, input),
      finalReview: (workflowId, input) => finalReviewIssue(config, workflowId, input),
      acceptDelivery: (workflowId, input) => acceptIssueDelivery(config, workflowId, input),
      requestDeliveryChanges: (workflowId, input) => requestIssueDeliveryChanges(config, workflowId, input),
      cancelIssue: (workflowId, input) => cancelIssue(config, workflowId, input),
      reconcileAcceptance: (workflowId, input) => reconcileIssueAcceptance(config, workflowId, input),
      reconcileMerge: (workflowId, input) => reconcileIssueMerge(config, workflowId, input),
      continueWork: (workflowId, input) => continueIssueWork(config, workflowId, input),
      retryCapacity: (workflowId, input) => retryIssueCapacity(config, workflowId, input),
    };
  }

  private async maybeFault(point: TaskCreationFaultPoint, ids: { intentId: string; taskId: string; artifactIndex?: number }): Promise<void> {
    await this.fault?.(point, ids);
  }

  taskEventCursor(): number {
    return this.database.authQuery((db) => (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS cursor FROM forge_projection_invalidations").get() as { cursor: number }).cursor);
  }

  subscribe(actorUserId: string, listener: (event: TaskEvent, cursor: number) => void, afterCursor = this.taskEventCursor()): () => void {
    const subscriber = { afterCursor, send: (event: TaskEvent, cursor: number): void => {
      try {
        this.auth.requireCompanyAccess(actorUserId, event.companyId);
        listener(event, cursor);
      } catch {
        // Scope is checked again at delivery time; a revoked membership receives no event.
      }
    } };
    if (this.eventListeners.size === 0) this.eventCursor = afterCursor;
    this.eventListeners.add(subscriber);
    if (!this.eventPoller) {
      // ponytail: one SQLite poller is enough for the single-host MVP; use database change notifications if write volume grows.
      this.eventPoller = setInterval(() => this.pollTaskEvents(), 100);
      this.eventPoller.unref();
    }
    return () => {
      this.eventListeners.delete(subscriber);
      if (this.eventListeners.size === 0 && this.eventPoller) {
        clearInterval(this.eventPoller);
        this.eventPoller = undefined;
        this.eventCursor = undefined;
      }
    };
  }

  private pollTaskEvents(): void {
    if (this.eventCursor === undefined || this.eventListeners.size === 0) return;
    try {
      let rows: Array<{ cursor: number; task_id: string; company_id: string; revision: number; attention_changed: number }>;
      do {
        rows = this.database.authQuery((db) => db.prepare("SELECT rowid AS cursor, task_id, company_id, revision, attention_changed FROM forge_projection_invalidations WHERE rowid > ? ORDER BY rowid LIMIT 100").all(this.eventCursor) as Array<{ cursor: number; task_id: string; company_id: string; revision: number; attention_changed: number }>);
        for (const row of rows) {
          this.eventCursor = row.cursor;
          const event: TaskEvent = { type: "invalidate", taskId: row.task_id, companyId: row.company_id, revision: row.revision, attentionChanged: row.attention_changed === 1 };
          for (const subscriber of this.eventListeners) {
            if (row.cursor > subscriber.afterCursor) subscriber.send(event, row.cursor);
          }
        }
      } while (rows.length === 100);
    } catch {
      // A transient SQLite lock is retried from the same cursor on the next tick.
    }
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

  async getDeveloperDiff(actorUserId: string, taskId: string): Promise<TaskDeveloperDiff> {
    const task = this.getTask(actorUserId, taskId);
    const execution = task.developerExecution;
    if (!execution || execution.status !== "completed") throw new TaskFailure("Developer diff is not available until development completes", [], 409);
    const worktree = this.database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ?").get(execution.id, task.id, task.companyId) as { worktreePath: string } | undefined);
    if (!worktree) throw new TaskFailure("Developer diff is unavailable", [], 409);
    const project = this.projects.getProject(actorUserId, task.projectId);
    if (project.companyId !== task.companyId) throw new TaskFailure("Not found", [], 404);
    try {
      const diff = await new WorktreeManager().currentDiff({
        repositoryPath: project.repositoryPath,
        worktreeRoot: project.worktreeRoot,
        taskId: task.id,
        targetBaseSha: execution.targetBaseSha,
        branchName: execution.branchName,
        worktreePath: worktree.worktreePath,
      });
      return { patch: diff.patch, branchName: execution.branchName, baseSha: execution.targetBaseSha, headSha: diff.headSha };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw new TaskFailure(error.message, [finding(error.code, "developerExecution", error.message)], 409);
      throw error;
    }
  }

  async createTask(actorUserId: string, companyId: string, input: TaskInput): Promise<{ task: ForgeTask; created: boolean }> {
    const company = this.auth.requireCompanyAccess(actorUserId, companyId);
    if (company.status !== "active") throw new TaskFailure("Task creation failed", [finding("company-inactive", "companyId", "Task creation requires an active company")], 409);
    const project = this.projects.getProject(actorUserId, input.projectId);
    if (project.companyId !== companyId) throw new TaskFailure("Not found", [], 404);
    if (project.status !== "active" || !project.activeRevisionId) {
      const needsReactivation = project.status === "needs-reactivation";
      throw new TaskFailure("Task creation failed", [finding(needsReactivation ? "project-needs-reactivation" : "project-inactive", "projectId", needsReactivation ? "Project must be reactivated before tasks can be created" : "Tasks require an active project")], 409);
    }
    const validation = this.validateTaskInput(input);
    if (validation.length) throw new TaskFailure("Task brief is invalid", validation, 422);

    const roleProfiles = this.resolveRoleProfiles(project.roleDefaults, project.allowedProfileIds, input.roleProfiles ?? {});
    let decodedImages: Array<{ image: TaskImageInput; bytes: Buffer }>;
    try {
      decodedImages = input.images.map((image) => ({ image, bytes: this.decodeImage(image) }));
    } catch (error) {
      if (error instanceof ArtifactFailure) throw new TaskFailure("Task brief is invalid", [finding(error.code, "images", error.message)], 422);
      throw error;
    }
    const requestHash = creationRequestHash({
      companyId,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      imageHashes: decodedImages.map(({ bytes }) => createHash("sha256").update(bytes).digest("hex")),
      roleProfiles,
      supplementalReview: input.supplementalReview === true,
      projectRevisionId: project.activeRevisionId,
    });
    const idempotencyKey = input.idempotencyKey.trim();
    let reserved = this.reserveCreationIntent({ companyId, projectId: input.projectId, idempotencyKey, requestHash, projectRevisionId: project.activeRevisionId });
    await this.maybeFault("after_intent_reserved", { intentId: reserved.intent.id, taskId: reserved.intent.task_id });
    if (!reserved.created) {
      if (reserved.intent.request_hash === "legacy-unknown") {
        throw new TaskFailure("This idempotency key belongs to a legacy task whose request identity is unavailable", [finding("legacy-idempotency-unknown", "idempotencyKey", "Use a new idempotency key to create a new task")], 409);
      }
      if (reserved.intent.request_hash !== requestHash) {
        throw new TaskFailure("This idempotency key was already used for a different task request", [finding("idempotency_conflict", "idempotencyKey", "Retry with the original request or use a new idempotency key")], 409);
      }
      if (reserved.intent.state !== "failed_before_start") return this.resumeCreationIntent(actorUserId, reserved.intent, input);
      const claimed = this.claimCreationIntent(reserved.intent.id, "failed_before_start");
      if (!claimed) return this.resumeCreationIntent(actorUserId, this.readCreationIntent({ id: reserved.intent.id }) ?? reserved.intent, input);
      await this.cleanupCreationArtifacts(claimed);
      reserved = { created: true, intent: claimed };
    }

    const imageArtifacts: StoredArtifact[] = [];
    let briefArtifact: StoredArtifact | undefined;
    const plannedArtifacts: PlannedArtifact[] = [];
    try {
      const taskId = reserved.intent.task_id;
      const workflowId = reserved.intent.workflow_id;
      this.updateCreationIntent(reserved.intent.id, { state: "staging", errorCode: null, attempt: reserved.intent.attempt + 1 }, reserved.intent.lease_token);
      const briefBytes = Buffer.from(normalizeText(input.description), "utf8");
      plannedArtifacts.push(this.artifacts.plan(companyId, reserved.intent.id, "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: briefBytes }));
      for (const { image, bytes } of decodedImages) plannedArtifacts.push(this.artifacts.plan(companyId, reserved.intent.id, "task-image", { filename: image.filename, mimeType: image.mimeType, bytes }));
      const manifest = plannedArtifacts.map(({ stagingPath: _stagingPath, ...entry }) => ArtifactManifestEntrySchema.parse(entry));
      this.updateCreationIntent(reserved.intent.id, { artifactManifest: manifest }, reserved.intent.lease_token);
      await this.maybeFault("after_manifest_persisted", { intentId: reserved.intent.id, taskId });
      for (const [artifactIndex, planned] of plannedArtifacts.entries()) {
        const bytes = artifactIndex === 0 ? briefBytes : decodedImages[artifactIndex - 1]!.bytes;
        const artifact = await this.artifacts.write(planned, bytes);
        await this.maybeFault("after_artifact_finalized", { intentId: reserved.intent.id, taskId, artifactIndex });
        if (artifactIndex === 0) briefArtifact = artifact;
        else imageArtifacts.push(artifact);
        this.updateCreationIntent(reserved.intent.id, { artifactIds: [briefArtifact, ...imageArtifacts].filter((entry): entry is StoredArtifact => Boolean(entry)).map((entry) => entry.id) }, reserved.intent.lease_token);
      }
      if (!briefArtifact) throw new ArtifactFailure("artifact-corrupt", "Task brief could not be stored");
      await this.maybeFault("after_artifact_staged", { intentId: reserved.intent.id, taskId });
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        db.prepare(`INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(briefArtifact!.id, companyId, briefArtifact!.kind, briefArtifact!.filename, briefArtifact!.mimeType, briefArtifact!.byteSize, briefArtifact!.sha256, briefArtifact!.storagePath, briefArtifact!.createdAt);
        for (const artifact of imageArtifacts) db.prepare(`INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
        db.prepare(`INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, companyId, input.projectId, input.title.trim(), briefArtifact!.id, JSON.stringify(imageArtifacts.map((artifact) => artifact.id)), JSON.stringify(roleProfiles), input.supplementalReview === true ? 1 : 0, workflowId, project.activeRevisionId, idempotencyKey, requestHash, now, now);
        const intentUpdate = db.prepare("UPDATE forge_task_creation_intents SET task_id = ?, state = 'workflow_starting', lease_expires_at = ?, updated_at = ?, error_code = NULL WHERE id = ? AND lease_token = ?").run(taskId, new Date(this.now().getTime() + 30_000).toISOString(), now, reserved.intent.id, reserved.intent.lease_token);
        if (intentUpdate.changes !== 1) throw new CreationLeaseLost();
        this.auth.recordAuditEventInTransaction(db, actorUserId, "task_created", undefined, companyId, { taskId, projectId: input.projectId, workflowId });
      });
      await this.maybeFault("after_task_committed", { intentId: reserved.intent.id, taskId });
      await this.startCreationWorkflow(reserved.intent.id, reserved.intent.lease_token, taskId, companyId, input.projectId, project.activeRevisionId, briefArtifact, imageArtifacts, roleProfiles, input.supplementalReview === true, requestHash, workflowId);
      const task = this.getTask(actorUserId, taskId);
      await this.maybeFault("before_response", { intentId: reserved.intent.id, taskId });
      return { task, created: true };
    } catch (error) {
      if (error instanceof CreationLeaseLost) {
        throw new TaskFailure("Task creation is already in progress", [finding("creation-lease-lost", "idempotencyKey", "Retry with the same idempotency key to observe the winning attempt")], 409);
      }
      const current = this.readCreationIntent({ id: reserved.intent.id }) ?? reserved.intent;
      if (current.lease_token !== reserved.intent.lease_token && current.state !== "started") {
        throw new TaskFailure("Task creation is already in progress", [finding("creation-lease-lost", "idempotencyKey", "Retry with the same idempotency key to observe the winning attempt")], 409);
      }
      const ambiguousStart = error instanceof TaskFailure && error.findings.some((item) => item.code === "workflow-start-ambiguous");
      const durableCreationState = current.state === "workflow_starting" || current.state === "started";
      if (!ambiguousStart && !durableCreationState && plannedArtifacts.length > 0) {
        await this.cleanupCreationArtifacts(current, [briefArtifact, ...imageArtifacts]);
        try { this.updateCreationIntent(reserved.intent.id, { state: "failed_before_start", errorCode: error instanceof ArtifactFailure ? error.code : "creation-failed" }, reserved.intent.lease_token); } catch (leaseError) { if (!(leaseError instanceof CreationLeaseLost)) throw leaseError; }
      }
      if (durableCreationState && !(error instanceof TaskFailure)) {
        throw new TaskFailure("Task creation is awaiting reconciliation", [finding("creation-reconciliation-required", "workflow", "Forge retained the durable task; retry with the same idempotency key")], 503);
      }
      if (error instanceof TaskFailure) throw error;
      if (error instanceof ArtifactFailure) {
        throw new TaskFailure("Task brief is invalid", [finding(error.code, "images", error.message)], 422);
      }
      if (error instanceof ProjectFailure || error instanceof AuthFailure) throw error;
      throw new TaskFailure("Task creation failed", [], 400);
    }
  }

  private reserveCreationIntent(input: { companyId: string; projectId: string; idempotencyKey: string; requestHash: string; projectRevisionId: string }): { created: boolean; intent: CreationIntentRow } {
    return this.database.authTransaction((db) => {
      const select = "SELECT id, company_id, project_id, task_id, workflow_id, idempotency_key, request_hash, project_revision_id, artifact_ids_json, artifact_manifest_json, lease_token, lease_expires_at, state, attempt, error_code, created_at, updated_at FROM forge_task_creation_intents";
      const now = this.now().toISOString();
      const leaseToken = id("lease");
      const leaseExpiresAt = new Date(this.now().getTime() + 30_000).toISOString();
      const taskId = id("task");
      const workflowId = `${this.config.installationId ? `workflow-${this.config.installationId}` : "workflow"}-issue-${taskId}`;
      const intentId = id("creation");
      const inserted = db.prepare(`INSERT INTO forge_task_creation_intents (id, company_id, project_id, task_id, workflow_id, idempotency_key, request_hash, project_revision_id, artifact_ids_json, artifact_manifest_json, lease_token, lease_expires_at, state, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, 'staging', 0, ?, ?) ON CONFLICT(company_id, idempotency_key) DO NOTHING`).run(intentId, input.companyId, input.projectId, taskId, workflowId, input.idempotencyKey, input.requestHash, input.projectRevisionId, leaseToken, leaseExpiresAt, now, now);
      const intent = db.prepare(`${select} WHERE company_id = ? AND idempotency_key = ?`).get(input.companyId, input.idempotencyKey) as CreationIntentRow;
      return { created: inserted.changes === 1, intent };
    });
  }

  private claimCreationIntent(intentId: string, priorState: "failed_before_start" | "staging", expectedLeaseToken?: string | null): CreationIntentRow | undefined {
    return this.database.authTransaction((db) => {
      const now = this.now();
      const token = id("lease");
      const expiry = new Date(now.getTime() + 30_000).toISOString();
      const result = priorState === "failed_before_start"
        ? db.prepare("UPDATE forge_task_creation_intents SET state = 'staging', lease_token = ?, lease_expires_at = ?, error_code = NULL, updated_at = ? WHERE id = ? AND state = 'failed_before_start'").run(token, expiry, now.toISOString(), intentId)
        : db.prepare("UPDATE forge_task_creation_intents SET lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'staging' AND lease_token = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").run(token, expiry, now.toISOString(), intentId, expectedLeaseToken ?? "", now.toISOString());
      if (result.changes !== 1) return undefined;
      const select = "SELECT id, company_id, project_id, task_id, workflow_id, idempotency_key, request_hash, project_revision_id, artifact_ids_json, artifact_manifest_json, lease_token, lease_expires_at, state, attempt, error_code, created_at, updated_at FROM forge_task_creation_intents WHERE id = ?";
      return db.prepare(select).get(intentId) as CreationIntentRow | undefined;
    });
  }

  private readCreationIntent(idOrCompany: { id: string } | { companyId: string; idempotencyKey: string }): CreationIntentRow | undefined {
    return this.database.authQuery((db) => {
      const select = "SELECT id, company_id, project_id, task_id, workflow_id, idempotency_key, request_hash, project_revision_id, artifact_ids_json, artifact_manifest_json, lease_token, lease_expires_at, state, attempt, error_code, created_at, updated_at FROM forge_task_creation_intents";
      if ("id" in idOrCompany) return db.prepare(`${select} WHERE id = ?`).get(idOrCompany.id) as CreationIntentRow | undefined;
      return db.prepare(`${select} WHERE company_id = ? AND idempotency_key = ?`).get(idOrCompany.companyId, idOrCompany.idempotencyKey) as CreationIntentRow | undefined;
    });
  }

  private updateCreationIntent(intentId: string, update: { state?: CreationIntentRow["state"]; artifactIds?: string[]; artifactManifest?: ArtifactManifestEntry[]; errorCode?: string | null; attempt?: number }, expectedLeaseToken?: string | null): void {
    this.database.authTransaction((db) => {
      const current = db.prepare("SELECT artifact_ids_json, artifact_manifest_json, lease_token, attempt, error_code FROM forge_task_creation_intents WHERE id = ?").get(intentId) as { artifact_ids_json: string; artifact_manifest_json: string; lease_token: string | null; attempt: number; error_code: string | null } | undefined;
      if (!current) return;
      const artifactIds = update.artifactIds ?? parseImageIds(current.artifact_ids_json);
      const manifest = update.artifactManifest ?? json<ArtifactManifestEntry[]>(current.artifact_manifest_json, []);
      const now = this.now();
      const state = update.state;
      const clearLease = state === "started" || state === "failed_before_start";
      const leaseToken = clearLease ? null : current.lease_token;
      const leaseExpiresAt = clearLease || !leaseToken ? null : new Date(now.getTime() + 30_000).toISOString();
      const errorCode = update.errorCode === undefined ? current.error_code : update.errorCode;
      const result = expectedLeaseToken === undefined
        ? db.prepare("UPDATE forge_task_creation_intents SET state = COALESCE(?, state), artifact_ids_json = ?, artifact_manifest_json = ?, lease_token = ?, lease_expires_at = ?, error_code = ?, attempt = COALESCE(?, attempt), updated_at = ? WHERE id = ?").run(state ?? null, JSON.stringify(artifactIds), JSON.stringify(manifest), leaseToken, leaseExpiresAt, errorCode, update.attempt ?? null, now.toISOString(), intentId)
        : db.prepare("UPDATE forge_task_creation_intents SET state = COALESCE(?, state), artifact_ids_json = ?, artifact_manifest_json = ?, lease_token = ?, lease_expires_at = ?, error_code = ?, attempt = COALESCE(?, attempt), updated_at = ? WHERE id = ? AND lease_token = ?").run(state ?? null, JSON.stringify(artifactIds), JSON.stringify(manifest), leaseToken, leaseExpiresAt, errorCode, update.attempt ?? null, now.toISOString(), intentId, expectedLeaseToken);
      if (expectedLeaseToken !== undefined && result.changes !== 1) throw new CreationLeaseLost();
    });
  }

  private async cleanupCreationArtifacts(intent: CreationIntentRow, artifacts: Array<StoredArtifact | undefined> = []): Promise<void> {
    const ids = [...new Set([...parseImageIds(intent.artifact_ids_json), ...artifacts.flatMap((artifact) => artifact ? [artifact.id] : [])])];
    const manifest = json<ArtifactManifestEntry[]>(intent.artifact_manifest_json, []).flatMap((entry) => {
      const parsed = ArtifactManifestEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    const rows = this.database.authQuery((db) => {
      if (!ids.length) return [] as Array<{ id: string; company_id: string; storage_path: string }>;
      const placeholders = ids.map(() => "?").join(",");
      return db.prepare(`SELECT id, company_id, storage_path FROM forge_artifacts WHERE company_id = ? AND id IN (${placeholders})`).all(intent.company_id, ...ids) as Array<{ id: string; company_id: string; storage_path: string }>;
    });
    this.database.authTransaction((db) => {
      for (const row of rows) db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(row.id, row.company_id);
    });
    const exactPaths = [...manifest.map((entry) => ({ storagePath: entry.storagePath, stagingPath: `${intent.company_id}/.staging/${intent.id}/${entry.id}.tmp` })), ...rows.map((row) => ({ storagePath: row.storage_path, stagingPath: `${intent.company_id}/.staging/${intent.id}/${row.id}.tmp` })), ...artifacts.filter((artifact): artifact is StoredArtifact => Boolean(artifact)).map((artifact) => ({ storagePath: artifact.storagePath, stagingPath: `${intent.company_id}/.staging/${intent.id}/${artifact.id}.tmp` }))];
    await Promise.all(exactPaths.map((path) => this.artifacts.removePlanned(path)));
  }

  private async resumeCreationIntent(actorUserId: string, intent: CreationIntentRow, input: TaskInput): Promise<{ task: ForgeTask; created: boolean }> {
    if (intent.state === "started") {
      const task = this.getTask(actorUserId, intent.task_id);
      return { task, created: false };
    }
    if (intent.state === "workflow_starting") {
      const task = this.database.authQuery((db) => db.prepare("SELECT t.id, t.company_id, t.project_id, t.project_revision_id, t.brief_artifact_id, t.image_artifact_ids_json, t.role_profiles_json, t.supplemental_review, t.workflow_id, b.sha256 AS brief_sha256 FROM forge_tasks t JOIN forge_artifacts b ON b.id = t.brief_artifact_id WHERE t.id = ? AND t.company_id = ?").get(intent.task_id, intent.company_id) as { id: string; company_id: string; project_id: string; project_revision_id: string; brief_artifact_id: string; image_artifact_ids_json: string; role_profiles_json: string; supplemental_review: number; workflow_id: string; brief_sha256: string } | undefined);
      if (task) {
        const imageIds = parseImageIds(task.image_artifact_ids_json);
        const images = this.database.authQuery((db) => {
          if (!imageIds.length) return [] as Array<{ id: string; sha256: string }>;
          const placeholders = imageIds.map(() => "?").join(",");
          return db.prepare(`SELECT id, sha256 FROM forge_artifacts WHERE company_id = ? AND id IN (${placeholders}) ORDER BY rowid`).all(intent.company_id, ...imageIds) as Array<{ id: string; sha256: string }>;
        });
        await this.startCreationWorkflow(intent.id, intent.lease_token, task.id, task.company_id, task.project_id, task.project_revision_id, { id: task.brief_artifact_id, sha256: task.brief_sha256 } as StoredArtifact, images.map((image) => ({ id: image.id, sha256: image.sha256 } as StoredArtifact)), JSON.parse(task.role_profiles_json) as Partial<Record<ProjectRole, string>>, task.supplemental_review === 1, intent.request_hash, task.workflow_id);
        const updated = this.getTask(actorUserId, task.id);
        return { task: updated, created: false };
      }
      this.updateCreationIntent(intent.id, { state: "failed_before_start", errorCode: "missing-task" });
      await this.cleanupCreationArtifacts(intent);
      return this.createTask(actorUserId, intent.company_id, input);
    }

    // A staging intent may be left behind by a process crash. Give an active
    // creator time to finish, then reclaim only the exact files it registered.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = this.readCreationIntent({ id: intent.id });
      if (!current || current.state !== "staging") return this.createTask(actorUserId, intent.company_id, input);
    }
    const claimed = this.claimCreationIntent(intent.id, "staging", intent.lease_token);
    if (!claimed) return this.resumeCreationIntent(actorUserId, this.readCreationIntent({ id: intent.id }) ?? intent, input);
    await this.cleanupCreationArtifacts(claimed);
    this.updateCreationIntent(intent.id, { state: "failed_before_start", errorCode: "staging-interrupted" }, claimed.lease_token);
    return this.createTask(actorUserId, intent.company_id, input);
  }

  private async startCreationWorkflow(intentId: string, leaseToken: string | null, taskId: string, companyId: string, projectId: string, projectRevisionId: string, briefArtifact: Pick<StoredArtifact, "id" | "sha256">, imageArtifacts: Array<Pick<StoredArtifact, "id" | "sha256">>, roleProfiles: Partial<Record<ProjectRole, string>>, supplementalReview: boolean, requestHash: string, workflowId: string): Promise<void> {
    let accepted = false;
    try {
      await this.maybeFault("before_workflow_start", { intentId, taskId });
      await this.workflow.start({ companyId, projectId, issueId: taskId, projectRevisionId, briefArtifactId: briefArtifact.id, briefSha256: briefArtifact.sha256, imageArtifactIds: imageArtifacts.map((artifact) => artifact.id), requestHash, roleProfiles, supplementalReview, repairCycleLimit: this.config.deliveryRepairCycleLimit, workflowId });
      accepted = true;
      await this.maybeFault("after_workflow_accepted", { intentId, taskId });
      await this.waitForProjection(taskId, 0);
      await this.maybeFault("after_projection_applied", { intentId, taskId });
    } catch (error) {
      if (accepted) throw new TaskFailure("Task workflow start is awaiting reconciliation", [finding("workflow-start-ambiguous", "workflow", "Forge retained the task and will reconcile the durable workflow on retry")], 503);
      if (error instanceof IssueWorkflowStartFailure && error.provenAbsent) {
        const intent = this.readCreationIntent({ id: intentId });
        if (intent) {
          await this.deleteTask(taskId, []);
          this.updateCreationIntent(intentId, { state: "failed_before_start", errorCode: error.code }, leaseToken);
        }
        throw new TaskFailure("Task workflow could not be started", [finding("workflow-unavailable", "workflow", "The durable issue workflow is unavailable")], 503);
      }
      throw new TaskFailure("Task workflow start is awaiting reconciliation", [finding("workflow-start-ambiguous", "workflow", "Forge retained the task and will reconcile the durable workflow on retry")], 503);
    }
    this.updateCreationIntent(intentId, { state: "started", errorCode: null }, leaseToken);
  }

  private async waitForProjection(taskId: string, minimumRevision: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const projection = this.database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = ?").get(taskId) as { revision: number } | undefined);
      if (projection && projection.revision >= minimumRevision) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Workflow projection did not become available");
  }

  async startPlanning(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before starting planning")], 409, task);
    if (!task.allowedCommands.includes("start_planning")) throw new TaskFailure("Planning cannot start from the current state", [finding("illegal-command", "phase", "Start planning is not available")], 409);
    try {
      await this.workflow.startPlanning(task.workflowId, { expectedRevision, actorUserId });
      await this.waitForProjection(taskId, expectedRevision + 1);
    } catch (error) {
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Planning command could not be accepted";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409, this.getTask(actorUserId, taskId));
    }
    const updated = this.getTask(actorUserId, taskId);
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

  async retryCapacity(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "retry_capacity", (workflowId, input) => this.workflow.retryCapacity ? this.workflow.retryCapacity(workflowId, input) : Promise.reject(new Error("Capacity retry workflow is unavailable")));
  }

  async cancelDevelopment(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "cancel_development", (workflowId, input) => this.workflow.cancelDevelopment ? this.workflow.cancelDevelopment(workflowId, input) : Promise.reject(new Error("Developer cancellation workflow is unavailable")));
  }

  async verifyDeveloperOwnership(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "verify_developer_ownership", (workflowId, input) => this.workflow.verifyDeveloperOwnership ? this.workflow.verifyDeveloperOwnership(workflowId, input) : Promise.reject(new Error("Developer ownership verification is unavailable")));
  }

  async reviewDelivery(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "review_delivery", (workflowId, input) => this.workflow.reviewDelivery ? this.workflow.reviewDelivery(workflowId, input) : Promise.reject(new Error("Delivery review workflow is unavailable")));
  }

  async repairDelivery(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "repair_delivery", (workflowId, input) => this.workflow.repairDelivery ? this.workflow.repairDelivery(workflowId, input) : Promise.reject(new Error("Delivery repair workflow is unavailable")));
  }

  async recordDeliveryDecision(actorUserId: string, taskId: string, expectedRevision: number, note?: string): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409, task);
    if (!task.allowedCommands.includes("record_delivery_decision")) throw new TaskFailure("A delivery decision is not available", [finding("illegal-command", "phase", "A member decision is not available")], 409);
    try {
      await (this.workflow.recordDeliveryDecision ? this.workflow.recordDeliveryDecision(task.workflowId, { expectedRevision, actorUserId, ...(note !== undefined ? { note } : {}) }) : Promise.reject(new Error("Delivery decision workflow is unavailable")));
    } catch (error) {
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Delivery decision could not be accepted";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409, this.getTask(actorUserId, taskId));
    }
    const updated = this.getTask(actorUserId, taskId);
    return updated;
  }

  async approvePlan(actorUserId: string, taskId: string, expectedRevision: number, note?: string): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "approve_plan", (workflowId, input) => this.workflow.approvePlan ? this.workflow.approvePlan(workflowId, { ...input, ...(note !== undefined ? { note } : {}) }) : Promise.reject(new Error("Plan approval workflow is unavailable")));
  }

  async rejectPlan(actorUserId: string, taskId: string, expectedRevision: number, note?: string): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    const authorization = task.phase === "delivery_ready" && task.allowedCommands.includes("review_delivery") ? "review_delivery" : "reject_plan";
    return this.planCommand(actorUserId, taskId, expectedRevision, authorization, (workflowId, input) => this.workflow.rejectPlan ? this.workflow.rejectPlan(workflowId, { ...input, ...(note !== undefined ? { note } : {}) }) : Promise.reject(new Error("Plan revision workflow is unavailable")));
  }

  async revisePlan(actorUserId: string, taskId: string, input: PlanRevisionCommand): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (input.actorUserId !== actorUserId) throw new TaskFailure("Plan revision is unavailable", [finding("actor-mismatch", "actorUserId", "Authenticated actor does not match the revision request")], 403, task);
    if (input.expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before revising the plan")], 409, task);
    if (!this.workflow.revisePlan) throw new TaskFailure("Plan revision workflow is unavailable", [finding("workflow-unavailable", "workflow", "The durable issue workflow is unavailable")], 503, task);
    try {
      const state = await this.workflow.revisePlan(task.workflowId, input);
      this.projectState(state);
      return this.getTask(actorUserId, taskId);
    } catch (error) {
      const stale = error instanceof Error && /stale workflow revision/i.test(error.message);
      throw new TaskFailure(stale ? "Task changed before this action was accepted" : "Plan revision could not be accepted", [finding(stale ? "stale-revision" : "workflow-update-rejected", "expectedRevision", stale ? "Refresh the issue before revising the plan" : "The durable plan revision was not accepted")], 409, this.getTask(actorUserId, taskId));
    }
  }

  async publishDraft(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "publish_draft", (workflowId, input) => this.workflow.publishDraft ? this.workflow.publishDraft(workflowId, input) : Promise.reject(new Error("Draft publication workflow is unavailable")));
  }

  async resolveMergeConflict(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "resolve_merge_conflict", (workflowId, input) => this.workflow.resolveMergeConflict ? this.workflow.resolveMergeConflict(workflowId, input) : Promise.reject(new Error("Merge-conflict resolution workflow is unavailable")));
  }

  async retryTargetBaseReconciliation(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "retry_target_base_reconciliation", (workflowId, input) => this.workflow.retryTargetBaseReconciliation ? this.workflow.retryTargetBaseReconciliation(workflowId, input) : Promise.reject(new Error("Target-base reconciliation workflow is unavailable")));
  }

  async retryForwardMergeVerification(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "retry_forward_merge_verification", (workflowId, input) => this.workflow.retryForwardMergeVerification ? this.workflow.retryForwardMergeVerification(workflowId, input) : Promise.reject(new Error("Forward-merge verification workflow is unavailable")));
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

  async cancelIssue(actorUserId: string, taskId: string, expectedRevision: number, note?: string): Promise<ForgeTask> {
    return this.memberCommand(actorUserId, taskId, expectedRevision, "cancel_issue", (workflowId, input) => this.workflow.cancelIssue ? this.workflow.cancelIssue(workflowId, { ...input, ...(note !== undefined ? { note } : {}) }) : Promise.reject(new Error("Issue cancellation workflow is unavailable")));
  }

  async reconcileAcceptance(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "reconcile_acceptance", (workflowId, input) => this.workflow.reconcileAcceptance ? this.workflow.reconcileAcceptance(workflowId, input) : Promise.reject(new Error("Acceptance reconciliation workflow is unavailable")));
  }

  async reconcileMerge(actorUserId: string, taskId: string, expectedRevision: number): Promise<ForgeTask> {
    return this.planCommand(actorUserId, taskId, expectedRevision, "reconcile_merge", (workflowId, input) => this.workflow.reconcileMerge ? this.workflow.reconcileMerge(workflowId, input) : Promise.reject(new Error("Merge reconciliation workflow is unavailable")));
  }

  async continueWork(actorUserId: string, taskId: string, expectedRevision: number, reason: string): Promise<{ original: ForgeTask; successor: ForgeTask }> {
    const original = this.getTask(actorUserId, taskId);
    const normalizedReason = (redact(reason.trim()) as string).trim();
    if (!normalizedReason || normalizedReason.length > 4_000) throw new TaskFailure("Continue work reason is required", [finding("invalid-reason", "reason", "Enter a reason from 1 to 4,000 characters")], 422, original);
    const reasonHash = createHash("sha256").update(normalizedReason).digest("hex");
    const continuationIntent = (): { state: string; actorUserId: string; successorTaskId: string; reasonHash: string } | undefined => this.database.authQuery((db) => db.prepare("SELECT i.state, i.actor_user_id AS actorUserId, i.successor_task_id AS successorTaskId, a.sha256 AS reasonHash FROM forge_successor_intents i JOIN forge_artifacts a ON a.id = i.reason_artifact_id AND a.company_id = i.company_id WHERE i.predecessor_task_id = ? AND i.accepted_revision = ?").get(taskId, expectedRevision) as { state: string; actorUserId: string; successorTaskId: string; reasonHash: string } | undefined);
    const isSameRequest = (intent: ReturnType<typeof continuationIntent>): intent is NonNullable<ReturnType<typeof continuationIntent>> => Boolean(intent && intent.actorUserId === actorUserId && intent.reasonHash === reasonHash);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== original.revision) {
      const intent = continuationIntent();
      if (isSameRequest(intent) && intent.state === "linked") return { original: this.getTask(actorUserId, taskId), successor: this.getTask(actorUserId, intent.successorTaskId) };
      if (isSameRequest(intent)) throw new TaskFailure("Continue work is awaiting reconciliation", [finding("successor-reconciliation", "workflow", "The successor is being reconciled; retry this request")], 503, original);
      throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before continuing work")], 409, original);
    }
    if (!this.workflow.continueWork) throw new TaskFailure("Continue work workflow is unavailable", [finding("workflow-unavailable", "workflow", "The durable issue workflow is unavailable")], 503, original);
    try {
      const state = await this.workflow.continueWork(original.workflowId, { expectedRevision, actorUserId, reason });
      this.projectState(state);
      const successorId = state.successorReference?.successorTaskId ?? state.successorTaskId;
      if (!successorId) throw new TaskFailure("Continue work is awaiting reconciliation", [finding("successor-reconciliation", "workflow", "The successor is being reconciled; retry this request")], 503, original);
      return { original: this.getTask(actorUserId, original.id), successor: this.getTask(actorUserId, successorId) };
    } catch (error) {
      if (error instanceof TaskFailure) throw error;
      const stale = error instanceof Error && /stale workflow revision/i.test(error.message);
      if (stale) {
        const intent = continuationIntent();
        if (isSameRequest(intent) && intent.state === "linked") return { original: this.getTask(actorUserId, taskId), successor: this.getTask(actorUserId, intent.successorTaskId) };
        if (isSameRequest(intent)) throw new TaskFailure("Continue work is awaiting reconciliation", [finding("successor-reconciliation", "workflow", "The successor is being reconciled; retry this request")], 503, original);
      }
      throw new TaskFailure(stale ? "Task changed before this action was accepted" : "Continue work could not be accepted", [finding(stale ? "stale-revision" : "workflow-update-rejected", "expectedRevision", stale ? "Refresh the issue before continuing work" : "The durable successor was not accepted")], 409, this.getTask(actorUserId, taskId));
    }
  }

  private async planCommand(actorUserId: string, taskId: string, expectedRevision: number, commandName: string, command: (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409, task);
    if (!task.allowedCommands.includes(commandName)) throw new TaskFailure("Plan action is not available", [finding("illegal-command", "phase", "This plan action is not available")], 409);
    try { await command(task.workflowId, { expectedRevision, actorUserId }); } catch (error) {
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Plan action could not be accepted";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409, this.getTask(actorUserId, taskId));
    }
    const updated = this.getTask(actorUserId, taskId);
    return updated;
  }

  private projectState(state: IssueWorkflowState): void {
    this.database.projectIssueEvent({ schemaVersion: 1, runId: state.workflowId, eventId: state.lastEventId, state });
  }

  private async memberCommand(actorUserId: string, taskId: string, expectedRevision: number, commandName: string, command: (workflowId: string, input: PlanCommandInput) => Promise<IssueWorkflowState>): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409, task);
    if (!task.allowedCommands.includes(commandName)) throw new TaskFailure("Task action is not available", [finding("illegal-command", "phase", "This task action is not available")], 409);
    try { await command(task.workflowId, { expectedRevision, actorUserId }); } catch (error) {
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Task action could not be accepted";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409, this.getTask(actorUserId, taskId));
    }
    const updated = this.getTask(actorUserId, taskId);
    return updated;
  }

  async getTaskImage(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: TaskImage; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const artifact = this.database.authQuery((db) => db.prepare("SELECT id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-image'").get(artifactId, task.companyId) as ArtifactRow | undefined);
    if (!artifact || !parseImageIds(JSON.stringify(task.images.map((image) => image.artifactId))).includes(artifactId)) throw new TaskFailure("Not found", [], 404);
    const bytes = await this.artifacts.read({ companyId: task.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 });
    return { artifact: { artifactId: artifact.id, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }, bytes };
  }

  async getTaskReviewArtifact(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: { artifactId: string; filename: string; mimeType: string; byteSize: number }; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const artifact = this.database.authQuery((db) => db.prepare(`
      SELECT a.id, a.company_id, a.filename, a.mime_type, a.byte_size, a.sha256, a.storage_path
      FROM forge_artifacts a
      WHERE a.id = ? AND a.company_id = ? AND a.kind IN ('delivery-review', 'agent-evidence', 'developer-repair', 'delivery-blocker')
        AND (
          EXISTS (SELECT 1 FROM forge_delivery_reviews r WHERE r.task_id = ? AND r.company_id = a.company_id AND (r.opinion_artifact_id = a.id OR r.evidence_artifact_id = a.id))
          OR EXISTS (SELECT 1 FROM forge_delivery_review_attempts ra WHERE ra.task_id = ? AND ra.company_id = a.company_id AND ra.evidence_artifact_id = a.id)
          OR EXISTS (SELECT 1 FROM forge_delivery_repairs dr WHERE dr.task_id = ? AND dr.company_id = a.company_id AND (dr.delivery_artifact_id = a.id OR dr.evidence_artifact_id = a.id))
          OR EXISTS (SELECT 1 FROM forge_workflow_snapshots ws WHERE ws.task_id = ? AND ws.company_id = a.company_id AND ws.workflow_id = ? AND (json_extract(ws.state_json, '$.deliveryReviewBlockerEvidenceArtifactId') = a.id OR json_extract(ws.state_json, '$.deliveryRepairBlockerEvidenceArtifactId') = a.id))
        )
    `).get(artifactId, task.companyId, task.id, task.id, task.id, task.id, task.workflowId) as { id: string; company_id: string; filename: string; mime_type: string; byte_size: number; sha256: string; storage_path: string } | undefined);
    if (!artifact) throw new TaskFailure("Not found", [], 404);
    const bytes = await this.artifacts.read({ companyId: artifact.company_id, storagePath: artifact.storage_path, sha256: artifact.sha256 });
    return { artifact: { artifactId: artifact.id, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }, bytes };
  }

  async getTaskArtifact(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: { artifactId: string; kind: string; filename: string; mimeType: string; byteSize: number }; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const snapshot = this.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = (SELECT revision FROM forge_issue_projections WHERE task_id = ?)").get(taskId, taskId) as { state_json: string } | undefined);
    const state = snapshot ? IssueWorkflowStateSchema.safeParse(json<unknown>(snapshot.state_json, {})).data : undefined;
    const artifactIds = new Set<string>();
    const linked = this.database.authQuery((db) => db.prepare(`SELECT a.reason_artifact_id AS artifactId FROM forge_acceptances a WHERE a.id = ? AND a.task_id = ? AND a.company_id = ? UNION ALL SELECT aa.evidence_artifact_id AS artifactId FROM forge_acceptance_attempts aa JOIN forge_acceptances a ON a.id = aa.acceptance_id WHERE a.id = ? AND a.task_id = ? AND a.company_id = ? UNION ALL SELECT cr.receipt_artifact_id AS artifactId FROM forge_completion_receipts cr WHERE cr.id = ? AND cr.task_id = ? AND cr.company_id = ? UNION ALL SELECT fr.opinion_artifact_id AS artifactId FROM forge_final_reviews fr WHERE fr.id = ? AND fr.task_id = ? AND fr.company_id = ? UNION ALL SELECT fr.evidence_artifact_id AS artifactId FROM forge_final_reviews fr WHERE fr.id = ? AND fr.task_id = ? AND fr.company_id = ? UNION ALL SELECT c.evidence_artifact_id AS artifactId FROM forge_ci_runs c WHERE c.id = ? AND c.task_id = ? AND c.company_id = ? UNION ALL SELECT mo.evidence_artifact_id AS artifactId FROM forge_merge_observations mo WHERE mo.id = ? AND mo.task_id = ? AND mo.company_id = ?`).all(state?.acceptanceId ?? "", taskId, task.companyId, state?.acceptanceId ?? "", taskId, task.companyId, state?.completionReceiptId ?? "", taskId, task.companyId, state?.finalReviewId ?? "", taskId, task.companyId, state?.finalReviewId ?? "", taskId, task.companyId, state?.ciRunId ?? "", taskId, task.companyId, state?.mergeObservationId ?? "", taskId, task.companyId) as Array<{ artifactId: string | null }>);
    for (const artifact of linked) if (artifact.artifactId) artifactIds.add(artifact.artifactId);
    for (const artifactId of [state?.deliveryRepairPlanArtifactId, state?.finalReviewRepairPlanArtifactId, state?.ciRepairPlanArtifactId, state?.ciRepairPlanEvidenceArtifactId]) if (artifactId) artifactIds.add(artifactId);
    const gateArtifact = artifactIds.has(artifactId) ? this.database.authQuery((db) => db.prepare("SELECT id, kind, filename, mime_type, byte_size, sha256, storage_path FROM forge_artifacts WHERE company_id = ? AND id = ?").get(task.companyId, artifactId) as { id: string; kind: string; filename: string; mime_type: string; byte_size: number; storage_path: string; sha256: string } | undefined) : undefined;
    const artifact = gateArtifact ?? this.database.authQuery((db) => db.prepare(`SELECT a.id, a.kind, a.filename, a.mime_type, a.byte_size, a.storage_path, a.sha256
      FROM forge_artifacts a
      WHERE a.id = ? AND a.company_id = ? AND (
        EXISTS (SELECT 1 FROM forge_issue_outputs o WHERE (o.output_artifact_id = a.id OR o.evidence_artifact_id = a.id) AND o.task_id = ? AND o.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_agent_executions e WHERE e.evidence_artifact_id = a.id AND e.task_id = ? AND e.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_plan_reviews r WHERE (r.opinion_artifact_id = a.id OR r.evidence_artifact_id = a.id) AND r.task_id = ? AND r.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_plan_decisions d WHERE d.note_artifact_id = a.id AND d.task_id = ? AND d.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_plan_revision_requests rr WHERE rr.reason_artifact_id = a.id AND rr.task_id = ? AND rr.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_developer_executions de WHERE (de.delivery_artifact_id = a.id OR de.evidence_artifact_id = a.id) AND de.task_id = ? AND de.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_delivery_reviews dr WHERE (dr.opinion_artifact_id = a.id OR dr.evidence_artifact_id = a.id) AND dr.task_id = ? AND dr.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_delivery_decisions dd WHERE dd.artifact_id = a.id AND dd.task_id = ? AND dd.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_successor_intents si WHERE si.reason_artifact_id = a.id AND si.predecessor_task_id = ? AND si.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_issue_governance g WHERE g.supplemental_review_artifact_id = a.id AND g.task_id = ? AND g.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_ci_attempts ca JOIN forge_ci_runs cr ON cr.id = ca.run_id WHERE ca.evidence_artifact_id = a.id AND cr.task_id = ? AND cr.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_ci_repair_plans cp WHERE (cp.plan_artifact_id = a.id OR cp.evidence_artifact_id = a.id) AND cp.task_id = ? AND cp.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_ci_repairs cx JOIN forge_ci_repair_plans cp ON cp.id = cx.repair_plan_id WHERE (cx.delivery_artifact_id = a.id OR cx.evidence_artifact_id = a.id) AND cp.task_id = ? AND cp.company_id = ?)
      )`).get(artifactId, task.companyId, ...Array.from({ length: 13 }, () => [task.id, task.companyId]).flat()) as { id: string; kind: string; filename: string; mime_type: string; byte_size: number; storage_path: string; sha256: string } | undefined);
    if (!artifact) throw new TaskFailure("Not found", [], 404);
    const bytes = await this.artifacts.read({ companyId: task.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 });
    return { artifact: { artifactId: artifact.id, kind: artifact.kind, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }, bytes };
  }

  async getTargetBaseArtifact(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: { artifactId: string; filename: string; mimeType: string; byteSize: number }; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const allowed = this.database.authQuery((db) => db.prepare(`SELECT a.id, a.company_id, a.filename, a.mime_type, a.byte_size, a.storage_path, a.sha256
      FROM forge_artifacts a JOIN forge_forward_merges m ON m.company_id = a.company_id AND (m.conflict_artifact_id = a.id OR m.verification_artifact_id = a.id OR m.delivery_artifact_id = a.id)
      WHERE m.task_id = ? AND m.company_id = ? AND a.id = ? AND a.kind IN ('forward-merge-conflict', 'forward-merge-verification', 'forward-merge-delivery')`).get(task.id, task.companyId, artifactId) as ArtifactRow | undefined);
    if (!allowed) throw new TaskFailure("Not found", [], 404);
    try {
      const bytes = await this.artifacts.read({ companyId: allowed.company_id, storagePath: allowed.storage_path, sha256: allowed.sha256 });
      return { artifact: { artifactId: allowed.id, filename: allowed.filename, mimeType: allowed.mime_type, byteSize: allowed.byte_size }, bytes };
    } catch (error) {
      if (error instanceof ArtifactFailure) throw new TaskFailure("Not found", [], 404);
      throw error;
    }
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
      const dataUri = /^data:([^;,]+);base64,(.+)$/.exec(image.base64);
      const encoded = dataUri ? dataUri[2]! : image.base64;
      if (dataUri && dataUri[1] !== image.mimeType) throw new Error("mime");
      if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("base64");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new Error("base64");
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("size");
      const magic = image.mimeType === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : image.mimeType === "image/jpeg"
          ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          : image.mimeType === "image/webp"
            ? bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
            : bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
      if (!magic) throw new Error("magic");
      return bytes;
    } catch {
      throw new ArtifactFailure("invalid-image-data", "Image data is invalid or too large");
    }
  }

  private workflowStateForTask(row: TaskRow): IssueWorkflowState {
    const snapshot = this.database.authQuery((db) => db.prepare("SELECT company_id, workflow_id, revision, state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = (SELECT revision FROM forge_issue_projections WHERE task_id = ?)").get(row.id, row.id) as { company_id: string; workflow_id: string; revision: number; state_json: string } | undefined);
    if (!snapshot) throw new TaskFailure("Task projection is unavailable", [finding("projection-integrity", "revision", "The authoritative workflow snapshot is unavailable")], 500);
    let raw: unknown;
    try { raw = JSON.parse(snapshot.state_json); } catch { throw new TaskFailure("Task projection is unavailable", [finding("projection-integrity", "revision", "The authoritative workflow snapshot is invalid")], 500); }
    const record = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const parsed = IssueWorkflowStateSchema.safeParse({
      ...record,
      issueId: record.issueId ?? record.taskId ?? row.id,
      companyId: record.companyId ?? row.company_id,
      projectId: record.projectId ?? row.project_id,
      workflowId: record.workflowId ?? row.workflow_id,
      projectRevisionId: record.projectRevisionId ?? row.project_revision_id,
      owner: record.owner === "system" ? "human" : record.owner,
      continuationCount: record.continuationCount ?? 0,
      lastSummaryHash: record.lastSummaryHash ?? null,
    });
    if (!parsed.success || snapshot.company_id !== row.company_id || snapshot.workflow_id !== row.workflow_id || snapshot.revision !== row.projection_revision || parsed.data?.issueId !== row.id || parsed.data?.companyId !== row.company_id || parsed.data?.workflowId !== row.workflow_id || parsed.data?.revision !== row.projection_revision) {
      throw new TaskFailure("Task projection is unavailable", [finding("projection-integrity", "revision", "The authoritative workflow snapshot does not match the projection")], 500);
    }
    return parsed.data;
  }

  private reviewLineage(row: TaskRow, workflowState: IssueWorkflowState): ReviewLineage {
    const reviewRows = this.database.authQuery((db) => db.prepare(`SELECT id, outcome, summary, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, opinion_artifact_id, evidence_artifact_id, supersedes_review_id, created_at FROM forge_delivery_reviews WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`).all(row.id, row.company_id, row.workflow_id) as Array<{ id: string; outcome: "approved" | "blocking"; summary: string; plan_revision: number; base_sha: string; subject_commit: string; subject_tree: string; lead_execution_id: string; session_ref: string; opinion_artifact_id: string; evidence_artifact_id: string; supersedes_review_id: string | null; created_at: string }>);
    const attemptRows = this.database.authQuery((db) => db.prepare(`SELECT id, status, failure_code, failure_summary, correction_attempts, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_session_ref, developer_session_ref, evidence_artifact_id, completed_review_id, supersedes_review_id, created_at, finished_at FROM forge_delivery_review_attempts WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`).all(row.id, row.company_id, row.workflow_id) as Array<{ id: string; status: string; failure_code: string | null; failure_summary: string | null; correction_attempts: number | null; plan_revision: number; base_sha: string; subject_commit: string; subject_tree: string; developer_execution_id: string | null; delivery_artifact_id: string | null; developer_evidence_artifact_id: string | null; lead_session_ref: string; developer_session_ref: string | null; evidence_artifact_id: string | null; completed_review_id: string | null; supersedes_review_id: string | null; created_at: string; finished_at: string | null }>);
    const repairRows = this.database.authQuery((db) => db.prepare(`SELECT id, review_id, cycle, status, subject_commit, subject_tree, result_commit, result_tree, delivery_artifact_id, evidence_artifact_id, failure_code, failure_summary, created_at, finished_at FROM forge_delivery_repairs WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY cycle, created_at, id LIMIT ?`).all(row.id, row.company_id, row.workflow_id, Math.max(1, this.config.deliveryRepairCycleLimit + 20)) as Array<{ id: string; review_id: string; cycle: number; status: string; subject_commit: string; subject_tree: string | null; result_commit: string | null; result_tree: string | null; delivery_artifact_id: string | null; evidence_artifact_id: string | null; failure_code: string | null; failure_summary: string | null; created_at: string; finished_at: string | null }>);
    const findingsByReview = new Map<string, ReviewFindingDto[]>();
    for (const review of reviewRows) {
      const findings = this.database.authQuery((db) => db.prepare("SELECT id, severity, rationale, evidence_ref AS evidenceRef, disposition, repair_instruction AS repairInstruction FROM forge_delivery_findings WHERE review_id = ? AND task_id = ? AND company_id = ? ORDER BY id").all(review.id, row.id, row.company_id) as ReviewFindingDto[]);
      findingsByReview.set(review.id, findings);
    }
    const successorByReview = new Map<string, string>();
    for (const review of reviewRows) if (review.supersedes_review_id) successorByReview.set(review.supersedes_review_id, review.id);
    const attemptByReview = new Map(attemptRows.filter((attempt) => attempt.completed_review_id).map((attempt) => [attempt.completed_review_id!, attempt]));
    const leadSession = this.database.authQuery((db) => db.prepare("SELECT session_ref FROM forge_issue_outputs WHERE task_id = ? AND company_id = ? ORDER BY revision DESC, created_at DESC LIMIT 1").get(row.id, row.company_id) as { session_ref: string } | undefined)?.session_ref;
    const reviewDtos = reviewRows.map((review): ReviewDto => {
      const attempt = attemptByReview.get(review.id);
      const developerSessionContinued = Boolean(attempt?.developer_session_ref && attempt.developer_execution_id && this.database.authQuery((db) => db.prepare("SELECT session_ref FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ?").get(attempt.developer_execution_id, row.id, row.company_id) as { session_ref: string | null } | undefined)?.session_ref === attempt.developer_session_ref);
      return {
        id: review.id,
        outcome: review.outcome,
        summary: review.summary,
        planRevision: review.plan_revision,
        baseSha: review.base_sha,
        baseShaAbbrev: review.base_sha.slice(0, 8),
        subjectCommit: review.subject_commit,
        subjectCommitAbbrev: review.subject_commit.slice(0, 8),
        subjectTree: review.subject_tree,
        subjectTreeAbbrev: review.subject_tree.slice(0, 8),
        opinionArtifactId: review.opinion_artifact_id,
        evidenceArtifactId: review.evidence_artifact_id,
        correctionAttempts: attempt?.correction_attempts ?? null,
        supersedesReviewId: review.supersedes_review_id,
        successorReviewId: successorByReview.get(review.id) ?? null,
        leadSessionContinued: Boolean(leadSession && leadSession === review.session_ref),
        developerSessionContinued,
        createdAt: review.created_at,
        findings: findingsByReview.get(review.id) ?? [],
      };
    });
    const currentReview = workflowState.deliveryReviewId ? reviewDtos.find((review) => review.id === workflowState.deliveryReviewId) ?? null : null;
    if (workflowState.deliveryReviewId && !currentReview) throw new TaskFailure("Task projection is unavailable", [finding("projection-integrity", "deliveryReviewId", "The current workflow review is unavailable")], 500);
    return {
      currentReview,
      priorReviews: reviewDtos.filter((review) => review.id !== workflowState.deliveryReviewId),
      reviewAttempts: attemptRows.map((attempt) => ({
        id: attempt.id,
        status: attempt.status,
        code: attempt.failure_code as DeliveryOperationBlockCode | null,
        summary: attempt.failure_summary,
        correctionAttempts: attempt.correction_attempts,
        planRevision: attempt.plan_revision,
        baseSha: attempt.base_sha,
        baseShaAbbrev: attempt.base_sha.slice(0, 8),
        subjectCommit: attempt.subject_commit,
        subjectCommitAbbrev: attempt.subject_commit.slice(0, 8),
        subjectTree: attempt.subject_tree,
        subjectTreeAbbrev: attempt.subject_tree.slice(0, 8),
        developerExecutionId: attempt.developer_execution_id,
        deliveryArtifactId: attempt.delivery_artifact_id,
        developerEvidenceArtifactId: attempt.developer_evidence_artifact_id,
        evidenceArtifactId: attempt.evidence_artifact_id,
        completedReviewId: attempt.completed_review_id,
        supersedesReviewId: attempt.supersedes_review_id,
        createdAt: attempt.created_at,
        finishedAt: attempt.finished_at,
      })),
      repairAttempts: repairRows.map((repair) => ({
        id: repair.id,
        reviewId: repair.review_id,
        cycle: repair.cycle,
        status: repair.status,
        code: repair.failure_code as DeliveryOperationBlockCode | null,
        summary: repair.failure_summary,
        priorCommit: repair.subject_commit,
        priorCommitAbbrev: repair.subject_commit.slice(0, 8),
        priorTree: repair.subject_tree,
        priorTreeAbbrev: shaAbbrev(repair.subject_tree),
        resultCommit: repair.result_commit,
        resultCommitAbbrev: shaAbbrev(repair.result_commit),
        resultTree: repair.result_tree,
        resultTreeAbbrev: shaAbbrev(repair.result_tree),
        deliveryArtifactId: repair.delivery_artifact_id,
        evidenceArtifactId: repair.evidence_artifact_id,
        createdAt: repair.created_at,
        finishedAt: repair.finished_at,
      })),
    };
  }

  private publicTask(actorUserId: string, row: TaskRow): ForgeTask {
    void actorUserId;
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
    const workflowState = this.workflowStateForTask(row);
    const reviewLineage = this.reviewLineage(row, workflowState);
    const timeline = this.database.authQuery((db) => db.prepare("SELECT id, revision, event_type, metadata_json, created_at FROM forge_issue_timeline WHERE task_id = ? ORDER BY revision, id").all(row.id) as TimelineRow[]).map((entry) => ({ id: entry.id, revision: entry.revision, eventType: entry.event_type, metadata: parseMetadata(entry.metadata_json), createdAt: entry.created_at }));
    const agentInvocations = this.database.authQuery((db) => db.prepare(`SELECT id, role, status, attempt, session_ref, started_at, finished_at, failure_code, failure_summary, evidence_artifact_id
      FROM forge_agent_executions WHERE task_id = ? AND company_id = ?
      UNION ALL
      SELECT id, 'developer' AS role, status, attempt, session_ref, started_at, finished_at, failure_code, failure_summary, evidence_artifact_id
      FROM forge_developer_executions WHERE task_id = ? AND company_id = ?
      ORDER BY started_at, id`).all(row.id, row.company_id, row.id, row.company_id) as AgentInvocationRow[]).map((invocation) => ({
        id: invocation.id,
        role: invocation.role,
        status: invocation.status,
        attempt: invocation.attempt,
        sessionPresent: Boolean(invocation.session_ref),
        startedAt: invocation.started_at,
        finishedAt: invocation.finished_at,
        failureCode: invocation.failure_code,
        failureSummary: invocation.failure_summary,
        evidenceArtifactId: invocation.evidence_artifact_id,
      }));
    const leadOutput = this.leadOutput(row.id, row.company_id);
    const developerExecution = this.database.authQuery((db) => db.prepare("SELECT id, status, attempt, branch_name, branch_name AS branchName, target_base_sha AS targetBaseSha, current_step AS currentStep, result_commit AS resultCommit, result_tree AS resultTree, dirty_state AS dirtyState, delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions WHERE task_id = ? AND company_id = ? ORDER BY attempt DESC, started_at DESC LIMIT 1").get(row.id, row.company_id) as { id: string; status: string; attempt: number; branch_name: string; branchName: string; targetBaseSha: string; currentStep: number | null; resultCommit: string | null; resultTree: string | null; dirtyState: string | null; deliveryArtifactId: string | null; evidenceArtifactId: string | null; failureCode: string | null; failureSummary: string | null } | undefined);
    const workflowSnapshot = this.database.authQuery((db) => db.prepare("SELECT state_json AS stateJson FROM forge_workflow_snapshots WHERE task_id = ? AND revision = ?").get(row.id, row.projection_revision) as { stateJson: string } | undefined);
    const snapshotState = workflowSnapshot ? IssueWorkflowStateSchema.safeParse(json<unknown>(workflowSnapshot.stateJson, null)) : undefined;
    const allowedCommands = json<string[]>(row.allowed_commands_json, []);
    const recoveryStatus = snapshotState?.success ? snapshotState.data.developerRecoveryStatus : undefined;
    const nextRecoveryCommand = recoveryStatus ? (["verify_developer_ownership", "retry_development", "cancel_development", "cancel_issue"] as const).find((command) => allowedCommands.includes(command)) : undefined;
    const developerRecovery = recoveryStatus && snapshotState?.success ? {
      status: recoveryStatus,
      reasonCode: snapshotState.data.developerRecoveryReasonCode ?? null,
      summary: snapshotState.data.developerRecoverySummary ?? null,
      lastHeartbeatAt: snapshotState.data.developerLastHeartbeatAt ?? null,
      currentOwner: recoveryStatus === "ownership_ambiguous" ? "operator" as const : "forge" as const,
      evidenceArtifactId: snapshotState.data.developerEvidenceArtifactId ?? developerExecution?.evidenceArtifactId ?? null,
      nextAction: nextRecoveryCommand ? { command: nextRecoveryCommand, label: nextRecoveryCommand === "verify_developer_ownership" ? "Recheck ownership" : nextRecoveryCommand === "retry_development" ? "Retry development" : nextRecoveryCommand === "cancel_development" ? "Cancel development" : "Cancel issue", requiresConfirmation: nextRecoveryCommand !== "verify_developer_ownership" } : null,
    } : undefined;
    const governance = this.database.authQuery((db) => db.prepare("SELECT plan_revision, plan_material, material_categories_json, supplemental_review_used, supplemental_review_artifact_id, decision_id FROM forge_issue_governance WHERE task_id = ? AND company_id = ?").get(row.id, row.company_id) as { plan_revision: number | null; plan_material: number | null; material_categories_json: string | null; supplemental_review_used: number; supplemental_review_artifact_id: string | null; decision_id: string | null } | undefined);
    const decision = this.database.authQuery((db) => db.prepare("SELECT artifact_id FROM forge_delivery_decisions WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id, row.company_id, row.workflow_id) as { artifact_id: string } | undefined);
    const review = this.database.authQuery((db) => db.prepare("SELECT id, outcome, summary, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, opinion_artifact_id, evidence_artifact_id, repair_cycle FROM forge_delivery_reviews WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(row.id, row.company_id, row.workflow_id) as { id: string; outcome: "approved" | "blocking"; summary: string; plan_revision: number; base_sha: string; subject_commit: string; subject_tree: string; lead_execution_id: string; opinion_artifact_id: string; evidence_artifact_id: string; repair_cycle: number } | undefined);
    const findings = review ? this.database.authQuery((db) => db.prepare("SELECT id, severity, rationale, evidence_ref, disposition, repair_instruction FROM forge_delivery_findings WHERE review_id = ? AND task_id = ? AND company_id = ? ORDER BY id").all(review.id, row.id, row.company_id) as Array<{ id: string; severity: "blocking" | "advisory"; rationale: string; evidence_ref: string; disposition: string; repair_instruction: string | null }>) : [];
    const planHistory = this.database.authQuery((db) => db.prepare("SELECT revision, kind, summary, execution_id AS executionId, output_artifact_id AS outputArtifactId, evidence_artifact_id AS evidenceArtifactId, created_at AS createdAt FROM forge_issue_outputs WHERE task_id = ? AND company_id = ? ORDER BY revision, created_at, id").all(row.id, row.company_id) as TaskPlanHistoryEntry[]);
    const planDecisionHistory = this.database.authQuery((db) => db.prepare("SELECT id, plan_revision AS planRevision, decision, note_artifact_id AS noteArtifactId, created_at AS createdAt FROM forge_plan_decisions WHERE task_id = ? AND company_id = ? ORDER BY plan_revision, created_at, id").all(row.id, row.company_id) as TaskPlanDecisionHistoryEntry[]);
    const revisionHistory = this.database.authQuery((db) => db.prepare("SELECT id, request_revision AS requestRevision, disposition, status, blocker_code AS blockerCode, developer_execution_id AS developerExecutionId, branch_name AS branchName, base_sha AS baseSha, head_sha AS headSha, tree_sha AS treeSha, exact_base_sha AS exactBaseSha, authorized_plan_revision AS authorizedPlanRevision, reason_artifact_id AS reasonArtifactId, created_at AS createdAt, updated_at AS updatedAt FROM forge_plan_revision_requests WHERE task_id = ? AND company_id = ? ORDER BY request_revision, created_at, id").all(row.id, row.company_id) as TaskRevisionHistoryEntry[]);
    const developerExecutionHistory = this.database.authQuery((db) => db.prepare("SELECT id, plan_revision AS planRevision, attempt, status, branch_name AS branchName, target_base_sha AS targetBaseSha, result_commit AS resultCommit, result_tree AS resultTree, dirty_state AS dirtyState, delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId, failure_code AS failureCode, failure_summary AS failureSummary, started_at AS startedAt, finished_at AS finishedAt FROM forge_developer_executions WHERE task_id = ? AND company_id = ? ORDER BY plan_revision, attempt, started_at, id").all(row.id, row.company_id) as TaskDeveloperExecutionHistoryEntry[]);
    const deliveryReviewHistory = this.database.authQuery((db) => db.prepare("SELECT id, plan_revision AS planRevision, outcome, summary, base_sha AS baseSha, subject_commit AS subjectCommit, subject_tree AS subjectTree, opinion_artifact_id AS opinionArtifactId, evidence_artifact_id AS evidenceArtifactId, repair_cycle AS repairCycle, created_at AS createdAt FROM forge_delivery_reviews WHERE task_id = ? AND company_id = ? ORDER BY created_at, id").all(row.id, row.company_id) as TaskDeliveryReviewHistoryEntry[]);
    const linkedTask = (taskId: string | null): TaskLinkSummary | undefined => taskId ? this.database.authQuery((db) => db.prepare("SELECT t.id, t.title, p.phase FROM forge_tasks t JOIN forge_issue_projections p ON p.task_id = t.id AND p.company_id = t.company_id WHERE t.id = ? AND t.company_id = ?").get(taskId, row.company_id) as TaskLinkSummary | undefined) : undefined;
    const predecessor = linkedTask(row.predecessor_task_id);
    const successor = linkedTask(row.successor_task_id);
    const ci = this.ciProjection(row.id, row.company_id);
    const release = this.releaseForTask(row.id, row.company_id, row.workflow_id);
    const capacity = this.capacity.statusForTask(row.id);
    const reconciliationState: Record<string, unknown> = workflowState;
    const reconciliation = this.database.authQuery((db) => db.prepare(`SELECT id, checkpoint, status, expected_base_sha AS expectedBaseSha, current_base_sha AS observedBaseSha, prior_head AS priorHead, prior_tree AS priorTree, result_head AS resultHead, result_tree AS resultTree, conflict_file_count AS conflictFileCount, conflict_artifact_id AS conflictArtifactId, verification_artifact_id AS verificationArtifactId, delivery_artifact_id AS deliveryArtifactId, invalidated_delivery_review_id AS invalidatedDeliveryReviewId, invalidated_ci_run_id AS invalidatedCiRunId, invalidated_final_review_id AS invalidatedFinalReviewId, invalidated_acceptance_id AS invalidatedAcceptanceId, release_id AS releaseId, pull_request_number AS pullRequestNumber, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_forward_merges WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(row.id, row.company_id, row.workflow_id) as { id: string; checkpoint: string | null; status: string; expectedBaseSha: string; observedBaseSha: string; priorHead: string; priorTree: string | null; resultHead: string | null; resultTree: string | null; conflictFileCount: number | null; conflictArtifactId: string | null; verificationArtifactId: string | null; deliveryArtifactId: string | null; invalidatedDeliveryReviewId: string | null; invalidatedCiRunId: string | null; invalidatedFinalReviewId: string | null; invalidatedAcceptanceId: string | null; releaseId: string | null; pullRequestNumber: number | null; failureCode: string | null; failureSummary: string | null } | undefined);
    const reference = (id: unknown): { id: string; sha256: string; kind: string } | null => {
      if (typeof id !== "string") return null;
      return this.database.authQuery((db) => db.prepare("SELECT id, sha256, kind FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind IN ('forward-merge-conflict', 'forward-merge-verification', 'forward-merge-delivery')").get(id, row.company_id) as { id: string; sha256: string; kind: string } | undefined) ?? null;
    };
    const targetBaseReconciliation: ForgeTask["targetBaseReconciliation"] = {
      checkId: typeof reconciliationState.targetBaseCheckId === "string" ? reconciliationState.targetBaseCheckId : reconciliation?.id ?? null,
      checkpoint: reconciliationState.targetBaseCheckpoint === "pre_release" || reconciliationState.targetBaseCheckpoint === "pre_final_review" || reconciliationState.targetBaseCheckpoint === "pre_acceptance" ? reconciliationState.targetBaseCheckpoint : reconciliation?.checkpoint === "pre_release" || reconciliation?.checkpoint === "pre_final_review" || reconciliation?.checkpoint === "pre_acceptance" ? reconciliation.checkpoint : null,
      status: reconciliationState.targetBaseOutcome === "no_drift" || reconciliationState.targetBaseOutcome === "revalidated" || reconciliationState.targetBaseOutcome === "conflict" || reconciliationState.targetBaseOutcome === "blocked" ? reconciliationState.targetBaseOutcome : reconciliation?.status === "no_drift" || reconciliation?.status === "merged" || reconciliation?.status === "conflict" || reconciliation?.status === "blocked" ? reconciliation.status === "merged" ? "revalidated" : reconciliation.status : null,
      expectedBaseSha: reconciliation?.expectedBaseSha ?? (typeof reconciliationState.targetBaseSha === "string" ? reconciliationState.targetBaseSha : null),
      observedBaseSha: reconciliation?.observedBaseSha ?? (typeof reconciliationState.forwardMergeTargetBaseSha === "string" ? reconciliationState.forwardMergeTargetBaseSha : typeof reconciliationState.targetBaseSha === "string" ? reconciliationState.targetBaseSha : null),
      priorHead: reconciliation?.priorHead ?? (typeof reconciliationState.forwardMergePriorHead === "string" ? reconciliationState.forwardMergePriorHead : null),
      priorTree: reconciliation?.priorTree ?? null,
      resultHead: reconciliation?.resultHead ?? (typeof reconciliationState.resultCommit === "string" ? reconciliationState.resultCommit : null),
      resultTree: reconciliation?.resultTree ?? (typeof reconciliationState.resultTree === "string" ? reconciliationState.resultTree : null),
      conflictFileCount: reconciliation?.conflictFileCount ?? (typeof reconciliationState.forwardMergeConflictFileCount === "number" ? reconciliationState.forwardMergeConflictFileCount : null),
      conflictArtifact: reference(reconciliation?.conflictArtifactId ?? (reconciliationState.forwardMergeConflictArtifact && typeof reconciliationState.forwardMergeConflictArtifact === "object" ? (reconciliationState.forwardMergeConflictArtifact as { id?: unknown }).id : null)),
      verificationArtifact: reference(reconciliation?.verificationArtifactId ?? reconciliationState.developerEvidenceArtifactId),
      deliveryArtifact: reference(reconciliation?.deliveryArtifactId ?? reconciliationState.deliveryArtifactId),
      invalidatedDeliveryReviewId: reconciliation?.invalidatedDeliveryReviewId ?? null,
      invalidatedCiRunId: reconciliation?.invalidatedCiRunId ?? null,
      invalidatedFinalReviewId: reconciliation?.invalidatedFinalReviewId ?? null,
      invalidatedAcceptanceId: reconciliation?.invalidatedAcceptanceId ?? null,
      releaseId: reconciliation?.releaseId ?? (typeof reconciliationState.releaseId === "string" ? reconciliationState.releaseId : null),
      pullRequestNumber: reconciliation?.pullRequestNumber ?? (typeof reconciliationState.pullRequestNumber === "number" ? reconciliationState.pullRequestNumber : null),
      pullRequestUrl: typeof reconciliationState.pullRequestUrl === "string" && /^https:\/\//.test(reconciliationState.pullRequestUrl) ? reconciliationState.pullRequestUrl : null,
      blockerCode: reconciliation?.failureCode ?? (typeof reconciliationState.targetBaseBlockerCode === "string" ? reconciliationState.targetBaseBlockerCode : null),
      blockerOwner: typeof reconciliationState.targetBaseBlockerOwner === "string" ? reconciliationState.targetBaseBlockerOwner : null,
      retryable: typeof reconciliationState.targetBaseBlockerRetryable === "boolean" ? reconciliationState.targetBaseBlockerRetryable : null,
      summary: reconciliation?.failureSummary ?? (typeof reconciliationState.targetBaseBlockerSummary === "string" ? reconciliationState.targetBaseBlockerSummary : null),
      actions: json<string[]>(row.allowed_commands_json, []),
    };
    const deliveryGate = this.deliveryGate(row, workflowState);
    return { id: row.id, companyId: row.company_id, projectId: row.project_id, title: row.title, description, briefArtifactId: row.brief_artifact_id, images: imageIds.flatMap((artifactId) => { const artifact = artifactById.get(artifactId); return artifact ? [{ artifactId, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }] : []; }), roleProfiles: parseProfiles(row.role_profiles_json), supplementalReview: row.supplemental_review === 1, workflowId: row.workflow_id, projectRevisionId: row.project_revision_id, phase: row.phase, revision: row.projection_revision, owner: row.owner, allowedCommands: json<string[]>(row.allowed_commands_json, []), pendingAction: row.pending_action, createdAt: row.created_at, updatedAt: row.updated_at, projection: { authoritativeRevision: row.authoritative_revision, projectedRevision: row.projection_revision, projectedAt: row.projected_at, status: row.authoritative_revision > row.projection_revision ? "lagging" : "current" }, capacity, ...(row.predecessor_task_id ? { predecessorTaskId: row.predecessor_task_id } : {}), ...(row.successor_task_id ? { successorTaskId: row.successor_task_id } : {}), ...(predecessor ? { predecessor } : {}), ...(successor ? { successor } : {}), timeline, agentInvocations, targetBaseReconciliation, reviewLineage, deliveryReviewBlockerCode: workflowState.deliveryReviewBlockerCode ?? null, deliveryReviewBlockerSummary: workflowState.deliveryReviewBlockerSummary ?? null, deliveryReviewBlockerEvidenceArtifactId: workflowState.deliveryReviewBlockerEvidenceArtifactId ?? null, deliveryRepairBlockerCode: workflowState.deliveryRepairBlockerCode ?? null, deliveryRepairBlockerSummary: workflowState.deliveryRepairBlockerSummary ?? null, deliveryRepairBlockerEvidenceArtifactId: workflowState.deliveryRepairBlockerEvidenceArtifactId ?? null, planHistory, planDecisionHistory, revisionHistory, developerExecutionHistory, deliveryReviewHistory, ...(release !== undefined ? { release } : {}), ...(governance ? { planRevision: governance.plan_revision, planMaterial: governance.plan_material === null ? null : governance.plan_material === 1, materialCategories: json<string[]>(governance.material_categories_json ?? "[]", []), supplementalReviewUsed: governance.supplemental_review_used === 1, ...(governance.supplemental_review_artifact_id ? { supplementalReviewArtifactId: governance.supplemental_review_artifact_id } : {}), ...(governance.decision_id ? { decisionId: governance.decision_id } : {}) } : {}), ...(decision ? { deliveryDecisionArtifactId: decision.artifact_id } : {}), ...(review ? { deliveryReview: { id: review.id, outcome: review.outcome, summary: review.summary, planRevision: review.plan_revision, baseSha: review.base_sha, subjectCommit: review.subject_commit, subjectTree: review.subject_tree, leadExecutionId: review.lead_execution_id, opinionArtifactId: review.opinion_artifact_id, evidenceArtifactId: review.evidence_artifact_id, repairCycle: review.repair_cycle, findings: findings.map((finding) => ({ id: finding.id, severity: finding.severity, rationale: finding.rationale, evidenceRef: finding.evidence_ref, disposition: finding.disposition, repairInstruction: finding.repair_instruction })) } } : {}), ...(deliveryGate ? { deliveryGate } : {}), ...(leadOutput ? { leadOutput } : {}), ...(developerExecution ? { developerExecution: { id: developerExecution.id, status: developerExecution.status, attempt: developerExecution.attempt, branchName: developerExecution.branch_name, targetBaseSha: developerExecution.targetBaseSha, currentStep: developerExecution.currentStep ?? null, resultCommit: developerExecution.resultCommit ?? null, resultTree: developerExecution.resultTree ?? null, dirtyState: developerExecution.dirtyState ?? null, deliveryArtifactId: developerExecution.deliveryArtifactId ?? null, evidenceArtifactId: developerExecution.evidenceArtifactId ?? null, failureCode: developerExecution.failureCode ?? null, failureSummary: developerExecution.failureSummary ?? null } } : {}), ...(developerRecovery ? { developerRecovery } : {}), ...(ci ? { ci } : {}) };
  }

  private releaseForTask(taskId: string, companyId: string, workflowId: string): TaskRelease | null | undefined {
    const row = this.database.authQuery((db) => db.prepare(`SELECT r.id, r.status, r.repository, r.base_branch AS baseBranch, r.head_branch AS headBranch, r.base_sha AS baseSha, r.head_sha AS headSha, r.head_tree AS headTree, r.pr_number AS pullRequestNumber, r.pr_url AS pullRequestUrl, r.reused, r.title, r.body_artifact_id AS bodyArtifactId, a.storage_path AS bodyStoragePath, a.sha256 AS bodySha, o.kind AS operationKind, o.status AS operationStatus, o.attempt, o.started_at AS startedAt, o.observed_at AS observedAt, o.completed_at AS completedAt, o.failure_code AS failureCode, o.failure_summary AS failureSummary, o.retry_at AS retryAt
      FROM forge_releases r LEFT JOIN forge_artifacts a ON a.id = r.body_artifact_id AND a.company_id = r.company_id AND a.kind = 'release-public-body'
      LEFT JOIN forge_provider_operations o ON o.id = (SELECT latest.id FROM forge_provider_operations latest WHERE latest.task_id = r.task_id AND latest.company_id = r.company_id AND latest.workflow_id = r.workflow_id AND latest.release_key = r.release_key AND latest.kind IN ('push', 'create-draft-pr') ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1)
      WHERE r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.superseded_at IS NULL ORDER BY r.updated_at DESC LIMIT 1`).get(taskId, companyId, workflowId) as { id: string; status: string; repository: string; baseBranch: string; headBranch: string; baseSha: string; headSha: string; headTree: string; pullRequestNumber: number | null; pullRequestUrl: string | null; reused: number; title: string; bodyArtifactId: string | null; bodyStoragePath: string | null; bodySha: string | null; operationKind: string | null; operationStatus: string | null; attempt: number | null; startedAt: string | null; observedAt: string | null; completedAt: string | null; failureCode: string | null; failureSummary: string | null; retryAt: string | null } | undefined);
    if (!row) return undefined;
    let bodyPreview: string | null = null;
    if (row.bodyArtifactId && row.bodyStoragePath && row.bodySha) {
      try { bodyPreview = this.artifacts.readSync({ companyId, storagePath: row.bodyStoragePath, sha256: row.bodySha }).toString("utf8"); } catch { bodyPreview = null; }
    }
    const status: TaskRelease["status"] = row.status === "draft" ? "draft" : row.status === "reconciling" ? "reconciling" : "blocked";
    const observedFailureCode = ReleaseFailureCodeSchema.safeParse(row.failureCode ?? row.status);
    const failureCode = status === "blocked" ? observedFailureCode.success ? observedFailureCode.data : "provider-unavailable" : null;
    return { id: row.id, status, failureCode, failureSummary: row.failureSummary, retryAt: row.retryAt, repository: row.repository, baseBranch: row.baseBranch, headBranch: row.headBranch, baseSha: row.baseSha, headSha: row.headSha, headTree: row.headTree, reviewedCommit: { abbreviated: row.headSha.slice(0, 7), full: row.headSha }, reviewedTree: { abbreviated: row.headTree.slice(0, 7), full: row.headTree }, pullRequestNumber: row.pullRequestNumber, pullRequestUrl: row.pullRequestUrl, isDraft: row.pullRequestNumber !== null && status === "draft", reused: row.reused === 1, bodyArtifactId: row.bodyArtifactId, title: row.title, bodyPreview, operation: row.operationKind ? { kind: row.operationKind, status: row.operationStatus ?? "", attempt: row.attempt, startedAt: row.startedAt, observedAt: row.observedAt, completedAt: row.completedAt } : null };
  }

  getRelease(actorUserId: string, taskId: string): TaskRelease | null {
    const task = this.getTask(actorUserId, taskId);
    return this.releaseForTask(task.id, task.companyId, task.workflowId) ?? null;
  }

  async getReleaseArtifact(actorUserId: string, taskId: string, artifactId: string): Promise<{ mimeType: string; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const artifact = this.database.authQuery((db) => db.prepare(`SELECT a.mime_type AS mimeType, a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a JOIN forge_releases r ON r.body_artifact_id = a.id AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.superseded_at IS NULL WHERE a.id = ? AND a.company_id = ? AND a.kind = 'release-public-body'`).get(task.id, task.companyId, task.workflowId, artifactId, task.companyId) as { mimeType: string; storagePath: string; sha256: string } | undefined);
    if (!artifact) throw new TaskFailure("Not found", [], 404);
    return { mimeType: artifact.mimeType, bytes: await this.artifacts.read({ companyId: task.companyId, storagePath: artifact.storagePath, sha256: artifact.sha256 }) };
  }

  private deliveryGate(row: TaskRow, state: IssueWorkflowState | undefined): ForgeTask["deliveryGate"] {
    if (!state?.releaseId) return undefined;
    const release = this.database.authQuery((db) => db.prepare("SELECT id, repository, pr_number, pr_url, base_branch, base_sha, head_sha, head_tree, status FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.releaseId, row.id, row.company_id, row.workflow_id) as { id: string; repository: string; pr_number: number | null; pr_url: string | null; base_branch: string; base_sha: string; head_sha: string; head_tree: string; status: string } | undefined);
    if (!release || release.pr_number === null || !release.pr_url) return undefined;
    const ci = state.ciRunId ? this.database.authQuery((db) => db.prepare("SELECT id, status, summary, updated_at FROM forge_ci_runs WHERE id = ? AND task_id = ? AND company_id = ? AND release_id = ?").get(state.ciRunId, row.id, row.company_id, release.id) as { id: string; status: string; summary: string; updated_at: string } | undefined) : undefined;
    const checks = ci ? this.database.authQuery((db) => db.prepare("SELECT name, status, conclusion, details_url FROM forge_ci_checks WHERE run_id = ? ORDER BY name").all(ci.id) as Array<{ name: string; status: string; conclusion: string | null; details_url: string | null }>) : [];
    const finalReview = state.finalReviewId ? this.database.authQuery((db) => db.prepare("SELECT id, outcome, summary, session_ref, opinion_artifact_id, evidence_artifact_id FROM forge_final_reviews WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.finalReviewId, row.id, row.company_id, row.workflow_id) as { id: string; outcome: "approved" | "blocking"; summary: string; session_ref: string; opinion_artifact_id: string; evidence_artifact_id: string } | undefined) : undefined;
    const finalFindings = finalReview ? this.database.authQuery((db) => db.prepare("SELECT id, severity, rationale, evidence_ref, disposition, repair_instruction FROM forge_final_review_findings WHERE review_id = ? AND task_id = ? AND company_id = ? ORDER BY id").all(finalReview.id, row.id, row.company_id) as Array<{ id: string; severity: string; rationale: string; evidence_ref: string; disposition: string; repair_instruction: string | null }>) : [];
    const acceptance = state.acceptanceId ? this.database.authQuery((db) => db.prepare("SELECT id, decision, status, actor_user_id, created_at, ready_at, reason_artifact_id FROM forge_acceptances WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.acceptanceId, row.id, row.company_id, row.workflow_id) as { id: string; decision: "accept" | "request_changes" | "cancel"; status: string; actor_user_id: string; created_at: string; ready_at: string | null; reason_artifact_id: string | null } | undefined) : undefined;
    const observation = state.mergeObservationId ? this.database.authQuery((db) => db.prepare("SELECT id, observed_at, provider_merged_at, evidence_artifact_id FROM forge_merge_observations WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.mergeObservationId, row.id, row.company_id, row.workflow_id) as { id: string; observed_at: string; provider_merged_at: string | null; evidence_artifact_id: string | null } | undefined) : undefined;
    const receipt = state.completionReceiptId ? this.database.authQuery((db) => db.prepare("SELECT id, receipt_artifact_id AS receiptArtifactId FROM forge_completion_receipts WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.completionReceiptId, row.id, row.company_id, row.workflow_id) as { id: string; receiptArtifactId: string } | undefined) : undefined;
    const releaseState = state.mergeOutcome === "merged" ? "merged" : state.mergeOutcome === "closed_without_merge" ? "closed" : release.status === "ready" ? "ready" : "draft";
    return { release: { id: release.id, repository: release.repository, pullRequestNumber: release.pr_number, pullRequestUrl: release.pr_url, baseBranch: release.base_branch, baseSha: release.base_sha, headSha: release.head_sha, headTree: release.head_tree, state: releaseState }, ci: ci ? { id: ci.id, status: ci.status, summary: ci.summary, updatedAt: ci.updated_at, checks: checks.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, detailsUrl: check.details_url })) } : null, finalReview: finalReview ? { id: finalReview.id, outcome: finalReview.outcome, summary: finalReview.summary, sessionRef: finalReview.session_ref, opinionArtifactId: finalReview.opinion_artifact_id, evidenceArtifactId: finalReview.evidence_artifact_id, findings: finalFindings.map((finding) => ({ id: finding.id, severity: finding.severity, rationale: finding.rationale, evidenceRef: finding.evidence_ref, disposition: finding.disposition, repairInstruction: finding.repair_instruction })) } : null, acceptance: acceptance ? { id: acceptance.id, decision: acceptance.decision, status: acceptance.status, actorUserId: acceptance.actor_user_id, decidedAt: acceptance.created_at, readyAt: acceptance.ready_at, reasonArtifactId: acceptance.reason_artifact_id, evidenceArtifactId: state.acceptanceBlockerEvidenceArtifactId ?? null } : null, merge: { outcome: state.mergeOutcome ?? null, observationId: observation?.id ?? null, observedAt: observation?.observed_at ?? null, mergedAt: observation?.provider_merged_at ?? null, receiptId: receipt?.id ?? null, receiptArtifactId: receipt?.receiptArtifactId ?? null, evidenceArtifactId: observation?.evidence_artifact_id ?? state.mergeBlockerEvidenceArtifactId ?? null }, deployment: { status: "unknown", summary: "Out of scope" } };
  }

  private leadOutput(taskId: string, companyId: string): ForgeTask["leadOutput"] {
    const row = this.database.authQuery((db) => db.prepare(`SELECT o.company_id, o.kind, o.summary, o.session_ref, o.execution_id, o.output_artifact_id, o.evidence_artifact_id, a.storage_path, a.sha256
      FROM forge_issue_outputs o JOIN forge_artifacts a ON a.id = o.output_artifact_id
      WHERE o.task_id = ? AND o.company_id = ? ORDER BY o.revision DESC LIMIT 1`).get(taskId, companyId) as LeadOutputRow | undefined);
    if (!row) return undefined;
    const content = LeadOutputSchema.parse(JSON.parse(this.artifacts.readSync({ companyId: row.company_id, storagePath: row.storage_path, sha256: row.sha256 }).toString("utf8")));
    return { kind: row.kind, summary: row.summary, executionId: row.execution_id, outputArtifactId: row.output_artifact_id, evidenceArtifactId: row.evidence_artifact_id, content };
  }

  private ciProjection(taskId: string, companyId: string): TaskCiProjection | undefined {
    type RunRow = { runId: string; releaseId: string; repository: string; pullRequestNumber: number | null; pullRequestUrl: string | null; baseBranch: string; headBranch: string; expectedHeadSha: string; expectedHeadTree: string | null; status: string; policyHash: string | null; policyJson: string | null; firstObservedAt: string | null; propagationDeadline: string | null; overallDeadline: string | null; nextRetryAt: string | null; completedAt: string | null; supersededAt: string | null };
    const run = this.database.authQuery((db) => db.prepare(`SELECT c.id AS runId, c.release_id AS releaseId, r.repository, r.pr_number AS pullRequestNumber, r.pr_url AS pullRequestUrl, r.base_branch AS baseBranch, r.head_branch AS headBranch, c.expected_head_sha AS expectedHeadSha, COALESCE(c.expected_head_tree, r.head_tree) AS expectedHeadTree, c.status, c.policy_hash AS policyHash, c.policy_json AS policyJson, c.first_observed_at AS firstObservedAt, c.propagation_deadline AS propagationDeadline, c.overall_deadline AS overallDeadline, c.next_poll_at AS nextRetryAt, c.completed_at AS completedAt, c.superseded_at AS supersededAt
      FROM forge_ci_runs c JOIN forge_releases r ON r.id = c.release_id
      WHERE c.task_id = ? AND c.company_id = ?
      ORDER BY c.updated_at DESC, c.id DESC LIMIT 1`).get(taskId, companyId) as RunRow | undefined);
    if (!run || run.pullRequestNumber === null || !run.pullRequestUrl || !run.expectedHeadTree || !run.policyHash) return undefined;
    const attemptRows = this.database.authQuery((db) => db.prepare(`SELECT id, attempt_number AS attemptNumber, observed_repository AS observedRepository, observed_pr_number AS observedPrNumber, observed_base_branch AS observedBaseBranch, observed_base_sha AS observedBaseSha, observed_head_branch AS observedHeadBranch, observed_head_sha AS observedHeadSha, outcome, reason, owner, repairable, retry_at AS retryAt, summary, evidence_artifact_id AS evidenceArtifactId, created_at AS createdAt FROM forge_ci_attempts WHERE run_id = ? ORDER BY attempt_number DESC LIMIT 20`).all(run.runId) as Array<Omit<TaskCiProjection["attempts"][number], "checks" | "repairable"> & { repairable: number }>);
    const attempts = attemptRows.map((attempt) => ({ ...attempt, repairable: attempt.repairable === 1, checks: this.database.authQuery((db) => db.prepare("SELECT provider_check_id AS providerCheckId, name, head_sha AS headSha, status, conclusion, details_url AS detailsUrl, summary, started_at AS startedAt, completed_at AS completedAt, selected_for_evaluation AS selectedForEvaluation FROM forge_ci_attempt_checks WHERE attempt_id = ? ORDER BY name, provider_check_id").all(attempt.id) as Array<Omit<TaskCiProjection["attempts"][number]["checks"][number], "selectedForEvaluation"> & { selectedForEvaluation: number }>).map((check) => ({ ...check, selectedForEvaluation: check.selectedForEvaluation === 1 })) }));
    const latest = attempts[0];
    const repairPlanRow = this.database.authQuery((db) => db.prepare("SELECT p.id, p.status, p.ci_run_id AS ciRunId, p.ci_attempt_id AS ciAttemptId, p.failed_head_sha AS failedHeadSha, p.plan_artifact_id AS planArtifactId, p.evidence_artifact_id AS evidenceArtifactId, p.summary, p.created_at AS createdAt, p.updated_at AS updatedAt, p.consumed_at AS consumedAt, p.superseded_at AS supersededAt, a.storage_path AS planStoragePath, a.sha256 AS planSha256 FROM forge_ci_repair_plans p JOIN forge_artifacts a ON a.id = p.plan_artifact_id AND a.company_id = p.company_id WHERE p.task_id = ? AND p.company_id = ? ORDER BY p.created_at DESC LIMIT 1").get(taskId, companyId) as (Omit<NonNullable<TaskCiProjection["repairPlan"]>, "steps"> & { planStoragePath: string; planSha256: string }) | undefined);
    const repairPlan = repairPlanRow ? (() => { const { planStoragePath, planSha256, ...publicPlan } = repairPlanRow; let steps: Array<{ number: number; instruction: string; verification: string }> = []; try { const value = json<{ steps?: unknown }>(this.artifacts.readSync({ companyId, storagePath: planStoragePath, sha256: planSha256 }).toString("utf8"), {}); steps = Array.isArray(value.steps) ? value.steps.filter((step): step is { number: number; instruction: string; verification: string } => Boolean(step) && typeof step === "object" && typeof (step as Record<string, unknown>).number === "number" && typeof (step as Record<string, unknown>).instruction === "string" && typeof (step as Record<string, unknown>).verification === "string").slice(0, 32) : []; } catch { /* projection remains bounded when the artifact is unavailable */ } return { ...publicPlan, steps }; })() : null;
    const repairs = this.database.authQuery((db) => db.prepare("SELECT x.id, x.repair_plan_id AS repairPlanId, x.prior_commit AS priorCommit, x.prior_tree AS priorTree, x.new_commit AS newCommit, x.new_tree AS newTree, x.delivery_artifact_id AS deliveryArtifactId, x.evidence_artifact_id AS evidenceArtifactId, x.status, x.summary, x.created_at AS createdAt, x.completed_at AS completedAt FROM forge_ci_repairs x JOIN forge_ci_repair_plans p ON p.id = x.repair_plan_id WHERE p.task_id = ? AND p.company_id = ? ORDER BY x.created_at DESC LIMIT 20").all(taskId, companyId) as TaskCiProjection["repairs"]);
    const supersededRuns = this.database.authQuery((db) => db.prepare("SELECT c.id AS runId, c.release_id AS releaseId, c.expected_head_sha AS expectedHeadSha, c.expected_head_tree AS expectedHeadTree, c.status, c.superseded_at AS supersededAt FROM forge_ci_runs c WHERE c.task_id = ? AND c.company_id = ? AND c.superseded_at IS NOT NULL ORDER BY c.superseded_at DESC, c.id DESC LIMIT 5").all(taskId, companyId) as TaskCiProjection["supersededRuns"]);
    const continuity = this.database.authQuery((db) => db.prepare(`SELECT
      EXISTS (SELECT 1 FROM forge_ci_repair_plans p JOIN forge_issue_outputs o ON o.task_id = p.task_id AND o.company_id = p.company_id AND o.workflow_id = p.workflow_id AND o.session_ref = p.lead_session_ref WHERE p.task_id = ? AND p.company_id = ?) AS lead,
      EXISTS (SELECT 1 FROM forge_ci_repairs x JOIN forge_ci_repair_plans p ON p.id = x.repair_plan_id JOIN forge_developer_executions d ON d.id = x.prior_developer_execution_id AND d.task_id = p.task_id AND d.company_id = p.company_id AND d.workflow_id = p.workflow_id WHERE p.task_id = ? AND p.company_id = ? AND d.session_ref = x.prior_developer_session_ref AND x.result_developer_session_ref = x.prior_developer_session_ref) AS developer`).get(taskId, companyId, taskId, companyId) as { lead: number; developer: number });
    const policy = json<TaskCiProjection["policy"]>(run.policyJson ?? "{}", { projectRevisionId: "", requiredChecks: [], acceptedConclusions: ["success"] });
    return { runId: run.runId, releaseId: run.releaseId, repository: run.repository, pullRequestNumber: run.pullRequestNumber, pullRequestUrl: run.pullRequestUrl, baseBranch: run.baseBranch, headBranch: run.headBranch, expectedHeadSha: run.expectedHeadSha, expectedHeadTree: run.expectedHeadTree, status: run.status, outcome: latest?.outcome ?? null, reason: latest?.reason ?? null, owner: latest?.owner ?? null, repairable: latest?.repairable ?? false, policyHash: run.policyHash, policy, leadSessionContinuity: continuity.lead === 1, developerSessionContinuity: continuity.developer === 1, firstObservedAt: run.firstObservedAt, propagationDeadline: run.propagationDeadline, overallDeadline: run.overallDeadline, nextRetryAt: run.nextRetryAt, completedAt: run.completedAt, supersededAt: run.supersededAt, supersededRuns, attempts, repairPlan, repairs };
  }

  private taskQuery(scope: string): string {
    return `SELECT t.id, t.company_id, t.project_id, t.title, t.brief_artifact_id, t.image_artifact_ids_json, t.role_profiles_json, t.supplemental_review, t.workflow_id, t.project_revision_id, t.predecessor_task_id, t.successor_task_id, t.created_at, t.updated_at, ip.revision AS projection_revision, ip.authoritative_revision, ip.projected_at, ip.phase, ip.owner, ip.allowed_commands_json, ip.pending_action, (SELECT a.filename FROM forge_artifacts a WHERE a.id = t.brief_artifact_id) AS description FROM forge_tasks t JOIN forge_issue_projections ip ON ip.task_id = t.id LEFT JOIN forge_memberships m ON m.company_id = t.company_id WHERE ${scope} ORDER BY t.created_at, t.id`;
  }

  private async deleteTask(taskId: string, artifacts: Array<StoredArtifact | undefined>): Promise<void> {
    const stored = this.database.authTransaction((db) => {
      const task = db.prepare("SELECT brief_artifact_id, image_artifact_ids_json FROM forge_tasks WHERE id = ?").get(taskId) as { brief_artifact_id: string; image_artifact_ids_json: string } | undefined;
      const ids = [...new Set([...(task ? [task.brief_artifact_id, ...parseImageIds(task.image_artifact_ids_json)] : []), ...artifacts.flatMap((artifact) => artifact ? [artifact.id] : [])])];
      const rows = ids.length
        ? db.prepare(`SELECT id, company_id, storage_path FROM forge_artifacts WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; company_id: string; storage_path: string }>
        : [];
      db.prepare("DELETE FROM forge_tasks WHERE id = ?").run(taskId);
      for (const row of rows) db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(row.id, row.company_id);
      return rows;
    });
    const physical = [...stored, ...artifacts.filter((artifact): artifact is StoredArtifact => Boolean(artifact)).map((artifact) => ({ company_id: artifact.companyId, storage_path: artifact.storagePath }))];
    await Promise.all(physical.map((artifact) => this.artifacts.remove({ companyId: artifact.company_id, storagePath: artifact.storage_path })));
  }

  private user(userId: string): AuthUser {
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new AuthFailure("Authentication required", 401);
    return user;
  }
}

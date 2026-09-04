import { createHash, randomUUID } from "node:crypto";

import type { AuthUser } from "./auth.js";
import { AuthFailure, type AuthService } from "./auth.js";
import type { CheckConclusion, CheckStatus, CiOutcome, CiOwner } from "./ci.js";
import type { ForgeConfig } from "./config.js";
import { ArtifactFailure, ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { PersistedLeadOutputSchema, SupplementalReviewSchema, type PersistedLeadOutput, type SupplementalReview } from "./codex-lead.js";
import { CapacityManager } from "./capacity.js";
import type { PublicCapacityStatus } from "./capacity-contracts.js";
import { type ForgeDatabase, projectionStateHash } from "./database.js";
import { redact } from "./logging.js";
import { configureCommandActivityStore } from "./command-runner.js";
import { type ProjectService, resolveAgentProfiles, type Project, type ProjectRole, type RoleAssignments } from "./projects.js";
import { loadTaskConfiguration, TaskProjectConfigurationSchema } from "./task-project-configuration.js";
import { PromptOverrideService, type ResolvedPromptSet } from "./prompt-overrides.js";
import { ReleaseFailureCodeSchema, type ReleaseFailureCode } from "./release-failures.js";
import { acceptIssueDevelopment, acceptIssuePlanning, continueIssueWork, executeIssueCommand, queryIssueWorkflow, recordIssueProgress, resolveIssueDecisionBlocker, reviseIssuePlan, startIssueWorkflow } from "./engine/service.js";
import { executeWorktreeCommand, type WorktreeCommandInput } from "./engine/worktree-commands.js";
import { issueCommands, IssueCommandSchema, type IssueCommand } from "./commands/registry.js";
import type { ContinueWorkCommand, PlanCommandInput, PlanRevisionCommand, RecordProgressInput, ResolveDecisionBlockerInput, SendPlannerNoteInput, StartPlanningInput } from "./commands/inputs.js";
import { createInitialIssueWorkflowState, DeliveryOperationBlockCodeSchema, IssueWorkflowStateSchema, type DeliveryOperationBlockCode, type DeliveryWorkflowBlockCode, type IssueWorkflowInput, type IssueWorkflowState } from "./engine/issue-contracts.js";
import { at, isBlocked, IssuePhaseSchema, IssueStepSchema, phaseOf, TERMINAL_PHASES, type IssuePhase, type IssueStep } from "./issue-phases.js";
import { invalidateBranchSync, WorktreeFailure, WorktreeManager } from "./worktrees.js";
import { taskCommandDescriptors, type TaskCommandDescriptor } from "./task-commands.js";
import { PlanSubjectSchema, type PlanBlockerSubject, type PlanSubject } from "./plan-governance.js";
import { IssueTimelineEvents } from "./issue-timeline-events.js";
import type { TaskActivityEvent } from "./task-activity.js";
import type { HermesPrincipal } from "./hermes-agents.js";
import type { HermesSafeTaskProjection } from "./http/contracts/hermes.js";
import { TaskSourceFailure, type TaskSourceSelector } from "./task-sources.js";
import { BrowserProofService, type BrowserProofProjection } from "./browser-proof.js";
import { CliHerdrClient, type HerdrClient } from "./herdr-client.js";
import { observeHerdrSessions } from "./herdr-recovery.js";
import { MAX_TASK_IMAGES, MAX_TASK_IMAGE_BYTES, MAX_TASK_IMAGE_BASE64_LENGTH } from "./task-attachment-limits.js";
import { attentionCardFromBlocker } from "./recovery/attention-card.js";
import type { AttentionCard } from "./recovery/convergence.js";
import { creationRequestHash, duplicateTitle, finding, id, json, normalizeText, parseImageIds, parseMetadata, parseRoleAgents, shaAbbrev, type TaskFinding, jsonRequired } from "./task-utils.js";
import { EvidenceManifestSchema } from "./developer-contracts.js";

export { creationRequestHash, type TaskFinding } from "./task-utils.js";

function developerVerificationProjection(database: ForgeDatabase, artifacts: ArtifactStore, companyId: string, manifestArtifactId: string | null): { verificationCommands: Array<{ stepNumber: number; commands: string[] }>; verificationResults: string[] } {
  const manifest = manifestArtifactId ? database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'developer-evidence-manifest'").get(manifestArtifactId, companyId) as { storagePath: string; sha256: string } | undefined) : undefined;
  let value: unknown = null;
  try { if (manifest) value = jsonRequired(artifacts.getArtifactSync({ companyId, storagePath: manifest.storagePath, sha256: manifest.sha256 }).toString("utf8")); } catch {}
  const parsed = EvidenceManifestSchema.safeParse(value);
  return { verificationCommands: parsed.success ? parsed.data.verificationCommands : [], verificationResults: [] };
}

export type TaskPhase = IssuePhase;

export type TaskCreationAuthority =
  | { kind: "user"; userId: string }
  | { kind: "hermes"; agentId: string; companyId: string; projectIds: string[] };

export class TaskFailure extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly findings: TaskFinding[];
  readonly current: ForgeTask | undefined;

  constructor(publicMessage: string, findings: TaskFinding[] = [], statusCode = 400, current?: ForgeTask, readonly ownerTaskId?: string) {
    super(publicMessage);
    this.name = "TaskFailure";
    this.publicMessage = publicMessage;
    this.findings = findings;
    this.statusCode = statusCode;
    this.current = current;
  }
}

function workflowCancellationFailureIsTransient(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const name = current instanceof Error ? current.name : "";
    const message = current instanceof Error ? current.message : "";
    if (/timeout|deadline|network|connection|unavailable|resource exhausted|temporar/i.test(`${name} ${message}`)) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function derivedAllowedCommands(phase: TaskPhase, projectedCommands: IssueCommand[], _planRevision: number | null | undefined, _hasPlanArtifact: boolean, hasSuccessor = false): IssueCommand[] {
  const failedCommand: IssueCommand | undefined = undefined;
  const commands = failedCommand && !projectedCommands.includes(failedCommand)
    ? [...projectedCommands, failedCommand]
    : projectedCommands;
  const cancellable = !TERMINAL_PHASES.has(phase) && !hasSuccessor && !commands.includes("cancel_issue") ? [...commands, "cancel_issue" as const] : commands;
  return !TERMINAL_PHASES.has(phase) && !hasSuccessor && !cancellable.includes("send_planner_note") ? [...cancellable, "send_planner_note"] : cancellable;
}


export type DeliveryTarget = "local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged";
export type VisualEvidence = "off" | "capture" | "required";

function legacyDeliveryTarget(mode: "draft" | "ready" | "auto_merge"): DeliveryTarget {
  return mode === "ready" ? "pull_request_ready" : mode === "auto_merge" ? "merged" : "pull_request_draft";
}

export type TaskBranchSync = { available: false; reason?: string } | {
  branchName: string;
  worktreePath: string;
  remoteExists: boolean;
  ahead: number;
  behind: number;
  aheadOfBase: number;
  behindBase: number;
  conflictsWithBase: boolean;
  headSha: string;
};


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
  roleAgents?: RoleAssignments;
  supplementalReview?: boolean;
  autoApprovePlan?: boolean;
  startImmediately?: boolean;
  deliveryTarget?: DeliveryTarget;
  runProjectTests?: boolean;
  visualEvidence?: VisualEvidence;
  /** Legacy workflow input retained solely for in-flight histories. */
  pullRequestMode?: "draft" | "ready" | "auto_merge";
  source?: TaskSourceSelector | undefined;
}

export interface TaskDetailsInput {
  title?: string | undefined;
  description?: string | undefined;
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

export type ActivityActor =
  | { kind?: "user"; id: string; displayName: string; username: string; avatarSeed: string }
  | { kind: "agent"; id: string; displayName: string; avatarSeed: string };

export interface TaskActivityEntry extends TaskTimelineEntry {
  kind: "workflow" | "member";
  actor?: ActivityActor | undefined;
}

export interface TaskAgentInvocation {
  id: string;
  role: "planner" | "reviewer" | "builder" | "integrator";
  status: string;
  attempt: number;
  sessionPresent: boolean;
  sessionRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  failureCode: string | null;
  failureSummary: string | null;
  summary?: string | null;
  evidenceArtifactId: string | null;
  profileId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  avatarSeed?: string | null;
  model?: string | null;
  reasoningLevel?: string | null;
  servicePriority?: string | null;
}

export interface DeveloperExecutionEvent {
  eventId: string;
  sequence: number;
  kind: string;
  stepNumber: number | null;
  occurredAt: string;
  summary: string;
  exitCode: number | null;
  artifactId: string | null;
}

type AgentProgressExecution = { id: string | null; status: string; startedAt: string; finishedAt: string | null; lastHeartbeatAt: string | null; lastOutputAt: string | null; currentStep: string | null };

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
  code: DeliveryOperationBlockCode | "cancelled" | null;
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

function reviewAttemptFailureCode(code: string | null): DeliveryOperationBlockCode | "cancelled" | null {
  if (code === null || code === "cancelled") return code;
  const parsed = DeliveryOperationBlockCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "process-failed";
}

export interface TaskLinkSummary {
  id: string;
  title: string;
  phase: TaskPhase;
  issueKey: string | null;
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
  leadExecutionId: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
  repairCycle: number;
  createdAt: string;
}

export interface PlanArtifactView {
  subject: PlanSubject;
  summary: string;
  content: PersistedLeadOutput;
  createdAt: string;
  status: "current" | "superseded";
}

export interface SupplementalReviewView {
  reviewId: string;
  reviewerProfile: { id: string; name: string };
  verdict: SupplementalReview["verdict"];
  summary: string;
  concerns: SupplementalReview["concerns"];
  artifactId: string;
  plannerResponse?: string;
  createdAt: string;
}

export interface PlanDecisionView {
  decisionId: string;
  decision: "approve" | "request_revision" | "reject";
  actor: { id: string; displayName: string };
  note: string;
  noteArtifactId: string;
  noteArtifactSha256: string;
  createdAt: string;
}

export interface PlanBlockerView {
  subject: PlanBlockerSubject;
  summary: string;
  evidence: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  nextAction: string;
  createdAt: string;
}

export interface PlanGovernanceView {
  originalPlan?: PlanArtifactView;
  finalPlan?: PlanArtifactView;
  previousPlans?: PlanArtifactView[];
  supplementalReview?: SupplementalReviewView;
  decision?: PlanDecisionView;
  blocker?: PlanBlockerView;
}
export interface ForgeTask {
  id: string;
  companyId: string;
  projectId: string;
  issueKey: string | null;
  title: string;
  archivedAt: string | null;
  description: string;
  briefArtifactId: string;
  images: TaskImage[];
  roleAgents: RoleAssignments;
  supplementalReview: boolean;
  autoApprovePlan: boolean;
  deliveryTarget: DeliveryTarget;
  executionControls: { runProjectTests: boolean; visualEvidence: VisualEvidence; supplementalReview: boolean };
  browserProof: BrowserProofProjection[];
  deliveryReceipt: { worktreePath: string | null; branchName: string | null; commit: string | null } | null;
  worktreeState: "present" | "cleaned" | "removed_externally" | null;
  worktreePath: string | null;
  workflowId: string;
  projectRevisionId: string;
  prompts: { overrides: string[] };
  source?: { kind: "pull_request"; number: number; url: string; headBranch: string; baseBranch: string } | { kind: "branch"; branch: string };
  /** Compatibility display value for tasks created before delivery targets. */
  pullRequestMode: "draft" | "ready" | "auto_merge";
  phase: TaskPhase;
  step: IssueStep;
  blocked: boolean;
  liveStatus: Array<{ role: string; status: string }>;
  liveStatusObservedAt: string | null;
  revision: number;
  owner: "human" | "lead";
  allowedCommands: IssueCommand[];
  pendingAction: string | null;
  lastHandlerError?: { command: string; reason: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
  timeline: TaskTimelineEntry[];
  activity: TaskActivityEntry[];
  agentInvocations: TaskAgentInvocation[];
  capacity: PublicCapacityStatus | null;
  planHistory: TaskPlanHistoryEntry[];
  planDecisionHistory: TaskPlanDecisionHistoryEntry[];
  revisionHistory: TaskRevisionHistoryEntry[];
  developerExecutionHistory: TaskDeveloperExecutionHistoryEntry[];
  deliveryReviewHistory: TaskDeliveryReviewHistoryEntry[];
  projection: { revision: number; projectedAt: string };
  commands: TaskCommandDescriptor[];
  governance: {
    originalPlan?: PlanArtifactView;
    finalPlan?: PlanArtifactView;
    previousPlans?: PlanArtifactView[];
    supplementalReview?: SupplementalReviewView;
    decision?: PlanDecisionView;
    blocker?: PlanBlockerView;
  };
  planReview?: SupplementalReviewView | null;
  planRevision?: number | null;
  planAuthorizationId?: string | null;
  planArtifactSha256?: string | null;
  supplementalReviewUsed?: boolean;
  supplementalReviewArtifactId?: string | null;
  decisionId?: string | null;
  leadInputManifestArtifactId?: string | undefined;
  blockedCategory?: "human_decision" | "authentication" | "configuration" | "capacity" | "execution_ownership" | null | undefined;
  blockedResumePhase?: "planning" | null | undefined;
  blockerArtifactId?: string | null | undefined;
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
  githubPullRequest?: { exists: boolean; number: number | null; url: string | null; state: "open" | "closed" | "merged" | null; isDraft: boolean | null; checks: { total: number; pending: number; failing: number; successful: number }; author?: { login: string; avatarUrl: string } | null; changedFiles?: number | null; additions?: number | null; deletions?: number | null; mergeable: string | null; observedAt: string | null; reviewDecision: string | null; autoMergeEnabled: boolean | null };
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
    finalReview: { id: string; outcome: "approved" | "blocking"; summary: string; leadExecutionId: string; createdAt: string; sessionRef: string; opinionArtifactId: string; evidenceArtifactId: string; findings: Array<{ id: string; severity: string; rationale: string; evidenceRef: string; disposition: string; repairInstruction: string | null }> } | null;
    acceptance: { id: string; decision: "accept" | "request_changes" | "cancel"; status: string; actorUserId: string; decidedAt: string; readyAt: string | null; reasonArtifactId: string | null; evidenceArtifactId: string | null } | null;
    merge: { outcome: string | null; observationId: string | null; observedAt: string | null; mergedAt: string | null; receiptId: string | null; receiptArtifactId: string | null; evidenceArtifactId: string | null };
    deployment: { status: "unknown"; summary: "Out of scope" };
  };
  developerExecution?: {
    id: string;
    status: string;
    attempt: number;
    branchName: string;
    startedAt: string;
    finishedAt: string | null;
    summary: string | null;
    worktreePath: string;
    targetBaseSha: string;
    currentStep?: number | null;
    resultCommit?: string | null;
    resultTree?: string | null;
    dirtyState?: string | null;
    deliveryArtifactId?: string | null;
    evidenceArtifactId?: string | null;
    reconciliationArtifactId?: string | null;
    manifestArtifactId?: string | null;
    rawReportArtifactId?: string | null;
    beforeProviderArtifactId?: string | null;
    afterProviderArtifactId?: string | null;
    boundaryMode?: "owner_controlled_observed" | null | undefined;
    providerObservation?: "matching" | "different" | "unavailable";
    startingCommit?: string | null;
    startingTree?: string | null;
    verificationCommands?: Array<{ stepNumber: number; commands: string[] }>;
    verificationResults?: string[];
    failureCode?: string | null;
    failureSummary?: string | null;
  };
  developerRecovery?: {
    status: "starting" | "active" | "reconnecting" | "result_pending_claim" | "interrupted" | "cancellation_requested" | "cancelling" | "cancelled" | "failed";
    reasonCode: string | null;
    summary: string | null;
    lastHeartbeatAt: string | null;
    currentOwner: "forge" | "operator";
    evidenceArtifactId: string | null;
    nextAction: { command: "retry_development" | "cancel_development" | "cancel_issue"; label: string; requiresConfirmation: boolean } | null;
  };
  attentionCard?: AttentionCard;
  leadOutput?: {
    kind: "plan" | "decision_blocker";
    summary: string;
    sessionRef: string;
    executionId: string;
    outputArtifactId: string;
    evidenceArtifactId: string;
    content: PersistedLeadOutput;
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

export type TaskListSummary = Pick<ForgeTask, "id" | "companyId" | "projectId" | "issueKey" | "title" | "deliveryTarget" | "phase" | "step" | "blocked" | "revision" | "owner" | "allowedCommands" | "pendingAction" | "createdAt" | "updatedAt"> & {
  archivedAt: string | null;
  worktreeState: "present" | "cleaned" | "removed_externally" | null;
  agentInvocations: Array<Pick<TaskAgentInvocation, "id" | "role" | "status" | "attempt" | "startedAt" | "finishedAt" | "agentId" | "agentName" | "avatarSeed">>;
  liveStatus: Array<{ role: string; status: string }>;
  liveStatusObservedAt: string | null;
  capacity: Pick<PublicCapacityStatus, "status"> | null;
  release?: Pick<TaskRelease, "status" | "pullRequestNumber" | "isDraft"> | null;
  ci?: Pick<TaskCiProjection, "outcome">;
  deliveryGate?: { release: { state: "draft" | "ready" | "merged" | "closed" } };
  githubPullRequest?: { state: "open" | "closed" | "merged" | null };
};

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
  policy: { projectRevisionId: string; requiredChecks: string[]; acceptedConclusions: ["success", "skipped"] };
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
  status: "reconciling" | "draft" | "ready" | "blocked";
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
  repository: string | undefined;
  baseSha: string;
  headSha: string;
}

export interface IssueWorkflowPort {
  start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string; existing?: boolean }>;
  execute(command: IssueCommand, workflowId: string, input: StartPlanningInput | PlanCommandInput | SendPlannerNoteInput): Promise<IssueWorkflowState>;
  worktreeCommand?(command: "delete_worktree" | "recreate_worktree", workflowId: string, input: WorktreeCommandInput): Promise<IssueWorkflowState>;
  revisePlan(workflowId: string, input: PlanRevisionCommand): Promise<IssueWorkflowState>;
  continueWork(workflowId: string, input: ContinueWorkCommand): Promise<IssueWorkflowState>;
  resolveDecisionBlocker(workflowId: string, input: ResolveDecisionBlockerInput): Promise<IssueWorkflowState>;
  recordProgress(workflowId: string, input: RecordProgressInput): Promise<IssueWorkflowState>;
  query(workflowId: string): Promise<IssueWorkflowState>;
  acceptPlanning?(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState>;
  acceptDevelopment?(workflowId: string, input: StartPlanningInput, command?: "start_development" | "retry_development"): Promise<IssueWorkflowState>;
}

export interface TaskCommandPayload {
  expectedRevision: number;
  commandId?: string;
  automatic?: boolean;
  note?: string;
  subject?: unknown;
  idempotencyKey?: string;
  blockerSubject?: unknown;
  confirmDiscardDirty?: boolean;
}

interface TaskServiceOptions {
  artifactStore?: ArtifactStore;
  workflow?: IssueWorkflowPort;
  now?: () => Date;
  capacity?: CapacityManager;
  promptOverrides?: PromptOverrideService;
  herdr?: HerdrClient;
}

interface TaskRow {
  id: string;
  company_id: string;
  project_id: string;
  issue_key: string | null;
  title: string;
  archived_at: string | null;
  brief_artifact_id: string;
  image_artifact_ids_json: string;
  role_agents_json: string;
  supplemental_review: number;
  auto_approve_plan: number;
  autoApprovePlan: number;
  pull_request_mode: "draft" | "ready" | "auto_merge";
  delivery_target: DeliveryTarget | null;
  run_project_tests: number;
  visual_evidence: VisualEvidence;
  delivery_worktree_path: string | null;
  delivery_branch_name: string | null;
  delivery_commit: string | null;
  workflow_id: string;
  project_revision_id: string;
  created_at: string;
  updated_at: string;
  description: string | null;
  projection_revision: number;
  projected_at: string;
  phase: string;
  step: string | null;
  owner: "human" | "lead";
  allowed_commands_json: string;
  pending_action: string | null;
  state_json: string;
  live_status_json: string;
  predecessor_task_id: string | null;
  successor_task_id: string | null;
}

type ProjectionLifecycle = { phase: IssuePhase; step: IssueStep };

function projectionLifecycle(row: Pick<TaskRow, "phase" | "step">): ProjectionLifecycle | undefined {
  if (row.step === null) {
    const legacyStep = IssueStepSchema.safeParse(row.phase);
    return legacyStep.success ? { phase: phaseOf(legacyStep.data), step: legacyStep.data } : undefined;
  }
  const phase = IssuePhaseSchema.safeParse(row.phase);
  const step = IssueStepSchema.safeParse(row.step);
  return phase.success && step.success ? { phase: phase.data, step: step.data } : undefined;
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
  state_json: string | null;
}

interface AgentInvocationRow {
  id: string;
  role: "planner" | "reviewer" | "builder" | "integrator";
  status: string;
  attempt: number;
  session_ref: string | null;
  started_at: string;
  finished_at: string | null;
  failure_code: string | null;
  failure_summary: string | null;
  summary: string | null;
  delivery_artifact_id: string | null;
  evidence_artifact_id: string | null;
  profile_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  avatar_seed: string | null;
  profile_name: string | null;
  resolved_model: string | null;
  resolved_reasoning_level: string | null;
  resolved_service_priority: string | null;
}

interface LeadOutputRow {
  company_id: string;
  kind: "plan" | "decision_blocker";
  summary: string;
  session_ref: string;
  execution_id: string;
  output_artifact_id: string;
  output_sha256: string;
  evidence_artifact_id: string;
  evidence_sha256: string;
  storage_path: string;
  sha256: string;
}

const titlePattern = /^\S[\s\S]{0,159}$/;
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);


export class TaskService {
  private readonly now: () => Date;
  private readonly artifacts: ArtifactStore;
  private readonly browserProof: BrowserProofService;
  private readonly workflow: IssueWorkflowPort;
  private readonly capacity: CapacityManager;
  private readonly eventListeners = new Set<{ afterCursor: number; send: (event: TaskEvent, cursor: number) => void }>();
  private readonly promptOverrides: PromptOverrideService;
  private readonly herdr: HerdrClient;
  private readonly liveStatusCache = new Map<string, { expiresAt: number; liveStatus: Array<{ role: string; status: string }>; observedAt: string }>();
  private readonly eventVersions = new Map<string, string>();
  private readonly taskLists = new Map<string, { cursor: number; expiresAt: number; tasks: TaskListSummary[] }>();
  private eventCursor = 0;
  private eventPoller: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: ForgeDatabase,
    private readonly auth: AuthService,
    private readonly projects: ProjectService,
    private readonly config: ForgeConfig,
    options: TaskServiceOptions = {},
  ) {
    configureCommandActivityStore(database);
    this.now = options.now ?? (() => new Date());
    this.artifacts = options.artifactStore ?? new ArtifactStore(config.artifactRoot, database);
    this.browserProof = new BrowserProofService(database, this.artifacts);
    this.capacity = options.capacity ?? new CapacityManager(database, config);
    this.promptOverrides = options.promptOverrides ?? new PromptOverrideService(database, auth, projects);
    this.herdr = options.herdr ?? new CliHerdrClient();
    this.workflow = options.workflow ?? {
      start: (input) => startIssueWorkflow(config, input),
      execute: (command, workflowId, input) => executeIssueCommand(config, workflowId, command, input),
      worktreeCommand: (command, workflowId, input) => executeWorktreeCommand(config, workflowId, command, input),
      acceptPlanning: (workflowId, input) => acceptIssuePlanning(config, workflowId, input),
      acceptDevelopment: (workflowId, input, command) => acceptIssueDevelopment(config, workflowId, input, command),
      revisePlan: (workflowId, input) => reviseIssuePlan(config, workflowId, input),
      continueWork: (workflowId, input) => continueIssueWork(config, workflowId, input),
      resolveDecisionBlocker: (workflowId, input) => resolveIssueDecisionBlocker(config, workflowId, input),
      recordProgress: (workflowId, input) => recordIssueProgress(config, workflowId, input),
      query: (workflowId) => queryIssueWorkflow(config, workflowId),
    };
  }

  taskEventCursor(): number {
    return this.eventCursor;
  }

  private clearTaskLists(): void {
    this.taskLists.clear();
  }

  subscribe(actorUserId: string, listener: (event: TaskEvent, cursor: number) => void, afterCursor = this.taskEventCursor()): () => void {
    if (this.eventListeners.size === 0) this.pollTaskEvents(false);
    const subscriber = { afterCursor, send: (event: TaskEvent, cursor: number): void => {
      try {
        this.auth.requireCompanyAccess(actorUserId, event.companyId);
        listener(event, cursor);
      } catch {
        // Scope is checked again at delivery time; a revoked membership receives no event.
      }
    } };
    this.eventListeners.add(subscriber);
    if (!this.eventPoller) {
      this.eventPoller = setInterval(() => this.pollTaskEvents(true), 100);
      this.eventPoller.unref();
    }
    return () => {
      this.eventListeners.delete(subscriber);
      if (this.eventListeners.size === 0 && this.eventPoller) {
        clearInterval(this.eventPoller);
        this.eventPoller = undefined;
        this.eventVersions.clear();
        this.eventCursor = 0;
      }
    };
  }

  private pollTaskEvents(notify = true): void {
    try {
      const rows = this.database.authQuery((db) => db.prepare("SELECT task_id, company_id, revision, phase, step, owner, pending_action, blocker_json, state_changed_at FROM forge_issue_projections").all() as Array<{ task_id: string; company_id: string; revision: number; phase: string; step: string | null; owner: string; pending_action: string | null; blocker_json: string | null; state_changed_at: string | null }>);
      const current = new Map(rows.map((row) => [row.task_id, JSON.stringify([row.revision, row.phase, row.step, row.owner, row.pending_action, row.blocker_json, row.state_changed_at])]));
      if (notify) {
        for (const row of rows) {
          if (this.eventVersions.get(row.task_id) === current.get(row.task_id)) continue;
          const cursor = ++this.eventCursor;
          this.clearTaskLists();
          const event: TaskEvent = { type: "invalidate", taskId: row.task_id, companyId: row.company_id, revision: row.revision, attentionChanged: false };
          for (const subscriber of this.eventListeners) {
            if (cursor > subscriber.afterCursor) subscriber.send(event, cursor);
          }
        }
      }
      this.eventVersions.clear();
      for (const [taskId, version] of current) this.eventVersions.set(taskId, version);
    } catch {
      // A transient SQLite lock is retried on the next tick.
    }
  }

  listTasks(actorUserId: string, companyId?: string, archived = false): TaskListSummary[] {
    if (companyId) this.auth.requireCompanyAccess(actorUserId, companyId);
    const key = JSON.stringify([actorUserId, companyId ?? null, archived]);
    const cached = this.taskLists.get(key);
    if (cached && cached.cursor === this.eventCursor && cached.expiresAt > this.now().getTime()) return cached.tasks;
    const user = this.user(actorUserId);
    const rows = this.database.authQuery((db) => {
      const query = user.role === "admin"
        ? companyId ? db.prepare(this.taskQuery(`t.company_id = ? AND t.archived_at IS ${archived ? "NOT " : ""}NULL`)) : db.prepare(this.taskQuery(`t.archived_at IS ${archived ? "NOT " : ""}NULL`))
        : companyId ? db.prepare(this.taskQuery(`m.user_id = ? AND t.company_id = ? AND t.archived_at IS ${archived ? "NOT " : ""}NULL`)) : db.prepare(this.taskQuery(`m.user_id = ? AND t.archived_at IS ${archived ? "NOT " : ""}NULL`));
      const result = companyId
        ? user.role === "admin" ? query.all(companyId) : query.all(actorUserId, companyId)
        : user.role === "admin" ? query.all() : query.all(actorUserId);
      return result as TaskRow[];
    });
    // One task with an unreadable legacy snapshot must not take the whole list down: skip it and log.
    const tasks = rows.flatMap((row) => {
      try {
        const task = this.taskListSummary(row);
        return task ? [task] : [];
      }
      catch (error) {
        if (error instanceof TaskFailure && error.findings.some((item) => item.code === "projection-integrity")) { console.warn("Skipping task with unreadable workflow snapshot", row.id); return []; }
        throw error;
      }
    });
    this.taskLists.set(key, { cursor: this.eventCursor, expiresAt: this.now().getTime() + 2000, tasks });
    return tasks;
  }

  async listTasksWithLiveStatus(actorUserId: string, companyId?: string, archived = false): Promise<TaskListSummary[]> {
    return await Promise.all(this.listTasks(actorUserId, companyId, archived).map(async (task) => ({ ...task, ...await this.liveStatusForTask(task.id) })));
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

  async getTaskWithLiveStatus(actorUserId: string, taskId: string): Promise<ForgeTask> {
    return { ...this.getTask(actorUserId, taskId), ...await this.liveStatusForTask(taskId) };
  }

  private async liveStatusForTask(taskId: string): Promise<{ liveStatus: Array<{ role: string; status: string }>; liveStatusObservedAt: string }> {
    const cached = this.liveStatusCache.get(taskId);
    if (cached && cached.expiresAt > this.now().getTime()) return { liveStatus: cached.liveStatus, liveStatusObservedAt: cached.observedAt };
    const observedAt = this.now().toISOString();
    let liveStatus: Array<{ role: string; status: string }> = [];
    try {
      const observations = await observeHerdrSessions(this.database, this.herdr, taskId);
      liveStatus = (await Promise.all(observations.map(async (observation) => {
        let status = observation.lifecycleStatus;
        if (!status && observation.classification === "unverifiable" && observation.agentName) {
          try { status = (await this.herdr.getAgent(observation.agentName))?.status ?? null; } catch {}
        }
        return status ? { role: observation.role, status } : undefined;
      }))).flatMap((entry) => entry ? [entry] : []);
    } catch {}
    this.liveStatusCache.set(taskId, { expiresAt: this.now().getTime() + 10_000, liveStatus, observedAt });
    return { liveStatus, liveStatusObservedAt: observedAt };
  }

  private getTaskByIdInternal(taskId: string): ForgeTask {
    const row = this.database.authQuery((db) => db.prepare(this.taskQuery("t.id = ?")).get(taskId) as TaskRow | undefined);
    if (!row) throw new TaskFailure("Not found", [], 404);
    return this.publicTask("", row);
  }

  getHermesTask(principal: HermesPrincipal, taskId: string): HermesSafeTaskProjection {
    if (principal.projectIds.length === 0) throw new TaskFailure("Not found", [], 404);
    const placeholders = principal.projectIds.map(() => "?").join(",");
    const row = this.database.authQuery((db) => db.prepare(`SELECT t.id, c.issue_code, t.issue_number, t.project_id, t.title, p.phase, p.revision, p.pending_action, t.created_at, p.updated_at
        FROM forge_tasks t
        JOIN forge_companies c ON c.id = t.company_id
        JOIN forge_issue_projections p ON p.task_id = t.id
        WHERE t.id = ? AND t.company_id = ? AND t.creator_agent_id = ? AND t.project_id IN (${placeholders})`).get(taskId, principal.companyId, principal.agentId, ...principal.projectIds) as {
        id: string; issue_code: string | null; issue_number: number | null; project_id: string; title: string;
        phase: string; revision: number; pending_action: string | null; created_at: string; updated_at: string;
      } | undefined);
    if (!row) throw new TaskFailure("Not found", [], 404);
    const issueKey = row.issue_code && row.issue_number ? `${row.issue_code}-${row.issue_number}` : null;
    return { id: row.id, issueKey, projectId: row.project_id, title: row.title, phase: row.phase as HermesSafeTaskProjection["phase"], revision: row.revision, pendingAction: row.pending_action, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  updateTaskAgents(actorUserId: string, taskId: string, partial: RoleAssignments): ForgeTask {
    const current = this.getTask(actorUserId, taskId);
    const merged = { ...current.roleAgents };
    this.database.authTransaction((db) => {
      for (const [role, agentId] of Object.entries(partial)) {
        if (!agentId) continue;
        const agent = db.prepare("SELECT id FROM forge_agents WHERE id = ? AND role = ?").get(agentId, role) as { id: string } | undefined;
        if (!agent) throw new TaskFailure("Task agent assignment is invalid", [finding("agent-ineligible", `roleAgents.${role}`, "Selected agent is unavailable or has a different role")], 422);
        merged[role as ProjectRole] = agentId;
      }
      const now = this.now().toISOString();
      // Deliberate last-write-wins: this single-user app does not need expectedRevision here.
      db.prepare("UPDATE forge_tasks SET role_agents_json = ?, updated_at = ? WHERE id = ? AND company_id = ?").run(JSON.stringify(merged), now, taskId, current.companyId);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "task_agents_updated", undefined, current.companyId, { taskId, roleAgents: JSON.stringify(partial) });
      
    });
    this.clearTaskLists();
    return this.getTask(actorUserId, taskId);
  }

  async getDeveloperDiff(actorUserId: string, taskId: string): Promise<{ diff: TaskDeveloperDiff; etag: string }> {
    const task = this.getTask(actorUserId, taskId);
    const [execution, recordedResult] = this.database.authQuery((db) => [
      db.prepare("SELECT branch_name AS branchName, worktree_path AS worktreePath, target_base_sha AS targetBaseSha, result_commit AS resultCommit FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND worktree_path IS NOT NULL ORDER BY attempt DESC, started_at DESC LIMIT 1").get(task.id, task.companyId) as { branchName: string; worktreePath: string; targetBaseSha: string | null; resultCommit: string | null } | undefined,
      db.prepare("SELECT branch_name AS branchName, target_base_sha AS targetBaseSha, result_commit AS resultCommit FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND result_commit IS NOT NULL ORDER BY attempt DESC, started_at DESC LIMIT 1").get(task.id, task.companyId) as { branchName: string; targetBaseSha: string; resultCommit: string } | undefined,
    ]);
    if (!execution) throw new TaskFailure("Developer diff is not available until a worktree exists", [], 409);
    const project = this.projects.getProject(actorUserId, task.projectId);
    if (project.companyId !== task.companyId) throw new TaskFailure("Not found", [], 404);
    const currentBaseSha = task.release?.baseSha ?? execution.targetBaseSha;
    try {
      const diff = await new WorktreeManager().liveDiff({
        repositoryPath: project.repositoryPath,
        worktreeRoot: project.worktreeRoot,
        worktreePath: execution.worktreePath,
        branchName: execution.branchName,
        targetBaseSha: currentBaseSha,
        baseBranch: project.baseBranch,
      });
      return { diff: { patch: diff.patch, branchName: diff.branchName, repository: project.repository, baseSha: diff.baseSha, headSha: diff.headSha }, etag: diff.etag };
    } catch (error) {
      if (error instanceof WorktreeFailure && error.code === "worktree-unavailable" && recordedResult) {
        const coordinates = task.release ? { branchName: task.release.headBranch, baseSha: task.release.baseSha, headSha: task.release.headSha } : { branchName: recordedResult.branchName, baseSha: recordedResult.targetBaseSha, headSha: recordedResult.resultCommit };
        const diff = await new WorktreeManager().commitDiff(project.repositoryPath, coordinates.baseSha, coordinates.headSha);
        return { diff: { patch: diff.patch, branchName: coordinates.branchName, repository: project.repository, baseSha: coordinates.baseSha, headSha: diff.headSha }, etag: `${coordinates.baseSha}:${diff.headSha}:missing:0` };
      }
      if (error instanceof WorktreeFailure) throw new TaskFailure(error.message, [finding(error.code, "developerExecution", error.message)], 409);
      throw error;
    }
  }

  async getBranchSync(actorUserId: string, taskId: string): Promise<TaskBranchSync> {
    const context = this.taskBranchContext(actorUserId, taskId);
    if (!context) return { available: false };
    try {
      return { branchName: context.branchName, worktreePath: context.worktreePath, ...await new WorktreeManager().inspectSync(context.worktreePath, context.branchName, context.baseBranch, context.conflictsWithBase) };
    } catch (error) {
      if (error instanceof WorktreeFailure && error.code === "worktree-unavailable") return { available: false, reason: "Worktree missing" };
      if (error instanceof WorktreeFailure) throw new TaskFailure(error.message, [finding(error.code, "developerExecution", error.message)], 409);
      throw error;
    }
  }

  async pushBranch(actorUserId: string, taskId: string): Promise<TaskBranchSync> {
    const context = this.taskBranchContext(actorUserId, taskId);
    if (!context) return { available: false };
    try {
      await new WorktreeManager().push(context.worktreePath, context.branchName);
      await invalidateBranchSync(context.worktreePath, context.branchName);
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : undefined;
      throw new TaskFailure(String(stderr ?? (error instanceof Error ? error.message : error)).trim().slice(0, 300), [], 409);
    }
    return this.getBranchSync(actorUserId, taskId);
  }

  private taskBranchContext(actorUserId: string, taskId: string): { branchName: string; worktreePath: string; baseBranch: string; conflictsWithBase?: boolean } | undefined {
    const task = this.getTask(actorUserId, taskId);
    const execution = this.database.authQuery((db) => db.prepare("SELECT branch_name AS branchName, worktree_path AS worktreePath FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND worktree_path IS NOT NULL ORDER BY attempt DESC, started_at DESC LIMIT 1").get(task.id, task.companyId) as { branchName: string; worktreePath: string } | undefined);
    if (!execution) return undefined;
    const project = this.projects.getProject(actorUserId, task.projectId);
    return { ...execution, baseBranch: project.baseBranch, ...(task.githubPullRequest?.exists ? { conflictsWithBase: task.githubPullRequest.mergeable === "CONFLICTING" } : {}) };
  }

  async createTask(actorUserId: string, companyId: string, input: TaskInput): Promise<{ task: ForgeTask; created: boolean }> {
    const created = await this.createTaskInternal({ kind: "user", userId: actorUserId }, companyId, input);
    if (!created.created || input.startImmediately !== true) return created;
    // A refused start keeps the durable task in backlog and does not fail creation.
    const task = await this.executeCommand(actorUserId, created.task.id, "start_planning", { expectedRevision: created.task.revision, automatic: true }).catch(() => this.getTask(actorUserId, created.task.id));
    return { task, created: true };
  }

  async duplicateTask(actorUserId: string, taskId: string, idempotencyKey: string): Promise<ForgeTask> {
    const source = this.getTask(actorUserId, taskId);
    const existing = this.database.authQuery((db) => (db.prepare("SELECT i.task_id AS taskId FROM forge_task_creation_intents i JOIN forge_tasks t ON t.id = i.task_id AND t.company_id = i.company_id WHERE i.company_id = ? AND i.idempotency_key = ?").get(source.companyId, idempotencyKey.trim()) as { taskId: string } | undefined));
    if (existing) return this.getTask(actorUserId, existing.taskId);
    const titles = this.database.authQuery((db) => db.prepare("SELECT title FROM forge_tasks WHERE company_id = ? AND project_id = ?").all(source.companyId, source.projectId) as Array<{ title: string }>);
    const usedTitles = new Set(titles.map((row) => row.title));
    const sourceArtifacts = this.database.authQuery((db) => source.images.map((image) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(image.artifactId, source.companyId) as { storage_path: string; sha256: string } | undefined));
    if (sourceArtifacts.some((artifact) => !artifact)) throw new TaskFailure("Task attachment is unavailable", [finding("attachment-unavailable", "images", "The original attachment could not be copied")], 409);
    const images = source.images.map((image, index) => ({ filename: image.filename, mimeType: image.mimeType, base64: this.artifacts.getArtifactSync({ companyId: source.companyId, storagePath: sourceArtifacts[index]!.storage_path, sha256: sourceArtifacts[index]!.sha256 }).toString("base64") }));
    const created = await this.createTask(actorUserId, source.companyId, {
      projectId: source.projectId,
      title: duplicateTitle(source.title, usedTitles),
      description: source.description,
      idempotencyKey,
      images,
      roleAgents: source.roleAgents,
      supplementalReview: source.supplementalReview,
      autoApprovePlan: source.autoApprovePlan,
      startImmediately: true,
      deliveryTarget: source.deliveryTarget,
      source: source.source?.kind === "pull_request" ? { kind: "pull_request", number: source.source.number } : source.source?.kind === "branch" ? { kind: "branch", branch: source.source.branch } : undefined,
      runProjectTests: source.executionControls.runProjectTests,
      visualEvidence: source.executionControls.visualEvidence,
    });
    return created.task;
  }

  async updateTaskDetails(actorUserId: string, taskId: string, input: TaskDetailsInput): Promise<ForgeTask> {
    const current = this.getTask(actorUserId, taskId);
    const title = input.title === undefined ? current.title : input.title.trim();
    const description = input.description === undefined ? current.description : normalizeText(input.description);
    const findings: TaskFinding[] = [];
    if (!titlePattern.test(title)) findings.push(finding("invalid-title", "title", "Title must contain 1 to 160 characters"));
    if (!description || description.length > 200_000) findings.push(finding("invalid-description", "description", "Markdown description is required and must be at most 200,000 characters"));
    if (findings.length) throw new TaskFailure("Task details are invalid", findings, 422);
    const now = this.now().toISOString();
    this.database.authTransaction((db) => {
      db.prepare("UPDATE forge_tasks SET title = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ? AND company_id = ?").run(title, input.description === undefined ? null : description, now, taskId, current.companyId);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "task_details_updated", undefined, current.companyId, { taskId, ...(input.title !== undefined ? { title } : {}), ...(input.description !== undefined ? { descriptionUpdated: "true" } : {}) });
    });
    this.clearTaskLists();
    return this.getTask(actorUserId, taskId);
  }

  async createTaskForHermes(principal: HermesPrincipal, input: { projectId: string; title: string; description: string; idempotencyKey: string }): Promise<{ task: HermesSafeTaskProjection; created: boolean }> {
    const authority: TaskCreationAuthority = { kind: "hermes", agentId: principal.agentId, companyId: principal.companyId, projectIds: principal.projectIds };
    const taskInput: TaskInput = {
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      images: [],
      supplementalReview: false,
    };
    const result = await this.createTaskInternal(authority, principal.companyId, taskInput);
    const safeTask = this.getHermesTask(principal, result.task.id);
    return { task: safeTask, created: result.created };
  }

  private async createTaskInternal(authority: TaskCreationAuthority, companyId: string, input: TaskInput): Promise<{ task: ForgeTask; created: boolean }> {
    let project: Project;
    if (authority.kind === "user") {
      const company = this.auth.requireCompanyAccess(authority.userId, companyId);
      if (company.status !== "active") throw new TaskFailure("Task creation failed", [finding("company-inactive", "companyId", "Task creation requires an active company")], 409);
      const proj = this.projects.getProject(authority.userId, input.projectId);
      if (proj.companyId !== companyId) throw new TaskFailure("Not found", [], 404);
      project = proj;
    } else {
      if (authority.companyId !== companyId) throw new TaskFailure("Not found", [], 404);
      if (!authority.projectIds.includes(input.projectId)) throw new TaskFailure("Not found", [], 404);
      const company = this.database.authQuery((db) => db.prepare("SELECT status FROM forge_companies WHERE id = ?").get(companyId) as { status: string } | undefined);
      if (!company || company.status !== "active") throw new TaskFailure("Task creation failed", [finding("company-inactive", "companyId", "Task creation requires an active company")], 409);
      const proj = this.database.authQuery((db) => db.prepare("SELECT * FROM forge_projects WHERE id = ? AND company_id = ?").get(input.projectId, companyId) as { id: string; company_id: string; name: string; repository_path: string; worktree_root: string; repository_identity: string | null; base_branch: string; target_branch: string; setup_command: string; verification_command: string; required_checks_json: string; role_defaults_json: string; created_at: string; updated_at: string } | undefined);
      if (!proj) throw new TaskFailure("Not found", [], 404);
      project = { id: proj.id, companyId: proj.company_id, name: proj.name, repositoryPath: proj.repository_path, worktreeRoot: proj.worktree_root, repository: proj.repository_identity ?? undefined, baseBranch: proj.base_branch, targetBranch: proj.target_branch, setupCommand: proj.setup_command, verificationCommand: proj.verification_command, requiredChecks: jsonRequired(proj.required_checks_json) as string[], roleDefaults: jsonRequired(proj.role_defaults_json) as RoleAssignments, createdAt: proj.created_at, updatedAt: proj.updated_at };
    }

    const validation = this.validateTaskInput(input);
    if (validation.length) throw new TaskFailure("Task brief is invalid", validation, 422);

    const roleAgents = this.resolveRoleAgents(project.roleDefaults, input.roleAgents ?? {});
    const roleProfiles = this.database.authQuery((db) => resolveAgentProfiles(db, roleAgents));
    let source;
    try { source = input.source ? await this.projects.resolveTaskSource(project, input.source) : undefined; }
    catch (error) { if (error instanceof TaskSourceFailure) throw new TaskFailure(error.message, [finding(error.code, "source", error.message)], error.statusCode); throw error; }
    const sourceBranch = source?.kind === "pull_request" ? source.headBranch : source?.kind === "branch" ? source.branch : undefined;
    if (sourceBranch) {
      const owner = this.database.authQuery((db) => db.prepare(`
        SELECT t.id, t.title
        FROM forge_tasks t
        JOIN forge_issue_projections p ON p.task_id = t.id AND p.company_id = t.company_id
        WHERE t.company_id = ? AND t.project_id = ? AND t.archived_at IS NULL AND p.phase NOT IN ('done', 'cancelled')
          AND (
            EXISTS (SELECT 1 FROM forge_issue_worktrees w WHERE w.task_id = t.id AND w.company_id = t.company_id AND w.branch_name = ?)
            OR EXISTS (SELECT 1 FROM forge_workflow_snapshots s WHERE s.task_id = t.id AND s.company_id = t.company_id AND json_extract(s.state_json, '$.branchName') = ?)
          )
        ORDER BY t.created_at
        LIMIT 1
      `).get(companyId, project.id, sourceBranch, sourceBranch) as { id: string; title: string } | undefined);
      if (owner) {
        throw new TaskFailure(
          "Branch is already being worked by another task",
          [finding("branch-owned-by-task", "source", `${owner.title} (${owner.id}) already owns ${sourceBranch}. Finish or cancel it first.`)],
          409,
          undefined,
          owner.id,
        );
      }
    }
    const branchHeads = await this.projects.captureTaskConfiguration(project);
    let promptSet: ResolvedPromptSet;
    try {
      promptSet = this.promptOverrides.resolveForProject(project.id);
    } catch {
      throw new TaskFailure("Task creation failed", [finding("prompt_overrides_unavailable", "prompts", "Prompt overrides are unavailable")], 503);
    }
    const capturedAt = this.now().toISOString();
    let taskConfiguration = TaskProjectConfigurationSchema.parse({ projectId: project.id, projectName: project.name, repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot, repository: project.repository, baseBranch: source?.kind === "pull_request" ? source.baseBranch : project.baseBranch, targetBranch: project.targetBranch, baseSha: source?.kind === "pull_request" ? source.baseSha : branchHeads.baseSha, targetSha: branchHeads.targetSha, setupCommand: project.setupCommand, verificationCommand: project.verificationCommand, requiredChecks: project.requiredChecks, roleAgents, roleProfiles, capturedAt, ...(source ? { source } : {}) });
    // Capability decisions are made from the configuration captured for this
    // task, never from a project revision that may change while it is created.
    const hasProjectTests = taskConfiguration.verificationCommand.trim().length > 0;
    const canSupplementalReview = Boolean(taskConfiguration.roleAgents.reviewer && project.roleDefaults.reviewer);
    const runProjectTests = hasProjectTests && input.runProjectTests !== false;
    const supplementalReview = canSupplementalReview && input.supplementalReview === true;
    const deliveryTarget = input.deliveryTarget ?? legacyDeliveryTarget(input.pullRequestMode ?? "draft");
    const visualEvidence = input.visualEvidence ?? "off";
    let decodedImages: Array<{ image: TaskImageInput; bytes: Buffer }>;
    try {
      decodedImages = input.images.map((image) => ({ image, bytes: this.decodeImage(image) }));
    } catch (error) {
      if (error instanceof ArtifactFailure) throw new TaskFailure("Task brief is invalid", [finding(error.code, "images", error.message)], 422);
      throw error;
    }
    const creatorId = authority.kind === "user" ? authority.userId : authority.agentId;
    const creatorAgentId = authority.kind === "hermes" ? authority.agentId : null;
    const requestHash = creationRequestHash({
      companyId,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      imageHashes: decodedImages.map(({ bytes }) => createHash("sha256").update(bytes).digest("hex")),
      roleAgents,
      supplementalReview,
      autoApprovePlan: input.autoApprovePlan === true,
      deliveryTarget,
      runProjectTests,
      visualEvidence,
      projectRevisionId: "", // replaced with the task-owned artifact once it is stored
      authorityKind: authority.kind,
      creatorId,
      ...(input.source ? { source: input.source } : {}),
    });
    const idempotencyKey = input.idempotencyKey.trim();
    const existingTask = this.database.authQuery((db) => db.prepare("SELECT t.id FROM forge_task_creation_intents i JOIN forge_tasks t ON t.id = i.task_id AND t.company_id = i.company_id WHERE i.company_id = ? AND i.idempotency_key = ?").get(companyId, idempotencyKey) as { id: string } | undefined);
    if (existingTask) return { task: this.getTaskByIdInternal(existingTask.id), created: false };

    const taskId = id("task");
    const workflowId = `${this.config.installationId ? `workflow-${this.config.installationId}` : "workflow"}-issue-${taskId}`;
    const intentId = id("creation");
    const promptArtifact = await this.artifacts.putArtifact(companyId, "task-prompt-set", { filename: `prompts-${taskId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 2, prompts: Object.fromEntries(promptSet.prompts), provenance: promptSet.provenance }), "utf8"), taskId });
    taskConfiguration = TaskProjectConfigurationSchema.parse({ ...taskConfiguration, prompts: { artifactId: promptArtifact.id, sha256: promptArtifact.sha256, overrides: promptSet.overrides } });
    const configurationArtifact = await this.artifacts.putArtifact(companyId, "task-project-configuration", { filename: `project-configuration-${taskId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(taskConfiguration), "utf8"), taskId });
    const imageArtifacts: StoredArtifact[] = [];
    try {
      for (const { image, bytes } of decodedImages) imageArtifacts.push(await this.artifacts.putArtifact(companyId, "task-image", { filename: image.filename, mimeType: image.mimeType, bytes, taskId }));
    } catch (error) {
      const artifacts = [promptArtifact, configurationArtifact, ...imageArtifacts];
      this.database.authTransaction((db) => {
        for (const artifact of artifacts) db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(artifact.id, companyId);
      });
      await Promise.all(artifacts.map((artifact) => this.artifacts.removeArtifact(artifact)));
      throw error;
    }

    const now = this.now().toISOString();
    const autoApprovePlan = input.autoApprovePlan === true && authority.kind === "user";
    const autoApprovePlanActorUserId = authority.kind === "user" && autoApprovePlan ? authority.userId : undefined;
    const pullRequestMode = deliveryTarget === "pull_request_ready" ? "ready" : deliveryTarget === "merged" ? "auto_merge" : "draft";
    const autoMergeActorUserId = authority.kind === "user" && deliveryTarget === "merged" ? authority.userId : undefined;
    const initialState = createInitialIssueWorkflowState({ issueId: taskId, companyId, projectId: input.projectId, workflowId, projectRevisionId: configurationArtifact.id, requestHash, briefArtifactId: configurationArtifact.id, briefSha256: configurationArtifact.sha256, imageArtifactIds: imageArtifacts.map((artifact) => artifact.id), roleProfiles, supplementalReview, autoApprovePlan, ...(autoApprovePlanActorUserId ? { autoApprovePlanActorUserId } : {}), pullRequestMode, ...(autoMergeActorUserId ? { autoMergeActorUserId } : {}), deliveryTarget, runProjectTests, visualEvidence, repairCycleLimit: 2 });
    const eventHash = projectionStateHash(initialState);
    const persisted = this.database.authTransaction((db) => {
      db.prepare("DELETE FROM forge_task_creation_intents WHERE company_id = ? AND idempotency_key = ? AND NOT EXISTS (SELECT 1 FROM forge_tasks t WHERE t.id = forge_task_creation_intents.task_id AND t.company_id = forge_task_creation_intents.company_id)").run(companyId, idempotencyKey);
      const receipt = db.prepare("SELECT task_id AS taskId FROM forge_task_creation_intents WHERE company_id = ? AND idempotency_key = ?").get(companyId, idempotencyKey) as { taskId: string } | undefined;
      if (receipt) return { taskId: receipt.taskId, created: false };

      const artifacts = [promptArtifact, configurationArtifact, ...imageArtifacts];
      const artifactManifest = artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, filename: artifact.filename, mimeType: artifact.mimeType, byteSize: artifact.byteSize, sha256: artifact.sha256, storagePath: artifact.storagePath }));
      db.prepare("INSERT INTO forge_task_creation_intents (id, company_id, project_id, task_id, workflow_id, idempotency_key, project_revision_id, creator_agent_id, artifact_ids_json, artifact_manifest_json, lease_token, lease_expires_at, state, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'started', 0, ?, ?)").run(intentId, companyId, input.projectId, taskId, workflowId, idempotencyKey, configurationArtifact.id, creatorAgentId, JSON.stringify(artifacts.map((artifact) => artifact.id)), JSON.stringify(artifactManifest), now, now);
      db.prepare(`INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, description, image_artifact_ids_json, role_agents_json, supplemental_review, auto_approve_plan, pull_request_mode, delivery_target, run_project_tests, visual_evidence, workflow_id, project_revision_id, project_configuration_artifact_id, project_configuration_captured_at, idempotency_key, request_hash, creator_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, companyId, input.projectId, input.title.trim(), configurationArtifact.id, normalizeText(input.description), JSON.stringify(imageArtifacts.map((artifact) => artifact.id)), JSON.stringify(roleAgents), supplementalReview ? 1 : 0, autoApprovePlan ? 1 : 0, pullRequestMode, deliveryTarget, runProjectTests ? 1 : 0, visualEvidence, workflowId, configurationArtifact.id, configurationArtifact.id, capturedAt, idempotencyKey, requestHash, creatorAgentId, now, now);
      db.prepare(`INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, step, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, authoritative_event_hash, projected_at) VALUES (?, ?, ?, ?, 0, 'backlog', 'backlog', 'human', ?, ?, ?, ?, ?, 0, ?, ?)`).run(taskId, companyId, input.projectId, workflowId, JSON.stringify(["start_planning"]), "Start planning", now, `${workflowId}:0`, eventHash, eventHash, now);
      db.prepare(`INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, 0, 'workflow', 'task_created', ?, ?, ?)`).run(`${workflowId}:0`, taskId, companyId, workflowId, JSON.stringify({ revision: 0, stateHash: eventHash }), now, eventHash);
      db.prepare(`INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, 0, ?, ?)`).run(taskId, companyId, workflowId, JSON.stringify(initialState), now);
      if (authority.kind === "user") this.auth.recordAuditEventInTransaction(db, authority.userId, "task_created", undefined, companyId, { taskId, projectId: input.projectId, workflowId });
      else this.auth.recordAgentAuditEventInTransaction(db, authority.agentId, "task_created", undefined, companyId, { taskId, projectId: input.projectId, workflowId });
      return { taskId, created: true };
    });
    const artifacts = [promptArtifact, configurationArtifact, ...imageArtifacts];
    if (!persisted.created) {
      this.database.authTransaction((db) => {
        for (const artifact of artifacts) db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(artifact.id, companyId);
      });
      await Promise.all(artifacts.map((artifact) => this.artifacts.removeArtifact(artifact)));
      return { task: this.getTaskByIdInternal(persisted.taskId), created: false };
    }

    try {
      await this.workflow.start({ companyId, projectId: input.projectId, issueId: taskId, projectRevisionId: configurationArtifact.id, briefArtifactId: configurationArtifact.id, briefSha256: configurationArtifact.sha256, imageArtifactIds: imageArtifacts.map((artifact) => artifact.id), requestHash, roleProfiles, supplementalReview, autoApprovePlan, ...(autoApprovePlanActorUserId ? { autoApprovePlanActorUserId } : {}), pullRequestMode, ...(autoMergeActorUserId ? { autoMergeActorUserId } : {}), deliveryTarget, runProjectTests, visualEvidence, repairCycleLimit: this.config.deliveryRepairCycleLimit, workflowId, repository: taskConfiguration.repository, ...(taskConfiguration.source ? { source: taskConfiguration.source } : {}) });
    } catch (error) {
      this.database.authTransaction((db) => {
        db.prepare("DELETE FROM forge_tasks WHERE id = ? AND company_id = ?").run(taskId, companyId);
        db.prepare("DELETE FROM forge_task_creation_intents WHERE id = ?").run(intentId);
        for (const artifact of artifacts) db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(artifact.id, companyId);
      });
      await Promise.all(artifacts.map((artifact) => this.artifacts.removeArtifact(artifact)));
      throw error;
    }
    this.clearTaskLists();
    return { task: this.getTaskByIdInternal(taskId), created: true };
  }

  private async waitForProjection(taskId: string, minimumRevision: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const projection = this.database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = ?").get(taskId) as { revision: number } | undefined);
      if (projection && projection.revision >= minimumRevision) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Workflow projection did not become available");
  }

  private async awaitAccepted(taskId: string, expectedRevision: number, pending: Promise<IssueWorkflowState>): Promise<number> {
    pending.catch(() => undefined);
    const accepted = await Promise.race([
      pending.then((state) => ({ kind: "state" as const, state }), (error) => ({ kind: "workflow-error" as const, error })),
      this.waitForProjection(taskId, expectedRevision + 1).then(() => ({ kind: "projection" as const }), (error) => ({ kind: "projection-error" as const, error })),
    ]);
    if (accepted.kind === "state") return accepted.state.revision;
    if (accepted.kind === "workflow-error") throw accepted.error;
    if (accepted.kind === "projection") return expectedRevision + 1;
    return (await pending).revision;
  }

  async resolveDecisionBlocker(actorUserId: string, taskId: string, expectedRevision: number, answer: string): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    const normalizedAnswer = normalizeText(answer);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before answering the Lead")], 409);
    const blockerOutput = task.leadOutput;
    if (!task.allowedCommands.includes("resolve_decision_blocker") || !task.blocked || blockerOutput?.kind !== "decision_blocker") throw new TaskFailure("A decision blocker is not available", [finding("illegal-command", "phase", "This task is not waiting for a human decision")], 409);
    if (normalizedAnswer.length < 1 || normalizedAnswer.length > 8_000) throw new TaskFailure("Decision answer must contain 1 to 8,000 characters", [finding("invalid-answer", "answer", "Provide a concise decision")], 422);
    const blocker = this.database.authQuery((db) => db.prepare("SELECT sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'decision-blocker'").get(blockerOutput.outputArtifactId, task.companyId) as { sha256: string } | undefined);
    if (!blocker) throw new TaskFailure("Decision blocker evidence is unavailable", [], 409);
    const artifact = await this.artifacts.putArtifact(task.companyId, "decision-answer", { filename: `decision-answer-${task.id}.md`, mimeType: "text/markdown", bytes: Buffer.from(normalizedAnswer, "utf8") });
    try {
      const input: ResolveDecisionBlockerInput = { expectedRevision, actorUserId, answerArtifactId: artifact.id };
      const state = await this.workflow.resolveDecisionBlocker(task.workflowId, input);
      this.recordTaskCommand(task, actorUserId, "resolve_decision_blocker", state.revision);
    } catch (error) {
      this.database.authTransaction((db) => db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(artifact.id, task.companyId));
      await this.artifacts.removeArtifact({ companyId: artifact.companyId, storagePath: artifact.storagePath });
      const message = error instanceof Error && /stale workflow revision/i.test(error.message) ? "Task changed before this action was accepted" : "Decision blocker could not be resolved";
      throw new TaskFailure(message, [finding("workflow-update-rejected", "expectedRevision", message)], 409);
    }
    await this.waitForProjection(taskId, expectedRevision + 1);
    return this.getTask(actorUserId, taskId);
  }

  private cancelProjectionAfterWorkflowEnded(task: ForgeTask): void {
    const snapshot = this.database.authQuery((db) => db.prepare(`SELECT state_json, run_id AS runId
      FROM forge_workflow_snapshots
      WHERE task_id = ? AND workflow_id = ?
      ORDER BY revision DESC LIMIT 1`).get(task.id, task.workflowId) as { state_json: string; runId: string | null } | undefined);
    if (!snapshot) throw new TaskFailure("Issue cancellation could not be reconciled", [finding("workflow-not-running", "workflow", "The workflow ended before Forge recorded a cancellable state")], 409, task);
    let stored: unknown;
    try { stored = jsonRequired(snapshot.state_json); } catch {
      throw new TaskFailure("Issue cancellation could not be reconciled", [finding("projection-invalid", "workflow", "The last workflow state cannot be read")], 409, task);
    }
    const state = IssueWorkflowStateSchema.parse(stored);
    if (state.revision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409, task);
    const next = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("cancelled"), owner: "human", allowedCommands: [], pendingAction: "Task cancelled", blocker: null, capacity: null, capacityBlocker: null, activeOperation: null, stateChangedAt: this.now().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    this.database.projectIssueEvent({ schemaVersion: 1, runId: snapshot.runId ?? state.workflowId, eventId: next.lastEventId, state: next });
  }

  async executeCommand(actorUserId: string, taskId: string, command: IssueCommand, payload: TaskCommandPayload): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    const allowedCommands = derivedAllowedCommands(task.phase, task.allowedCommands, task.planRevision, task.planHistory.some((plan) => plan.kind === "plan"), Boolean(task.successorTaskId));
    const descriptor = issueCommands[command];
    if (descriptor.family === "bespoke" && command !== "delete_worktree" && command !== "recreate_worktree") throw new TaskFailure("This command requires its dedicated action", [finding("workflow-unavailable", "workflow", "The durable issue workflow is unavailable")], 503, task);
    const expectedRevision = payload.expectedRevision;
    if (!Number.isInteger(expectedRevision) || (command !== "cancel_issue" && expectedRevision !== task.revision)) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409, task);
    const retryingCancellation = command === "cancel_development" && task.developerRecovery?.status === "cancellation_requested";
    const canContinuePastReview = command === "record_delivery_decision" && task.step === "repair_required";
    const canDeleteTerminalWorktree = command === "delete_worktree" && TERMINAL_PHASES.has(task.phase);
    const retryingLegacyConflictPlan = command === "resolve_merge_conflict" && task.step === "merge_conflict_resolving" && task.pendingAction === "The Planner did not plan the fix. Retry, or inspect the task.";
    if (command !== "cancel_issue" && !allowedCommands.includes(command) && !retryingCancellation && !canContinuePastReview && !canDeleteTerminalWorktree && !retryingLegacyConflictPlan) {
      const message = command === "start_planning" ? "Planning cannot start from the current state" : command === "record_delivery_decision" ? "A delivery decision is not available" : descriptor.family === "start" ? "Plan action is not available" : "Task action is not available";
      throw new TaskFailure(message, [finding("illegal-command", "phase", message)], 409, task);
    }
    const planInput: PlanCommandInput = {
      expectedRevision,
      actorUserId,
      ...(payload.note !== undefined ? { note: payload.note } : {}),
      ...(payload.idempotencyKey !== undefined ? { idempotencyKey: payload.idempotencyKey } : {}),
      ...(command === "respond_plan_blocker" ? { expectedWorkflowRevision: expectedRevision } : {}),
    };
    if (command === "approve_plan" || command === "request_plan_revision" || command === "respond_plan_blocker") return this.exactDecisionCommand(actorUserId, taskId, planInput, command);
    const plannerNote = command === "send_planner_note"
      ? (() => {
        const commandId = payload.commandId ?? randomUUID();
        const note = (redact((payload.note ?? "").trim()) as string).trim();
        if (!note) throw new TaskFailure("Planner feedback is required", [finding("invalid-note", "note", "Enter a note for the Planner")], 422, task);
        const noteId = `planner_note_${commandId}`;
        const noteSha256 = createHash("sha256").update(note).digest("hex");
        this.database.authTransaction((db) => db.prepare("INSERT INTO forge_planner_notes (id, task_id, company_id, revision, actor, note, created_at, forward_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(id) DO NOTHING").run(noteId, task.id, task.companyId, expectedRevision, actorUserId, note, this.now().toISOString()));
        return { commandId, noteId, noteSha256 };
      })()
      : undefined;
    const deliveryChangesNote = command === "request_delivery_changes"
      ? await this.stageDeliveryChangesNote(task, payload.note)
      : undefined;
    const input: StartPlanningInput | PlanCommandInput | SendPlannerNoteInput | WorktreeCommandInput = plannerNote
      ? { expectedRevision, actorUserId, ...plannerNote }
      : deliveryChangesNote
      ? { expectedRevision, actorUserId, noteId: deliveryChangesNote.ref, noteSha256: deliveryChangesNote.sha256, ...(payload.idempotencyKey !== undefined ? { idempotencyKey: payload.idempotencyKey } : {}) }
      : descriptor.family === "start"
      ? { expectedRevision, actorUserId, commandId: payload.commandId ?? randomUUID(), ...(command !== "start_planning" && task.planAuthorizationId ? { planAuthorizationId: task.planAuthorizationId } : {}) }
      : (command === "delete_worktree" || command === "recreate_worktree")
      ? { expectedRevision, actorUserId, ...(payload.confirmDiscardDirty !== undefined ? { confirmDiscardDirty: payload.confirmDiscardDirty } : {}) }
      : planInput;
    try {
      const acceptedStart = command === "start_planning" && this.workflow.acceptPlanning
        || (command === "start_development" || command === "retry_development") && this.workflow.acceptDevelopment;
      const pending = command === "start_planning" && this.workflow.acceptPlanning
        ? this.workflow.acceptPlanning(task.workflowId, input as StartPlanningInput)
        : (command === "start_development" || command === "retry_development") && this.workflow.acceptDevelopment
          ? this.workflow.acceptDevelopment(task.workflowId, input as StartPlanningInput, command)
          : (command === "delete_worktree" || command === "recreate_worktree") && this.workflow.worktreeCommand
            ? this.workflow.worktreeCommand(command, task.workflowId, input as WorktreeCommandInput)
            : this.workflow.execute(command, task.workflowId, input as StartPlanningInput | PlanCommandInput | SendPlannerNoteInput);
      const revision = acceptedStart
        ? await this.awaitAccepted(taskId, expectedRevision, pending)
        : (await pending).revision;
      if (command !== "cancel_issue" && command !== "send_planner_note" && revision <= expectedRevision) {
        throw new Error("Stale workflow revision");
      }
      this.recordTaskCommand(task, actorUserId, command, revision, payload.automatic === true);
      return this.getTask(actorUserId, taskId);
    } catch (error) {
      if (command === "cancel_issue" && !workflowCancellationFailureIsTransient(error)) {
        this.cancelProjectionAfterWorkflowEnded(task);
        this.recordTaskCommand(task, actorUserId, command, task.revision + 1, payload.automatic === true);
        return this.getTask(actorUserId, taskId);
      }
      const stale = error instanceof Error && /stale workflow revision/i.test(error.message);
      const current = this.getTask(actorUserId, taskId);
      const handlerReason = current.lastHandlerError?.reason;
      const projectionDisagrees = !current.allowedCommands.includes(command);
      const message = stale ? "Task changed before this action was accepted" : projectionDisagrees ? "Refresh — this action is no longer available" : handlerReason ?? (command === "start_planning" ? "Planning command could not be accepted" : command === "record_delivery_decision" ? "Delivery decision could not be accepted" : descriptor.family === "start" ? "Plan action could not be accepted" : "Task action could not be accepted");
      throw new TaskFailure(message, [finding(stale ? "stale-revision" : "workflow-update-rejected", stale ? "expectedRevision" : "workflow", message)], 409, current);
    }
  }

  private async stageDeliveryChangesNote(task: ForgeTask, value: string | undefined) {
    const note = (redact((value ?? "").trim()) as string).trim();
    if (!note) throw new TaskFailure("Delivery feedback is required", [finding("invalid-note", "note", "Enter the requested changes")], 422, task);
    return this.artifacts.stage(task.companyId, "delivery-changes-note", { filename: `delivery-changes-${task.id}.md`, mimeType: "text/markdown", bytes: Buffer.from(note, "utf8") });
  }

  async revisePlan(actorUserId: string, taskId: string, input: PlanRevisionCommand): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    if (input.actorUserId !== actorUserId) throw new TaskFailure("Plan revision is unavailable", [finding("actor-mismatch", "actorUserId", "Authenticated actor does not match the revision request")], 403, task);
    if (input.expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before revising the plan")], 409, task);
    try {
      const state = await this.workflow.revisePlan(task.workflowId, input);
      this.recordTaskCommand(task, actorUserId, "revise_plan", state.revision);
      return this.getTask(actorUserId, taskId);
    } catch (error) {
      const stale = error instanceof Error && /stale workflow revision/i.test(error.message);
      throw new TaskFailure(stale ? "Task changed before this action was accepted" : "Plan revision could not be accepted", [finding(stale ? "stale-revision" : "workflow-update-rejected", "expectedRevision", stale ? "Refresh the issue before revising the plan" : "The durable plan revision was not accepted")], 409, this.getTask(actorUserId, taskId));
    }
  }

  async requestPlanRevision(actorUserId: string, taskId: string, input: PlanCommandInput): Promise<ForgeTask> {
    return this.executeCommand(actorUserId, taskId, "request_plan_revision", { expectedRevision: input.expectedRevision, ...(input.note !== undefined ? { note: input.note } : {}), ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}) });
  }

  private async exactDecisionCommand(actorUserId: string, taskId: string, input: PlanCommandInput, commandName: "approve_plan" | "request_plan_revision" | "respond_plan_blocker"): Promise<ForgeTask> {
    const task = this.getTask(actorUserId, taskId);
    const boundInput = input;
    const isBlocker = commandName === "respond_plan_blocker";
    const note = boundInput.note;
    if (boundInput.expectedRevision !== task.revision || !task.allowedCommands.includes(commandName)) throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before this action")], 409, task);
    if (!note?.trim()) throw new TaskFailure("A decision note is required", [finding("required-note", isBlocker ? "answer" : "note", "Enter a concise response")], 422);
    const workflowInput: PlanCommandInput = { expectedRevision: boundInput.expectedRevision, actorUserId, commandId: crypto.randomUUID(), ...(note ? { note } : {}) };
    try {
      let state = await this.workflow.execute(commandName, task.workflowId, workflowInput);
      this.recordTaskCommand(task, actorUserId, commandName, state.revision);
      if (commandName === "approve_plan" && state.step === "ready_for_development") {
        const startInput: StartPlanningInput = { expectedRevision: state.revision, actorUserId };
        try {
          state = this.workflow.acceptDevelopment
            ? await this.workflow.acceptDevelopment(task.workflowId, startInput)
            : await this.workflow.execute("start_development", task.workflowId, startInput);
          this.recordTaskCommand(task, actorUserId, "start_development", state.revision);
        } catch {
          // Approval is durable; retain its existing manual retry action if Developer admission is temporarily unavailable.
        }
      }
      return this.getTask(actorUserId, taskId);
    } catch (error) {
      const stale = error instanceof Error && /stale|subject|conflict/i.test(error.message);
      const current = this.getTask(actorUserId, taskId);
      const message = stale ? "Task changed before this action was accepted" : current.lastHandlerError?.reason ?? "Task action could not be accepted";
      throw new TaskFailure(message, [finding(stale ? "stale-revision" : "workflow-update-rejected", stale ? "expectedRevision" : "workflow", message)], 409, current);
    }
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
      throw new TaskFailure("Task changed before this action was accepted", [finding("stale-revision", "expectedRevision", "Refresh the issue before continuing work")], 409, original);
    }
    try {
      const state = await this.workflow.continueWork(original.workflowId, { expectedRevision, actorUserId, reason });
      this.recordTaskCommand(original, actorUserId, "continue_work", state.revision);
      const successorId = state.successorReference?.successorTaskId ?? state.successorTaskId;
      if (!successorId) throw new Error("Continuation did not create a successor task");
      return { original: this.getTask(actorUserId, original.id), successor: this.getTask(actorUserId, successorId) };
    } catch (error) {
      if (error instanceof TaskFailure) throw error;
      const stale = error instanceof Error && /stale workflow revision/i.test(error.message);
      if (stale) {
        const intent = continuationIntent();
        if (isSameRequest(intent) && intent.state === "linked") return { original: this.getTask(actorUserId, taskId), successor: this.getTask(actorUserId, intent.successorTaskId) };
      }
      throw new TaskFailure(stale ? "Task changed before this action was accepted" : "Continue work could not be accepted", [finding(stale ? "stale-revision" : "workflow-update-rejected", "expectedRevision", stale ? "Refresh the issue before continuing work" : "The durable successor was not accepted")], 409, this.getTask(actorUserId, taskId));
    }
  }
  private recordTaskCommand(task: ForgeTask, actorUserId: string, command: IssueCommand, revision: number, automatic = false): void {
    this.auth.recordAuditEvent(actorUserId, "task_command", undefined, task.companyId, { taskId: task.id, workflowId: task.workflowId, command, actionLabel: issueCommands[command].label, revision: String(revision), ...(automatic ? { automatic: "true" } : {}) });
    this.clearTaskLists();
  }

  async getTaskImage(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: TaskImage; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const artifact = this.database.authQuery((db) => db.prepare("SELECT id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-image'").get(artifactId, task.companyId) as ArtifactRow | undefined);
    if (!artifact || !parseImageIds(JSON.stringify(task.images.map((image) => image.artifactId))).includes(artifactId)) throw new TaskFailure("Not found", [], 404);
    const bytes = await this.artifacts.getArtifact({ companyId: task.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 });
    return { artifact: { artifactId: artifact.id, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }, bytes };
  }

  async getDeveloperArtifact(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: StoredArtifact; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const artifact = this.database.authQuery((db) => db.prepare(`SELECT a.id, a.company_id AS companyId, a.kind, a.filename, a.mime_type AS mimeType, a.byte_size AS byteSize, a.sha256, a.storage_path AS storagePath, a.created_at AS createdAt
      FROM forge_artifacts a JOIN forge_developer_executions e ON (e.delivery_artifact_id = a.id OR e.evidence_artifact_id = a.id)
      WHERE e.task_id = ? AND e.company_id = ? AND a.id = ? AND a.company_id = ?`).get(task.id, task.companyId, artifactId, task.companyId) as StoredArtifact | undefined);
    if (!artifact) throw new TaskFailure("Not found", [], 404);
    return { artifact, bytes: await this.artifacts.getArtifact({ companyId: artifact.companyId, storagePath: artifact.storagePath, sha256: artifact.sha256 }) };
  }

  getDeveloperExecutionEvents(actorUserId: string, taskId: string, executionId: string, limit = 100): { events: DeveloperExecutionEvent[]; hasMore: boolean } {
    this.getTask(actorUserId, taskId);
    void executionId;
    void limit;
    throw new TaskFailure("Not found", [], 404);
  }

  getAgentEventHistory(actorUserId: string, taskId: string, after = 0, limit = 200): { events: ReturnType<IssueTimelineEvents["history"]>; status: { phase: string; terminal: boolean; revision: number } } {
    const task = this.getTask(actorUserId, taskId);
    return { events: new IssueTimelineEvents(this.database).history(task.id, after, Math.min(limit, 200)), status: { phase: task.phase, terminal: TERMINAL_PHASES.has(task.phase), revision: task.revision } };
  }

  getTaskActivity(actorUserId: string, taskId: string, limit = 200): { execution: { id: string; role: "planner" | "builder" | "reviewer" | "integrator"; status: string; currentStep: string | null } | null; events: TaskActivityEvent[]; commands: Array<{ id: string; stepId: string; command: string; cwd: string | null; exitCode: number | null; durationMs: number; stdout: string; stderr: string; entries: Array<{ stream: "stdout" | "stderr"; text: string }>; at: string }> } {
    const task = this.getTask(actorUserId, taskId);
    const commands = this.database.authQuery((db) => db.prepare("SELECT id, step_id AS stepId, command, cwd, exit_code AS exitCode, duration_ms AS durationMs, stdout, stderr, entries_json AS entriesJson, finished_at AS at FROM forge_task_command_activity WHERE task_id = ? ORDER BY finished_at DESC LIMIT 50").all(task.id) as Array<{ id: string; stepId: string; command: string; cwd: string | null; exitCode: number | null; durationMs: number; stdout: string; stderr: string; entriesJson: string; at: string }>).map((row) => ({ id: row.id, stepId: row.stepId, command: row.command, cwd: row.cwd, exitCode: row.exitCode, durationMs: row.durationMs, stdout: row.stdout, stderr: row.stderr, at: row.at, entries: (json<Array<{ stream?: unknown; text?: unknown }>>(row.entriesJson, [])).flatMap((entry): Array<{ stream: "stdout" | "stderr"; text: string }> => (entry.stream === "stdout" || entry.stream === "stderr") && typeof entry.text === "string" ? [{ stream: entry.stream, text: entry.text }] : []) }));
    const execution = this.database.authQuery((db) => db.prepare(`SELECT id, role, status, currentStep FROM (
      SELECT id, 'builder' AS role, status, current_step AS currentStep, started_at AS startedAt FROM forge_developer_executions WHERE task_id = ? AND company_id = ?
      UNION ALL
      SELECT id, role, status, NULL AS currentStep, started_at AS startedAt FROM forge_agent_executions WHERE task_id = ? AND company_id = ?
    ) ORDER BY CASE WHEN status IN ('starting', 'running', 'active', 'reconnecting', 'cancelling', 'result_pending_claim') THEN 0 ELSE 1 END, startedAt DESC LIMIT 1`).get(task.id, task.companyId, task.id, task.companyId) as { id: string; role: "planner" | "builder" | "reviewer" | "integrator"; status: string; currentStep: string | number | null } | undefined);
    if (!execution || !["starting", "running", "active", "reconnecting", "cancelling", "result_pending_claim"].includes(execution.status) || !/^[A-Za-z0-9_-]+$/.test(execution.id)) return { execution: null, events: [], commands };
    const currentStep = execution.currentStep === null ? null : String(execution.currentStep);
    const status = execution.status === "running" || execution.status === "active" ? `${execution.role[0]!.toUpperCase()}${execution.role.slice(1)} is working${currentStep ? `: ${currentStep}` : ""}` : `${execution.role[0]!.toUpperCase()}${execution.role.slice(1)}: ${execution.status}`;
    const statusEvent: TaskActivityEvent = { at: new Date().toISOString(), kind: "status", text: String(redact(status)) };
    void limit;
    return { execution: { ...execution, currentStep }, events: [statusEvent], commands };
  }

  getDeveloperProgress(actorUserId: string, taskId: string, after?: { executionId: string; sequence: number }): { status: string; execution: { id: string | null; status: string; startedAt: string; finishedAt: string | null; lastHeartbeatAt: string | null; currentStep: string | null } | null; events: DeveloperExecutionEvent[] } {
    const task = this.getTask(actorUserId, taskId);
    const execution = this.database.authQuery((db) => db.prepare(`SELECT e.id, e.status, e.started_at AS startedAt, e.finished_at AS finishedAt,
      e.heartbeat_at AS lastHeartbeatAt, e.current_step AS currentStep
      FROM forge_developer_executions e
      WHERE e.task_id = ? AND e.company_id = ? ORDER BY e.attempt DESC, e.started_at DESC LIMIT 1`).get(task.id, task.companyId) as { id: string; status: string; startedAt: string; finishedAt: string | null; lastHeartbeatAt: string | null; currentStep: string | null } | undefined);
    if (!execution) {
      const snapshot = this.database.authQuery((db) => db.prepare("SELECT state_json AS stateJson FROM forge_workflow_snapshots WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY revision DESC LIMIT 1").get(task.id, task.companyId, task.workflowId) as { stateJson: string } | undefined);
      const state = snapshot ? IssueWorkflowStateSchema.safeParse(json<unknown>(snapshot.stateJson, null)).data : undefined;
      const recovery = state?.developerRecoveryStatus ?? task.developerRecovery?.status;
      const heartbeat = state?.developerLastHeartbeatAt ?? task.developerRecovery?.lastHeartbeatAt ?? null;
      const status = recovery === "starting" ? "starting" : recovery === "cancelling" || recovery === "cancellation_requested" ? "cancelling" : recovery === "active" || recovery === "reconnecting" || recovery === "result_pending_claim" ? "running" : recovery === "failed" || recovery === "interrupted" ? "failed" : task.capacity?.status === "queued" ? "queued" : task.capacity?.status === "rate_limited" ? "rate_limited" : "idle";
      return status === "idle" ? { status, execution: null, events: [] } : { status, execution: { id: null, status, startedAt: state?.stateChangedAt ?? task.updatedAt, finishedAt: null, lastHeartbeatAt: heartbeat, currentStep: null }, events: [] };
    }
    void after;
    const status = execution.status;
    return { status, execution: { ...execution, status }, events: [] };
  }

  getPlanningProgress(actorUserId: string, taskId: string, after?: { executionId: string; sequence: number }): { status: string; execution: AgentProgressExecution | null; events: DeveloperExecutionEvent[] } {
    const task = this.getTask(actorUserId, taskId);
    const execution = this.database.authQuery((db) => db.prepare(`SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, heartbeat_at AS lastHeartbeatAt
      FROM forge_agent_executions WHERE task_id = ? AND company_id = ? AND role = 'planner' AND purpose = 'planning' ORDER BY started_at DESC LIMIT 1`).get(task.id, task.companyId) as { id: string; status: string; startedAt: string; finishedAt: string | null; lastHeartbeatAt: string | null } | undefined);
    if (!execution) return { status: "idle", execution: null, events: [] };
    const status = execution.status;
    const progress: AgentProgressExecution = { id: execution.id, status, startedAt: execution.startedAt, finishedAt: execution.finishedAt, lastHeartbeatAt: execution.lastHeartbeatAt, lastOutputAt: null, currentStep: null };
    if (after?.executionId === execution.id && execution.finishedAt) return { status, execution: progress, events: [] };
    return { status, execution: progress, events: [] };
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
    const bytes = await this.artifacts.getArtifact({ companyId: artifact.company_id, storagePath: artifact.storage_path, sha256: artifact.sha256 });
    return { artifact: { artifactId: artifact.id, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }, bytes };
  }

  async getTaskArtifact(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: { artifactId: string; kind: string; filename: string; mimeType: string; byteSize: number }; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    try {
      const proof = this.browserProof.readForDownload(task.id, task.companyId, artifactId);
      if (proof) return { artifact: { artifactId, kind: proof.kind, filename: proof.filename, mimeType: proof.mimeType, byteSize: proof.bytes.length }, bytes: proof.bytes };
    } catch { throw new TaskFailure("Not found", [], 404); }
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
        EXISTS (SELECT 1 FROM forge_agent_executions o WHERE (o.output_artifact_id = a.id OR o.evidence_artifact_id = a.id) AND o.task_id = ? AND o.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_agent_executions e WHERE e.evidence_artifact_id = a.id AND e.task_id = ? AND e.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_plan_reviews r WHERE (r.opinion_artifact_id = a.id OR r.evidence_artifact_id = a.id) AND r.task_id = ? AND r.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_plan_decisions d WHERE d.note_artifact_id = a.id AND d.task_id = ? AND d.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_plan_revision_requests rr WHERE rr.reason_artifact_id = a.id AND rr.task_id = ? AND rr.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_developer_executions de WHERE (de.delivery_artifact_id = a.id OR de.evidence_artifact_id = a.id) AND de.task_id = ? AND de.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_delivery_reviews dr WHERE (dr.opinion_artifact_id = a.id OR dr.evidence_artifact_id = a.id) AND dr.task_id = ? AND dr.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_delivery_decisions dd WHERE dd.artifact_id = a.id AND dd.task_id = ? AND dd.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_successor_intents si WHERE si.reason_artifact_id = a.id AND si.predecessor_task_id = ? AND si.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_ci_attempts ca JOIN forge_ci_runs cr ON cr.id = ca.run_id WHERE ca.evidence_artifact_id = a.id AND cr.task_id = ? AND cr.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_ci_repair_plans cp WHERE (cp.plan_artifact_id = a.id OR cp.evidence_artifact_id = a.id) AND cp.task_id = ? AND cp.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_ci_repairs cx JOIN forge_ci_repair_plans cp ON cp.id = cx.repair_plan_id WHERE (cx.delivery_artifact_id = a.id OR cx.evidence_artifact_id = a.id) AND cp.task_id = ? AND cp.company_id = ?)
        OR EXISTS (SELECT 1 FROM forge_herdr_turns ht WHERE ht.task_id = ? AND (ht.rollout_artifact_id = a.id OR ht.result_artifact_id = a.id))
      )`).get(artifactId, task.companyId, ...Array.from({ length: 12 }, () => [task.id, task.companyId]).flat(), task.id) as { id: string; kind: string; filename: string; mime_type: string; byte_size: number; storage_path: string; sha256: string } | undefined);
    if (!artifact) throw new TaskFailure("Not found", [], 404);
    const bytes = await this.artifacts.getArtifact({ companyId: task.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 });
    return { artifact: { artifactId: artifact.id, kind: artifact.kind, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }, bytes };
  }

  async getTargetBaseArtifact(actorUserId: string, taskId: string, artifactId: string): Promise<{ artifact: { artifactId: string; filename: string; mimeType: string; byteSize: number }; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const allowed = this.database.authQuery((db) => db.prepare(`SELECT a.id, a.company_id, a.filename, a.mime_type, a.byte_size, a.storage_path, a.sha256
      FROM forge_artifacts a JOIN forge_forward_merges m ON m.company_id = a.company_id AND (m.conflict_artifact_id = a.id OR m.verification_artifact_id = a.id OR m.delivery_artifact_id = a.id)
      WHERE m.task_id = ? AND m.company_id = ? AND a.id = ? AND a.kind IN ('forward-merge-conflict', 'forward-merge-verification', 'forward-merge-delivery')`).get(task.id, task.companyId, artifactId) as ArtifactRow | undefined);
    if (!allowed) throw new TaskFailure("Not found", [], 404);
    try {
      const bytes = await this.artifacts.getArtifact({ companyId: allowed.company_id, storagePath: allowed.storage_path, sha256: allowed.sha256 });
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
    if (!Array.isArray(input.images) || input.images.length > MAX_TASK_IMAGES) findings.push(finding("invalid-images", "images", "At most eight images may be attached"));
    if (input.deliveryTarget !== undefined && !["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"].includes(input.deliveryTarget)) findings.push(finding("invalid-delivery-target", "deliveryTarget", "Delivery target is unavailable"));
    if (input.visualEvidence !== undefined && !["off", "capture", "required"].includes(input.visualEvidence)) findings.push(finding("invalid-visual-evidence", "visualEvidence", "Visual evidence setting is unavailable"));
    if (input.runProjectTests !== undefined && typeof input.runProjectTests !== "boolean") findings.push(finding("invalid-project-tests", "runProjectTests", "Project test setting must be enabled or disabled"));
    if (input.supplementalReview !== undefined && typeof input.supplementalReview !== "boolean") findings.push(finding("invalid-supplemental-review", "supplementalReview", "Second review setting must be enabled or disabled"));
    for (const image of input.images) {
      if (!imageMimeTypes.has(image.mimeType)) findings.push(finding("invalid-image-type", "images", "Only PNG, JPEG, WebP, and GIF images are accepted"));
      if (!image.filename || image.filename.includes("/") || image.filename.includes("\\") || image.filename.includes("..")) findings.push(finding("invalid-image-filename", "images", "Image filenames cannot contain paths"));
      if (typeof image.base64 !== "string" || image.base64.length > MAX_TASK_IMAGE_BASE64_LENGTH) findings.push(finding("invalid-image-data", "images", "Image data is invalid or too large"));
    }
    return findings;
  }

  private resolveRoleAgents(defaults: RoleAssignments, overrides: RoleAssignments): RoleAssignments {
    const result: RoleAssignments = { ...defaults };
    this.database.authQuery((db) => {
      for (const role of ["planner", "builder", "reviewer", "integrator"] as const) {
        const selected = overrides[role];
        if (selected !== undefined) {
          // An empty selection is the explicit "None" choice for an optional role.
          if (selected === "") { delete result[role]; continue; }
          const agent = db.prepare("SELECT id FROM forge_agents WHERE id = ? AND role = ?").get(selected, role) as { id: string } | undefined;
          if (!agent) throw new TaskFailure("Task brief is invalid", [finding("agent-ineligible", `roleAgents.${role}`, "Selected agent is unavailable or has a different role")], 422);
          result[role] = selected;
        }
        if (!result[role]) {
          if (role === "builder") throw new TaskFailure("Task brief is invalid", [finding("missing-agent", "roleAgents.builder", "A Builder agent is required")], 422);
          continue;
        }
        const assigned = db.prepare("SELECT id FROM forge_agents WHERE id = ? AND role = ?").get(result[role], role) as { id: string } | undefined;
        if (!assigned) throw new TaskFailure("Task brief is invalid", [finding("agent-ineligible", `roleAgents.${role}`, "Assigned agent is unavailable or has a different role")], 422);
      }
    });
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
      if (!bytes.length || bytes.length > MAX_TASK_IMAGE_BYTES) throw new Error("size");
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
    // Projections are a convenience read model.  A stale hash or an interrupted
    // projection must not hide a task (and therefore its cancel action).  Use the
    // newest self-consistent snapshot for this task instead of treating a hash
    // mismatch as an access-control failure.
    const snapshots = this.database.authQuery((db) => db.prepare("SELECT company_id, workflow_id, revision, state_json FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision DESC").all(row.id) as Array<{ company_id: string; workflow_id: string; revision: number; state_json: string }>);
    for (const snapshot of snapshots) {
      let raw: unknown;
      try { raw = jsonRequired(snapshot.state_json); } catch { continue; }
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
        lastSummaryHash: null,
      });
      if (parsed.success && snapshot.company_id === row.company_id && snapshot.workflow_id === row.workflow_id && parsed.data.issueId === row.id && parsed.data.companyId === row.company_id && parsed.data.workflowId === row.workflow_id) return parsed.data;
    }
    throw new TaskFailure("Task projection is unavailable", [finding("projection-integrity", "revision", "No readable workflow snapshot is available")], 500);
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
    const leadSession = this.database.authQuery((db) => db.prepare("SELECT session_ref FROM forge_agent_executions WHERE task_id = ? AND company_id = ? AND output_artifact_id IS NOT NULL ORDER BY output_revision DESC, finished_at DESC LIMIT 1").get(row.id, row.company_id) as { session_ref: string } | undefined)?.session_ref;
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
        code: reviewAttemptFailureCode(attempt.failure_code),
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

  private planGovernanceView(row: TaskRow, state: Partial<IssueWorkflowState>): PlanGovernanceView | undefined {
    const planRows = this.database.authQuery((db) => db.prepare(`SELECT io.id, io.output_summary AS summary, io.finished_at AS createdAt, io.original_plan_revision AS originalPlanRevision, io.output_revision AS outputRevision, io.final_version AS finalVersion, io.output_artifact_id AS artifactId, a.sha256 AS artifactSha256, io.session_ref AS leadSessionRef, io.id AS leadExecutionId, io.evidence_manifest_artifact_id AS evidenceManifestArtifactId, em.sha256 AS evidenceManifestSha256, io.output_kind AS kind, a.storage_path AS storagePath, a.sha256 AS storedSha256
      FROM forge_agent_executions io JOIN forge_artifacts a ON a.id = io.output_artifact_id
      LEFT JOIN forge_artifacts em ON em.id = io.evidence_manifest_artifact_id
      WHERE io.task_id = ? AND io.company_id = ? AND io.workflow_id = ? 
      ORDER BY io.output_revision`).all(row.id, row.company_id, row.workflow_id) as Array<{ id: string; summary: string; createdAt: string; outputRevision: number; artifactId: string; leadSessionRef: string; kind: "plan" | "decision_blocker"; storagePath: string; storedSha256: string }>);
    const plans = planRows.flatMap((planRow): PlanArtifactView[] => {
      try {
        const subject = PlanSubjectSchema.parse({ planRevision: planRow.outputRevision, artifactId: planRow.artifactId, leadSessionRef: planRow.leadSessionRef });
        const content = PersistedLeadOutputSchema.parse(jsonRequired(this.artifacts.getArtifactSync({ companyId: row.company_id, storagePath: planRow.storagePath, sha256: planRow.storedSha256 }).toString("utf8")));
        return [{ subject, summary: planRow.summary, content, createdAt: planRow.createdAt, status: "superseded" }];
      } catch {
        return [];
      }
    });
    const blocker = state.planBlockerSubject ? this.planBlockerView(state.planBlockerSubject, plans) : undefined;
    const finalPlan = plans.at(-1);
    if (!finalPlan) return blocker ? { blocker } : undefined;
    finalPlan.status = "current";
    const originalPlan = plans[0] ?? finalPlan;
    const previousPlans = plans.slice(0, -1);
    const supplementalReview = this.supplementalReviewView(row);
    const decision = this.planDecisionView(row, finalPlan.subject);
    return { originalPlan, finalPlan, previousPlans, ...(supplementalReview ? { supplementalReview } : {}), ...(decision ? { decision } : {}), ...(blocker ? { blocker } : {}) };
  }

  private supplementalReviewView(task: TaskRow): SupplementalReviewView | undefined {
    const row = this.database.authQuery((db) => db.prepare(`SELECT r.id AS reviewId, r.profile_id AS profileId, r.opinion_artifact_id AS artifactId, r.summary, r.created_at AS createdAt, a.storage_path AS opinionStoragePath, a.sha256 AS opinionSha256, r.planner_response_artifact_id AS responseArtifactId, ra.storage_path AS responseStoragePath, ra.sha256 AS responseSha256
      FROM forge_plan_reviews r JOIN forge_artifacts a ON a.id = r.opinion_artifact_id
      LEFT JOIN forge_artifacts ra ON ra.id = r.planner_response_artifact_id
      WHERE r.task_id = ? AND r.company_id = ? AND r.workflow_id = ?
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`).get(task.id, task.company_id, task.workflow_id) as { reviewId: string; profileId: string; artifactId: string; summary: string; createdAt: string; opinionStoragePath: string; opinionSha256: string; responseArtifactId: string | null; responseStoragePath: string | null; responseSha256: string | null } | undefined);
    if (!row) return undefined;
    const profile = this.database.authQuery((db) => db.prepare("SELECT id, name FROM forge_profiles WHERE id = ?").get(row.profileId) as { id: string; name: string } | undefined);
    try {
      const opinion = SupplementalReviewSchema.parse(jsonRequired(this.artifacts.getArtifactSync({ companyId: task.company_id, storagePath: row.opinionStoragePath, sha256: row.opinionSha256 }).toString("utf8")));
      const responseRaw = row.responseArtifactId && row.responseStoragePath && row.responseSha256 ? jsonRequired(this.artifacts.getArtifactSync({ companyId: task.company_id, storagePath: row.responseStoragePath, sha256: row.responseSha256 }).toString("utf8")) as { reviewResponse?: unknown; summary?: unknown } : undefined;
      const plannerResponse = typeof responseRaw?.reviewResponse === "string" ? responseRaw.reviewResponse : typeof responseRaw?.summary === "string" ? responseRaw.summary : undefined;
      return { reviewId: row.reviewId, reviewerProfile: { id: profile?.id ?? row.profileId, name: profile?.name ?? "Reviewer" }, verdict: opinion.verdict, summary: opinion.summary, concerns: opinion.concerns, artifactId: row.artifactId, ...(plannerResponse ? { plannerResponse } : {}), createdAt: row.createdAt };
    } catch {
      return undefined;
    }
  }

  private planDecisionView(task: TaskRow, finalSubject: PlanSubject): PlanDecisionView | undefined {
    const row = this.database.authQuery((db) => db.prepare(`SELECT d.id AS decisionId, d.decision, d.actor_user_id AS actorId, u.display_name AS actorName, d.note_artifact_id AS noteArtifactId, d.created_at AS createdAt, a.storage_path AS noteStoragePath, a.sha256 AS noteSha256
      FROM forge_plan_decisions d JOIN forge_users u ON u.id = d.actor_user_id JOIN forge_artifacts a ON a.id = d.note_artifact_id
      WHERE d.task_id = ? AND d.company_id = ? AND d.workflow_id = ? AND d.plan_revision = ?
      ORDER BY d.created_at DESC, d.id DESC LIMIT 1`).get(task.id, task.company_id, task.workflow_id, finalSubject.planRevision) as { decisionId: string; decision: "approve" | "request_revision" | "reject"; actorId: string; actorName: string; noteArtifactId: string; createdAt: string; noteStoragePath: string; noteSha256: string } | undefined);
    if (!row) return undefined;
    try {
      const note = this.artifacts.getArtifactSync({ companyId: task.company_id, storagePath: row.noteStoragePath, sha256: row.noteSha256 }).toString("utf8");
      return { decisionId: row.decisionId, decision: row.decision, actor: { id: row.actorId, displayName: row.actorName }, note, noteArtifactId: row.noteArtifactId, noteArtifactSha256: row.noteSha256, createdAt: row.createdAt };
    } catch {
      return undefined;
    }
  }

  private planBlockerView(subject: PlanBlockerSubject, plans: PlanArtifactView[]): PlanBlockerView | undefined {
    const plan = plans.find((entry) => entry.subject.artifactId === subject.artifactId);
    if (!plan || plan.content.kind !== "decision_blocker") return undefined;
    const prompt = "askUserQuestion" in plan.content ? plan.content.askUserQuestion : { header: "Decision", question: plan.content.question, options: [] };
    return { subject, summary: plan.content.summary, evidence: plan.content.evidence, header: prompt.header, question: prompt.question, options: prompt.options, nextAction: plan.content.nextAction, createdAt: plan.createdAt };
  }

  private taskListSummary(row: TaskRow): TaskListSummary | undefined {
    const lifecycle = projectionLifecycle(row);
    if (!lifecycle) {
      console.warn("Skipping task with invalid issue projection", row.id);
      return undefined;
    }
    const workflowState = this.workflowStateForTask(row);
    const hasPlan = this.database.authQuery((db) => Boolean(db.prepare("SELECT 1 FROM forge_agent_executions WHERE task_id = ? AND company_id = ? AND output_kind = 'plan' AND output_artifact_id IS NOT NULL LIMIT 1").get(row.id, row.company_id)));
    const allowedCommands = derivedAllowedCommands(lifecycle.phase, IssueCommandSchema.array().safeParse(json<unknown[]>(row.allowed_commands_json, [])).data ?? [], workflowState.planRevision, hasPlan, Boolean(workflowState.successorTaskId));
    const agentInvocations = this.database.authQuery((db) => db.prepare(`SELECT e.id, e.role, e.status, e.attempt, e.started_at AS startedAt, e.finished_at AS finishedAt, ag.id AS agentId, ag.name AS agentName, ag.avatar_seed AS avatarSeed
      FROM forge_agent_executions e LEFT JOIN forge_agents ag ON ag.id = json_extract((SELECT role_agents_json FROM forge_tasks WHERE id = e.task_id), '$.' || e.role)
      WHERE e.task_id = ? AND e.company_id = ?
      UNION ALL SELECT d.id, 'builder', d.status, d.attempt, d.started_at, d.finished_at, ag.id, ag.name, ag.avatar_seed
      FROM forge_developer_executions d LEFT JOIN forge_agents ag ON ag.id = json_extract((SELECT role_agents_json FROM forge_tasks WHERE id = d.task_id), '$.builder')
      WHERE d.task_id = ? AND d.company_id = ? ORDER BY 5, 1`).all(row.id, row.company_id, row.id, row.company_id) as TaskListSummary["agentInvocations"]);
    const release = this.database.authQuery((db) => db.prepare("SELECT pr_number AS pullRequestNumber FROM forge_releases WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND superseded_at IS NULL ORDER BY updated_at DESC LIMIT 1").get(row.id, row.company_id, row.workflow_id) as { pullRequestNumber: number | null } | undefined);
    const outcome = this.database.authQuery((db) => db.prepare("SELECT a.outcome FROM forge_ci_attempts a JOIN forge_ci_runs r ON r.id = a.run_id WHERE r.task_id = ? AND r.company_id = ? ORDER BY a.created_at DESC LIMIT 1").get(row.id, row.company_id) as { outcome: CiOutcome } | undefined);
    const capacity = this.capacity.statusForTask(row.id);
    const releaseState = workflowState.mergeOutcome === "merged" ? "merged" : workflowState.mergeOutcome === "closed_without_merge" ? "closed" : release ?.pullRequestNumber !== null ? "ready" : release ? "draft" : undefined;
    const githubPullRequestState = workflowState.githubPullRequestState === "open" || workflowState.githubPullRequestState === "closed" || workflowState.githubPullRequestState === "merged" ? workflowState.githubPullRequestState : null;
    const liveStatus = json<Array<{ role: string; status: string }>>(row.live_status_json, []).filter((entry) => typeof entry.role === "string" && typeof entry.status === "string");
    return { id: row.id, companyId: row.company_id, projectId: row.project_id, issueKey: row.issue_key, title: row.title, archivedAt: row.archived_at, deliveryTarget: row.delivery_target ?? legacyDeliveryTarget(row.pull_request_mode), phase: lifecycle.phase, step: lifecycle.step, blocked: isBlocked(workflowState), revision: row.projection_revision, owner: row.owner, allowedCommands, pendingAction: row.pending_action, worktreeState: null, createdAt: row.created_at, updatedAt: row.updated_at, agentInvocations, liveStatus, liveStatusObservedAt: null, capacity: capacity ? { status: capacity.status } : null, ...(release ? { release: { status: release.pullRequestNumber !== null ? "ready" : "reconciling", pullRequestNumber: release.pullRequestNumber, isDraft: false } } : {}), ...(outcome ? { ci: { outcome: outcome.outcome } } : {}), ...(releaseState ? { deliveryGate: { release: { state: releaseState } } } : {}), ...(workflowState.githubPullRequestState !== undefined ? { githubPullRequest: { state: githubPullRequestState } } : {}) };
  }

  private publicTask(actorUserId: string, row: TaskRow): ForgeTask {
    void actorUserId;
    const lifecycle = projectionLifecycle(row);
    if (!lifecycle) throw new TaskFailure("Task projection is unreadable", [finding("projection-integrity", "projection", "Task projection has an unknown phase or step")], 500);
    const imageIds = parseImageIds(row.image_artifact_ids_json);
    const artifacts = this.database.authQuery((db) => {
      if (!imageIds.length) return [] as ArtifactRow[];
      const placeholders = imageIds.map(() => "?").join(",");
      return db.prepare(`SELECT id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at FROM forge_artifacts WHERE company_id = ? AND id IN (${placeholders})`).all(row.company_id, ...imageIds) as ArtifactRow[];
    });
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    const description = row.description ?? (() => {
      const brief = this.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-brief'").get(row.brief_artifact_id, row.company_id) as Pick<ArtifactRow, "storage_path" | "sha256"> | undefined);
      if (!brief) throw new TaskFailure("Task description is unavailable", [], 500);
      const migrated = this.artifacts.getArtifactSync({ companyId: row.company_id, storagePath: brief.storage_path, sha256: brief.sha256 }).toString("utf8");
      this.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET description = ? WHERE id = ? AND company_id = ? AND description IS NULL").run(migrated, row.id, row.company_id));
      return migrated;
    })();
    const workflowState = this.workflowStateForTask(row);
    const reviewLineage = this.reviewLineage(row, workflowState);
    let priorTimelineEntryWasPlanning = false;
    const timeline = this.database.authQuery((db) => db.prepare("SELECT t.id, t.revision, t.event_type, t.metadata_json, t.created_at, s.state_json FROM forge_issue_timeline t LEFT JOIN forge_workflow_snapshots s ON s.task_id = t.task_id AND s.workflow_id = t.workflow_id AND s.revision = t.revision WHERE t.task_id = ? AND t.source = 'workflow' ORDER BY t.revision, t.id").all(row.id) as TimelineRow[]).map((entry) => {
      const metadata = parseMetadata(entry.metadata_json);
      if (entry.event_type !== "planning_started") {
        priorTimelineEntryWasPlanning = false;
        const state = entry.event_type === "phase_blocked" || entry.event_type === "phase_delivery_blocked" ? json<{ pendingAction?: unknown; developerRecoverySummary?: unknown; deliveryReviewBlockerSummary?: unknown; deliveryRepairBlockerSummary?: unknown; targetBaseBlockerSummary?: unknown; blocker?: { summary?: unknown } | null }>(entry.state_json ?? "{}", {}) : undefined;
        const reason = state?.blocker?.summary ?? state?.deliveryReviewBlockerSummary ?? state?.deliveryRepairBlockerSummary ?? state?.targetBaseBlockerSummary ?? state?.developerRecoverySummary ?? state?.pendingAction;
        return { id: entry.id, revision: entry.revision, eventType: entry.event_type, metadata: typeof reason === "string" && reason.trim() ? { ...metadata, blockedReason: redact(reason) as string } : metadata, createdAt: entry.created_at };
      }
      const capacityStatus = json<{ capacity?: { status?: unknown } }>(entry.state_json ?? "{}", {}).capacity?.status;
      const planningStage = capacityStatus === "active" ? "active" : capacityStatus === "queued" ? "queued" : capacityStatus === "rate_limited" ? "rate_limited" : priorTimelineEntryWasPlanning ? "completed" : "started";
      priorTimelineEntryWasPlanning = true;
      return { id: entry.id, revision: entry.revision, eventType: entry.event_type, metadata: { ...metadata, planningStage }, createdAt: entry.created_at };
    });
    const memberRows = this.database.authQuery((db) => db.prepare(`SELECT a.id, a.action, a.metadata_json, a.created_at,
        u.id AS user_id, u.display_name AS user_name, u.username AS user_username, u.avatar_seed AS user_avatar_seed,
        ag.id AS agent_id, ag.name AS agent_name, ag.avatar_seed AS agent_avatar_seed
      FROM forge_audit_events a
      LEFT JOIN forge_users u ON u.id = a.actor_user_id
      LEFT JOIN forge_agents ag ON ag.id = a.actor_agent_id
      WHERE a.company_id = ? AND json_extract(a.metadata_json, '$.taskId') = ? AND a.action IN ('task_created', 'task_command', 'task_rescue')
      ORDER BY a.created_at, a.id`).all(row.company_id, row.id) as Array<{
        id: string; action: string; metadata_json: string; created_at: string;
        user_id: string | null; user_name: string | null; user_username: string | null; user_avatar_seed: string | null;
        agent_id: string | null; agent_name: string | null; agent_avatar_seed: string | null;
      }>);
    const creatorEntry = memberRows.find((entry) => entry.action === "task_created");
    let creatorActor: ActivityActor | undefined;
    if (creatorEntry) {
      if (creatorEntry.user_id) {
        creatorActor = {
          id: creatorEntry.user_id,
          displayName: creatorEntry.user_name!,
          username: creatorEntry.user_username!,
          avatarSeed: creatorEntry.user_avatar_seed || creatorEntry.user_username!,
        };
      } else if (creatorEntry.agent_id) {
        creatorActor = {
          kind: "agent",
          id: creatorEntry.agent_id,
          displayName: creatorEntry.agent_name!,
          avatarSeed: creatorEntry.agent_avatar_seed || creatorEntry.agent_name!,
        };
      }
    }
    const commandActivity: TaskActivityEntry[] = memberRows.filter((entry) => entry.action === "task_command" && entry.user_id).map((entry) => {
      const metadata = parseMetadata(entry.metadata_json);
      return { id: entry.id, revision: Number(metadata.revision), eventType: "member_action", metadata, createdAt: entry.created_at, kind: "member" as const, actor: { id: entry.user_id!, displayName: entry.user_name!, username: entry.user_username!, avatarSeed: entry.user_avatar_seed || entry.user_username! } };
    }).filter((entry) => Number.isInteger(entry.revision) && entry.metadata.command !== "send_planner_note");
    const rescueActivity: TaskActivityEntry[] = memberRows.filter((entry) => entry.action === "task_rescue").map((entry) => {
      const metadata = parseMetadata(entry.metadata_json);
      return { id: entry.id, revision: Number(metadata.revision), eventType: "system_action", metadata, createdAt: entry.created_at, kind: "member" as const, actor: { id: "forge", displayName: "Forge", username: "forge", avatarSeed: "forge" } };
    }).filter((entry) => Number.isInteger(entry.revision));
    const commandKeys = new Set(commandActivity.map((entry) => `${entry.actor?.id}:${entry.revision}:${String(entry.metadata.command)}`));
    const decisionActivity = this.database.authQuery((db) => db.prepare(`SELECT d.id, d.plan_revision, d.decision, d.actor_user_id, d.expected_workflow_revision, d.created_at, u.display_name, u.username, u.avatar_seed
      FROM forge_plan_decisions d JOIN forge_users u ON u.id = d.actor_user_id
      WHERE d.task_id = ? AND d.company_id = ? ORDER BY d.created_at, d.id`).all(row.id, row.company_id) as Array<{ id: string; plan_revision: number; decision: "approve" | "request_revision" | "reject"; actor_user_id: string; expected_workflow_revision: number | null; created_at: string; display_name: string; username: string; avatar_seed: string }>).flatMap((entry): TaskActivityEntry[] => {
      const command: IssueCommand = entry.decision === "approve" ? "approve_plan" : entry.decision === "request_revision" ? "request_plan_revision" : "reject_plan";
      const revision = (entry.expected_workflow_revision ?? entry.plan_revision) + 1;
      if (commandKeys.has(`${entry.actor_user_id}:${revision}:${command}`)) return [];
      return [{ id: `plan-decision-${entry.id}`, revision, eventType: "member_action", metadata: { command, actionLabel: issueCommands[command].label }, createdAt: entry.created_at, kind: "member", actor: { id: entry.actor_user_id, displayName: entry.display_name, username: entry.username, avatarSeed: entry.avatar_seed || entry.username } }];
    });
    const plannerNoteActivity = this.database.authQuery((db) => db.prepare(`SELECT n.id, n.revision, n.note, n.created_at, n.actor, u.display_name, u.username, u.avatar_seed,
        e.id AS execution_id, e.output_revision, e.output_summary, e.finished_at
      FROM forge_planner_notes n
      JOIN forge_users u ON u.id = n.actor
      LEFT JOIN forge_agent_executions e ON e.id = (SELECT next.id FROM forge_agent_executions next
        WHERE next.task_id = n.task_id AND next.company_id = n.company_id AND next.role = 'planner' AND next.output_kind = 'plan' AND next.status = 'completed' AND next.started_at >= n.created_at
        ORDER BY next.started_at, next.id LIMIT 1)
      WHERE n.task_id = ? AND n.company_id = ? ORDER BY n.created_at, n.id`).all(row.id, row.company_id) as Array<{ id: string; revision: number; note: string; created_at: string; actor: string; display_name: string; username: string; avatar_seed: string; execution_id: string | null; output_revision: number | null; output_summary: string | null; finished_at: string | null }>).flatMap((entry): TaskActivityEntry[] => [
        { id: entry.id, revision: entry.revision, eventType: "planner_note", metadata: { note: entry.note }, createdAt: entry.created_at, kind: "member", actor: { id: entry.actor, displayName: entry.display_name, username: entry.username, avatarSeed: entry.avatar_seed || entry.username } },
        ...(entry.execution_id && entry.finished_at ? [{ id: `planner-note-revised-${entry.execution_id}`, revision: entry.output_revision ?? entry.revision + 1, eventType: "planner_note_revised", metadata: { summary: entry.output_summary ?? "Plan updated" }, createdAt: entry.finished_at, kind: "workflow" as const }] : []),
      ]);
    const activity: TaskActivityEntry[] = [...timeline.map((entry): TaskActivityEntry => ({ ...entry, kind: "workflow", ...(entry.eventType === "task_created" && creatorActor ? { actor: creatorActor } : {}) })), ...commandActivity, ...rescueActivity, ...decisionActivity, ...plannerNoteActivity]
      .sort((left, right) => left.revision - right.revision || (left.kind === right.kind ? left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id) : left.kind === "member" ? -1 : 1));
    // ponytail: display agent resolved via current task assignment; add agent_id columns to execution tables if history fidelity ever matters
    const agentInvocations = this.database.authQuery((db) => db.prepare(`SELECT e.id, e.role, e.status, e.attempt, e.session_ref, e.started_at, e.finished_at, e.failure_code, e.failure_summary, e.evidence_artifact_id,
        COALESCE(e.output_summary,
          (SELECT r.summary FROM forge_plan_reviews r WHERE r.execution_id = e.id ORDER BY r.created_at DESC LIMIT 1),
          (SELECT r.summary FROM forge_delivery_reviews r WHERE r.lead_execution_id = e.id ORDER BY r.created_at DESC LIMIT 1),
          (SELECT r.summary FROM forge_final_reviews r WHERE r.lead_execution_id = e.id ORDER BY r.created_at DESC LIMIT 1)) AS summary,
        NULL AS delivery_artifact_id,
        e.profile_id, ag.id AS agent_id, ag.name AS agent_name, ag.avatar_seed, p.name AS profile_name, COALESCE(e.resolved_model, e.model) AS resolved_model, COALESCE(e.resolved_reasoning_level, e.reasoning_level) AS resolved_reasoning_level, COALESCE(e.resolved_service_priority, e.service_priority) AS resolved_service_priority
      FROM forge_agent_executions e
      LEFT JOIN forge_agents ag ON ag.id = json_extract((SELECT role_agents_json FROM forge_tasks WHERE id = e.task_id), '$.' || e.role)
      LEFT JOIN forge_profiles p ON p.id = e.profile_id
      WHERE e.task_id = ? AND e.company_id = ?
      UNION ALL
      SELECT d.id, 'builder' AS role, d.status, d.attempt, d.session_ref, d.started_at, d.finished_at, d.failure_code, d.failure_summary, d.evidence_artifact_id,
        NULL AS summary, d.delivery_artifact_id,
        d.profile_id, ag.id AS agent_id, ag.name AS agent_name, ag.avatar_seed, p.name AS profile_name, NULL AS resolved_model, NULL AS resolved_reasoning_level, NULL AS resolved_service_priority
      FROM forge_developer_executions d
      LEFT JOIN forge_agents ag ON ag.id = json_extract((SELECT role_agents_json FROM forge_tasks WHERE id = d.task_id), '$.builder')
      LEFT JOIN forge_profiles p ON p.id = d.profile_id
      WHERE d.task_id = ? AND d.company_id = ?
      ORDER BY 6, 1`).all(row.id, row.company_id, row.id, row.company_id) as AgentInvocationRow[]).map((invocation) => ({
        id: invocation.id,
        role: invocation.role,
        status: invocation.status,
        attempt: invocation.attempt,
        sessionPresent: invocation.session_ref !== null,
        sessionRef: invocation.session_ref,
        startedAt: invocation.started_at,
        finishedAt: invocation.finished_at,
        failureCode: invocation.failure_code,
        failureSummary: invocation.failure_summary,
        summary: invocation.summary?.trim() || (invocation.delivery_artifact_id ? this.developerReportSummary(row.company_id, invocation.delivery_artifact_id) : null) || invocation.failure_summary,
        evidenceArtifactId: invocation.evidence_artifact_id,
        agentId: invocation.agent_id,
        profileId: invocation.profile_id,
        agentName: invocation.agent_name,
        avatarSeed: invocation.avatar_seed,
        profileName: invocation.profile_name,
        model: invocation.resolved_model,
        reasoningLevel: invocation.resolved_reasoning_level,
        servicePriority: invocation.resolved_service_priority,
      }));
    const leadOutput = this.leadOutput(row.id, row.company_id);
    const developerExecution = this.database.authQuery((db) => db.prepare("SELECT e.id, e.status, e.attempt, e.branch_name, e.started_at AS startedAt, e.finished_at AS finishedAt, e.worktree_path AS worktreePath, e.target_base_sha AS targetBaseSha, e.current_step AS currentStep, e.heartbeat_at AS lastHeartbeatAt, e.result_commit AS resultCommit, e.result_tree AS resultTree, e.dirty_state AS dirtyState, e.delivery_artifact_id AS deliveryArtifactId, e.evidence_artifact_id AS evidenceArtifactId, e.failure_code AS failureCode, e.failure_summary AS failureSummary, NULL AS leaseStatus, NULL AS reconciliationArtifactId, NULL AS manifestArtifactId, NULL AS rawReportArtifactId, NULL AS beforeProviderArtifactId, NULL AS afterProviderArtifactId, NULL AS boundaryMode, NULL AS beforeProviderSha256, NULL AS afterProviderSha256, NULL AS startingCommit, NULL AS startingTree FROM forge_developer_executions e WHERE e.task_id = ? AND e.company_id = ? ORDER BY e.attempt DESC, e.started_at DESC LIMIT 1").get(row.id, row.company_id) as { id: string; status: string; attempt: number; branch_name: string; startedAt: string; finishedAt: string | null; worktreePath: string; targetBaseSha: string; currentStep: number | null; lastHeartbeatAt: string | null; resultCommit: string | null; resultTree: string | null; dirtyState: string | null; deliveryArtifactId: string | null; evidenceArtifactId: string | null; failureCode: string | null; failureSummary: string | null; leaseStatus: string | null; reconciliationArtifactId: string | null; manifestArtifactId: string | null; rawReportArtifactId: string | null; beforeProviderArtifactId: string | null; afterProviderArtifactId: string | null; boundaryMode: "owner_controlled_observed" | null; beforeProviderSha256: string | null; afterProviderSha256: string | null; startingCommit: string | null; startingTree: string | null } | undefined);
    const ownedWorktree = this.database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? ORDER BY reserved_at DESC LIMIT 1").get(row.id, row.company_id) as { worktreePath: string } | undefined);
    const developerLive = developerExecution ? { currentStep: developerExecution.currentStep, lastHeartbeatAt: developerExecution.lastHeartbeatAt } : undefined;
    if (developerExecution && developerLive) developerExecution.currentStep = developerLive.currentStep as never;
    const developerSummary = developerExecution?.status === "blocked" ? developerExecution.failureSummary : developerExecution?.deliveryArtifactId ? this.developerReportSummary(row.company_id, developerExecution.deliveryArtifactId) : null;
    const { verificationCommands, verificationResults } = developerVerificationProjection(this.database, this.artifacts, row.company_id, null);
    const workflowSnapshot = this.database.authQuery((db) => db.prepare("SELECT state_json AS stateJson FROM forge_workflow_snapshots WHERE task_id = ? AND revision = ?").get(row.id, row.projection_revision) as { stateJson: string } | undefined);
    const snapshotState = workflowSnapshot ? IssueWorkflowStateSchema.safeParse(json<unknown>(workflowSnapshot.stateJson, null)) : undefined;
    const planHistory = this.database.authQuery((db) => db.prepare("SELECT output_revision AS revision, output_kind AS kind, output_summary AS summary, id AS executionId, output_artifact_id AS outputArtifactId, evidence_artifact_id AS evidenceArtifactId, finished_at AS createdAt FROM forge_agent_executions WHERE task_id = ? AND company_id = ? AND output_artifact_id IS NOT NULL ORDER BY output_revision, finished_at, id").all(row.id, row.company_id) as TaskPlanHistoryEntry[]);
    const rawAllowedCommands = json<unknown[]>(row.allowed_commands_json, []);
    const projectedCommands = IssueCommandSchema.array().safeParse(rawAllowedCommands).success ? IssueCommandSchema.array().parse(rawAllowedCommands) : [];
    const allowedCommands = derivedAllowedCommands(lifecycle.phase, projectedCommands, workflowState.planRevision, planHistory.some((plan) => plan.kind === "plan"), Boolean(workflowState.successorTaskId));
    const recoveryStatus = developerExecution?.leaseStatus === "result_ready" ? "result_pending_claim" : snapshotState?.success ? snapshotState.data.developerRecoveryStatus : undefined;
    const nextRecoveryCommand = recoveryStatus ? (["retry_development", "cancel_development", "cancel_issue"] as const).find((command) => allowedCommands.includes(command)) : undefined;
    const developerRecovery = recoveryStatus && snapshotState?.success ? {
      status: recoveryStatus,
      reasonCode: snapshotState.data.developerRecoveryReasonCode ?? null,
      summary: developerExecution?.leaseStatus === "result_ready" ? "Developer finished. Forge is recording the result." : snapshotState.data.developerRecoverySummary ?? null,
      lastHeartbeatAt: snapshotState.data.developerLastHeartbeatAt ?? null,
      currentOwner: "forge" as const,
      evidenceArtifactId: snapshotState.data.developerEvidenceArtifactId ?? developerExecution?.evidenceArtifactId ?? null,
      nextAction: nextRecoveryCommand ? { command: nextRecoveryCommand, label: nextRecoveryCommand === "retry_development" ? "Retry development" : nextRecoveryCommand === "cancel_development" ? "Cancel development" : "Cancel the task", requiresConfirmation: true } : null,
    } : undefined;
    const planAuthorization = null as unknown as { id: string; plan_sha256: string } | undefined;
    const decision = this.database.authQuery((db) => db.prepare("SELECT artifact_id FROM forge_delivery_decisions WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id, row.company_id, row.workflow_id) as { artifact_id: string } | undefined);
    const review = this.database.authQuery((db) => db.prepare("SELECT id, outcome, summary, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, opinion_artifact_id, evidence_artifact_id, repair_cycle FROM forge_delivery_reviews WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(row.id, row.company_id, row.workflow_id) as { id: string; outcome: "approved" | "blocking"; summary: string; plan_revision: number; base_sha: string; subject_commit: string; subject_tree: string; lead_execution_id: string; opinion_artifact_id: string; evidence_artifact_id: string; repair_cycle: number } | undefined);
    const findings = review ? this.database.authQuery((db) => db.prepare("SELECT id, severity, rationale, evidence_ref, disposition, repair_instruction FROM forge_delivery_findings WHERE review_id = ? AND task_id = ? AND company_id = ? ORDER BY id").all(review.id, row.id, row.company_id) as Array<{ id: string; severity: "blocking" | "advisory"; rationale: string; evidence_ref: string; disposition: string; repair_instruction: string | null }>) : [];
    void [developerSummary, verificationCommands, verificationResults, planAuthorization, decision, findings];
    const planDecisionHistory = this.database.authQuery((db) => db.prepare("SELECT id, plan_revision AS planRevision, decision, note_artifact_id AS noteArtifactId, created_at AS createdAt FROM forge_plan_decisions WHERE task_id = ? AND company_id = ? ORDER BY plan_revision, created_at, id").all(row.id, row.company_id) as TaskPlanDecisionHistoryEntry[]);
    const revisionHistory = this.database.authQuery((db) => db.prepare("SELECT id, request_revision AS requestRevision, disposition, status, blocker_code AS blockerCode, developer_execution_id AS developerExecutionId, branch_name AS branchName, base_sha AS baseSha, head_sha AS headSha, tree_sha AS treeSha, exact_base_sha AS exactBaseSha, authorized_plan_revision AS authorizedPlanRevision, reason_artifact_id AS reasonArtifactId, created_at AS createdAt, updated_at AS updatedAt FROM forge_plan_revision_requests WHERE task_id = ? AND company_id = ? ORDER BY request_revision, created_at, id").all(row.id, row.company_id) as TaskRevisionHistoryEntry[]);
    const developerExecutionHistory = this.database.authQuery((db) => db.prepare("SELECT id, plan_revision AS planRevision, attempt, status, branch_name AS branchName, target_base_sha AS targetBaseSha, result_commit AS resultCommit, result_tree AS resultTree, dirty_state AS dirtyState, delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId, failure_code AS failureCode, failure_summary AS failureSummary, started_at AS startedAt, finished_at AS finishedAt FROM forge_developer_executions WHERE task_id = ? AND company_id = ? ORDER BY plan_revision, attempt, started_at, id").all(row.id, row.company_id) as TaskDeveloperExecutionHistoryEntry[]);
    const deliveryReviewHistory = this.database.authQuery((db) => db.prepare("SELECT id, plan_revision AS planRevision, outcome, summary, base_sha AS baseSha, subject_commit AS subjectCommit, subject_tree AS subjectTree, lead_execution_id AS leadExecutionId, opinion_artifact_id AS opinionArtifactId, evidence_artifact_id AS evidenceArtifactId, repair_cycle AS repairCycle, created_at AS createdAt FROM forge_delivery_reviews WHERE task_id = ? AND company_id = ? ORDER BY created_at, id").all(row.id, row.company_id) as TaskDeliveryReviewHistoryEntry[]);
    const linkedTask = (taskId: string | null): TaskLinkSummary | undefined => taskId ? this.database.authQuery((db) => db.prepare("SELECT t.id, t.title, p.phase, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issueKey FROM forge_tasks t JOIN forge_companies c ON c.id = t.company_id JOIN forge_issue_projections p ON p.task_id = t.id AND p.company_id = t.company_id WHERE t.id = ? AND t.company_id = ?").get(taskId, row.company_id) as TaskLinkSummary | undefined) : undefined;
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
    const blockerCode = reconciliation?.failureCode ?? workflowState.targetBaseBlockerCode ?? workflowState.deliveryRepairBlockerCode ?? workflowState.deliveryReviewBlockerCode ?? null;
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
      blockerCode,
      blockerOwner: typeof reconciliationState.targetBaseBlockerOwner === "string" ? reconciliationState.targetBaseBlockerOwner : null,
      retryable: typeof reconciliationState.targetBaseBlockerRetryable === "boolean" ? reconciliationState.targetBaseBlockerRetryable : null,
      summary: reconciliation?.failureSummary ?? (typeof reconciliationState.targetBaseBlockerSummary === "string" ? reconciliationState.targetBaseBlockerSummary : null),
      actions: json<string[]>(row.allowed_commands_json, []),
    };
    const deliveryGate = this.deliveryGate(row, workflowState);
    const githubPullRequest = typeof workflowState.githubPullRequestExists === "boolean" ? { exists: workflowState.githubPullRequestExists, number: typeof workflowState.pullRequestNumber === "number" ? workflowState.pullRequestNumber : null, url: typeof workflowState.pullRequestUrl === "string" ? workflowState.pullRequestUrl : null, state: workflowState.githubPullRequestState === "open" || workflowState.githubPullRequestState === "closed" || workflowState.githubPullRequestState === "merged" ? workflowState.githubPullRequestState : null, isDraft: typeof workflowState.githubPullRequestDraft === "boolean" ? workflowState.githubPullRequestDraft : null, checks: workflowState.githubPullRequestChecks && typeof workflowState.githubPullRequestChecks === "object" ? workflowState.githubPullRequestChecks as { total: number; pending: number; failing: number; successful: number } : { total: 0, pending: 0, failing: 0, successful: 0 }, author: workflowState.githubPullRequestAuthor && typeof workflowState.githubPullRequestAuthor === "object" ? workflowState.githubPullRequestAuthor as { login: string; avatarUrl: string } : null, changedFiles: typeof workflowState.githubPullRequestChangedFiles === "number" ? workflowState.githubPullRequestChangedFiles : null, additions: typeof workflowState.githubPullRequestAdditions === "number" ? workflowState.githubPullRequestAdditions : null, deletions: typeof workflowState.githubPullRequestDeletions === "number" ? workflowState.githubPullRequestDeletions : null, mergeable: typeof workflowState.githubPullRequestMergeable === "string" ? workflowState.githubPullRequestMergeable : null, observedAt: typeof workflowState.githubObservedAt === "string" ? workflowState.githubObservedAt : null, reviewDecision: typeof workflowState.githubPullRequestReviewDecision === "string" ? workflowState.githubPullRequestReviewDecision : null, autoMergeEnabled: typeof workflowState.githubPullRequestAutoMergeEnabled === "boolean" ? workflowState.githubPullRequestAutoMergeEnabled : null } : undefined;
    const governanceView = this.planGovernanceView(row, workflowState) ?? {};
    // Tasks created before configuration snapshots (or prompt pinning) simply use the defaults.
    let configuration;
    try { configuration = loadTaskConfiguration(this.database.authQuery((db) => db), this.artifacts, { taskId: row.id, companyId: row.company_id }); } catch { configuration = undefined; }
    const prompts = configuration?.prompts;
    const source = configuration?.source?.kind === "pull_request"
      ? { kind: "pull_request" as const, number: configuration.source.number, url: configuration.source.url, headBranch: configuration.source.headBranch, baseBranch: configuration.source.baseBranch }
      : configuration?.source?.kind === "branch" ? { kind: "branch" as const, branch: configuration.source.branch } : undefined;
    const roleAgents = parseRoleAgents(row.role_agents_json);
    const commands = taskCommandDescriptors(allowedCommands, row.projection_revision);
    const attentionCard = attentionCardFromBlocker(workflowState.blocker ?? undefined, { summary: row.pending_action, pendingAction: row.pending_action, step: lifecycle.step, blockerCode, actions: commands.map((command) => ({ command: command.name, label: command.label, ...(command.note === "required" ? { requiresNote: true } : {}) })), ...(workflowState.mergeDecision ? { mergeDecision: workflowState.mergeDecision } : {}) });
    return { id: row.id, companyId: row.company_id, projectId: row.project_id, issueKey: row.issue_key, title: row.title, archivedAt: row.archived_at, description, briefArtifactId: row.brief_artifact_id, images: imageIds.flatMap((artifactId) => { const artifact = artifactById.get(artifactId); return artifact ? [{ artifactId, filename: artifact.filename, mimeType: artifact.mime_type, byteSize: artifact.byte_size }] : []; }), roleAgents, supplementalReview: row.supplemental_review === 1, autoApprovePlan: row.autoApprovePlan === 1, deliveryTarget: row.delivery_target ?? legacyDeliveryTarget(row.pull_request_mode), executionControls: { runProjectTests: row.run_project_tests === 1, visualEvidence: row.visual_evidence, supplementalReview: row.supplemental_review === 1 }, browserProof: this.browserProof.projectSync(row.id, row.company_id), deliveryReceipt: row.delivery_worktree_path || row.delivery_branch_name || row.delivery_commit ? { worktreePath: row.delivery_worktree_path, branchName: row.delivery_branch_name, commit: row.delivery_commit } : null, worktreeState: null, worktreePath: ownedWorktree?.worktreePath ?? developerExecution?.worktreePath ?? null, pullRequestMode: row.pull_request_mode, workflowId: row.workflow_id, projectRevisionId: row.project_revision_id, prompts: { overrides: prompts?.overrides ?? [] }, ...(source ? { source } : {}), phase: lifecycle.phase, step: lifecycle.step, blocked: isBlocked(workflowState), liveStatus: json<Array<{ role: string; status: string }>>(row.live_status_json, []).filter((entry) => typeof entry.role === "string" && typeof entry.status === "string"), liveStatusObservedAt: null, revision: row.projection_revision, owner: row.owner, allowedCommands, commands, governance: governanceView, pendingAction: row.pending_action, attentionCard, lastHandlerError: workflowState.lastHandlerError ?? null, createdAt: row.created_at, updatedAt: row.updated_at, timeline, activity, agentInvocations, capacity, planHistory, planDecisionHistory, revisionHistory, developerExecutionHistory, deliveryReviewHistory, projection: { revision: row.projection_revision, projectedAt: row.projected_at }, reviewLineage, targetBaseReconciliation, ...(deliveryGate ? { deliveryGate } : {}), ...(githubPullRequest ? { githubPullRequest } : {}), ...(workflowState ? { planRevision: workflowState.planRevision ?? null, supplementalReviewUsed: workflowState.supplementalReviewUsed ?? false, supplementalReviewArtifactId: workflowState.supplementalReviewArtifactId ?? null, decisionId: workflowState.planDecisionReceipt?.decisionId ?? null, leadInputManifestArtifactId: workflowState.leadInputManifestArtifactId ?? undefined, blockedCategory: workflowState.blockedCategory ?? null, blockedResumePhase: workflowState.blockedResumePhase ?? null, blockerArtifactId: workflowState.blockerArtifactId ?? null, deliveryDecisionArtifactId: workflowState.deliveryDecisionArtifactId ?? null, predecessorTaskId: row.predecessor_task_id, successorTaskId: row.successor_task_id, deliveryReviewBlockerCode: workflowState.deliveryReviewBlockerCode ?? null, deliveryReviewBlockerSummary: workflowState.deliveryReviewBlockerSummary ?? null, deliveryReviewBlockerEvidenceArtifactId: workflowState.deliveryReviewBlockerEvidenceArtifactId ?? null, deliveryRepairBlockerCode: workflowState.deliveryRepairBlockerCode ?? null, deliveryRepairBlockerSummary: workflowState.deliveryRepairBlockerSummary ?? null, deliveryRepairBlockerEvidenceArtifactId: workflowState.deliveryRepairBlockerEvidenceArtifactId ?? null } : {}), ...(predecessor ? { predecessor } : {}), ...(successor ? { successor } : {}), ...(developerExecution ? { developerExecution: { ...developerExecution, branchName: developerExecution.branch_name, summary: developerSummary } } : {}), ...(developerRecovery ? { developerRecovery } : {}), ...(leadOutput ? { leadOutput } : {}), ...(release !== undefined ? { release } : {}), ...(ci ? { ci } : {}) };
  }

  private developerReportSummary(companyId: string, artifactId: string): string | null {
    const artifact = this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'developer-delivery'").get(artifactId, companyId) as { storagePath: string; sha256: string } | undefined);
    if (!artifact) return null;
    try {
      const report = jsonRequired(this.artifacts.getArtifactSync({ companyId, storagePath: artifact.storagePath, sha256: artifact.sha256 }).toString("utf8")) as { summary?: unknown };
      return typeof report.summary === "string" && report.summary.trim() ? report.summary.trim() : null;
    } catch { return null; }
  }

  private releaseForTask(taskId: string, companyId: string, workflowId: string): TaskRelease | null | undefined {
    const row = this.database.authQuery((db) => db.prepare(`SELECT r.id, r.repository, r.base_branch AS baseBranch, r.head_branch AS headBranch, r.base_sha AS baseSha, r.head_sha AS headSha, r.head_tree AS headTree, r.pr_number AS pullRequestNumber, r.pr_url AS pullRequestUrl, r.reused, r.title, r.body_artifact_id AS bodyArtifactId, a.storage_path AS bodyStoragePath, a.sha256 AS bodySha, o.kind AS operationKind, o.attempt, o.started_at AS startedAt, o.observed_at AS observedAt, o.completed_at AS completedAt, o.failure_code AS failureCode, o.failure_summary AS failureSummary, o.retry_at AS retryAt
      FROM forge_releases r LEFT JOIN forge_artifacts a ON a.id = r.body_artifact_id AND a.company_id = r.company_id AND a.kind = 'release-public-body'
      LEFT JOIN forge_provider_operations o ON o.id = (SELECT latest.id FROM forge_provider_operations latest WHERE latest.task_id = r.task_id AND latest.company_id = r.company_id AND latest.workflow_id = r.workflow_id AND latest.release_key = r.release_key AND latest.kind IN ('push', 'create-draft-pr', 'update-draft-pr') ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1)
      WHERE r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.superseded_at IS NULL ORDER BY r.updated_at DESC LIMIT 1`).get(taskId, companyId, workflowId) as { id: string; repository: string; baseBranch: string; headBranch: string; baseSha: string; headSha: string; headTree: string; pullRequestNumber: number | null; pullRequestUrl: string | null; reused: number; title: string; bodyArtifactId: string | null; bodyStoragePath: string | null; bodySha: string | null; operationKind: string | null; attempt: number | null; startedAt: string | null; observedAt: string | null; completedAt: string | null; failureCode: string | null; failureSummary: string | null; retryAt: string | null } | undefined);
    if (!row) return undefined;
    let bodyPreview: string | null = null;
    if (row.bodyArtifactId && row.bodyStoragePath && row.bodySha) {
      try { bodyPreview = this.artifacts.getArtifactSync({ companyId, storagePath: row.bodyStoragePath, sha256: row.bodySha }).toString("utf8"); } catch { bodyPreview = null; }
    }
    const status: TaskRelease["status"] = row.failureCode ? "blocked" : row.pullRequestNumber === null ? "reconciling" : "ready";
    const observedFailureCode = ReleaseFailureCodeSchema.safeParse(row.failureCode);
    const failureCode = status === "blocked" ? observedFailureCode.success ? observedFailureCode.data : "provider-unavailable" : null;
    return { id: row.id, status, failureCode, failureSummary: row.failureSummary, retryAt: row.retryAt, repository: row.repository, baseBranch: row.baseBranch, headBranch: row.headBranch, baseSha: row.baseSha, headSha: row.headSha, headTree: row.headTree, reviewedCommit: { abbreviated: row.headSha.slice(0, 7), full: row.headSha }, reviewedTree: { abbreviated: row.headTree.slice(0, 7), full: row.headTree }, pullRequestNumber: row.pullRequestNumber, pullRequestUrl: row.pullRequestUrl, isDraft: false, reused: row.reused === 1, bodyArtifactId: row.bodyArtifactId, title: row.title, bodyPreview, operation: row.operationKind ? { kind: row.operationKind, status: "derived from GitHub at " + (row.observedAt ?? row.startedAt ?? "unknown"), attempt: row.attempt, startedAt: row.startedAt, observedAt: row.observedAt, completedAt: row.completedAt } : null };
  }

  getRelease(actorUserId: string, taskId: string): TaskRelease | null {
    const task = this.getTask(actorUserId, taskId);
    return this.releaseForTask(task.id, task.companyId, task.workflowId) ?? null;
  }

  async getReleaseArtifact(actorUserId: string, taskId: string, artifactId: string): Promise<{ mimeType: string; bytes: Buffer }> {
    const task = this.getTask(actorUserId, taskId);
    const artifact = this.database.authQuery((db) => db.prepare(`SELECT a.mime_type AS mimeType, a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a JOIN forge_releases r ON r.body_artifact_id = a.id AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.superseded_at IS NULL WHERE a.id = ? AND a.company_id = ? AND a.kind = 'release-public-body'`).get(task.id, task.companyId, task.workflowId, artifactId, task.companyId) as { mimeType: string; storagePath: string; sha256: string } | undefined);
    if (!artifact) throw new TaskFailure("Not found", [], 404);
    return { mimeType: artifact.mimeType, bytes: await this.artifacts.getArtifact({ companyId: task.companyId, storagePath: artifact.storagePath, sha256: artifact.sha256 }) };
  }

  private deliveryGate(row: TaskRow, state: IssueWorkflowState | undefined): ForgeTask["deliveryGate"] {
    if (!state?.releaseId) return undefined;
    const release = this.database.authQuery((db) => db.prepare("SELECT id, repository, pr_number, pr_url, base_branch, base_sha, head_sha, head_tree FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.releaseId, row.id, row.company_id, row.workflow_id) as { id: string; repository: string; pr_number: number | null; pr_url: string | null; base_branch: string; base_sha: string; head_sha: string; head_tree: string } | undefined);
    if (!release || release.pr_number === null || !release.pr_url) return undefined;
    const ci = state.ciRunId ? this.database.authQuery((db) => db.prepare("SELECT id, status, summary, updated_at FROM forge_ci_runs WHERE id = ? AND task_id = ? AND company_id = ? AND release_id = ?").get(state.ciRunId, row.id, row.company_id, release.id) as { id: string; status: string; summary: string; updated_at: string } | undefined) : undefined;
    const checks = ci ? this.database.authQuery((db) => db.prepare("SELECT name, status, conclusion, details_url FROM forge_ci_checks WHERE run_id = ? ORDER BY name").all(ci.id) as Array<{ name: string; status: string; conclusion: string | null; details_url: string | null }>) : [];
    const finalReview = state.finalReviewId ? this.database.authQuery((db) => db.prepare("SELECT id, outcome, summary, lead_execution_id AS leadExecutionId, created_at AS createdAt, session_ref, opinion_artifact_id, evidence_artifact_id FROM forge_final_reviews WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.finalReviewId, row.id, row.company_id, row.workflow_id) as { id: string; outcome: "approved" | "blocking"; summary: string; leadExecutionId: string; createdAt: string; session_ref: string; opinion_artifact_id: string; evidence_artifact_id: string } | undefined) : undefined;
    const finalFindings = finalReview ? this.database.authQuery((db) => db.prepare("SELECT id, severity, rationale, evidence_ref, disposition, repair_instruction FROM forge_final_review_findings WHERE review_id = ? AND task_id = ? AND company_id = ? ORDER BY id").all(finalReview.id, row.id, row.company_id) as Array<{ id: string; severity: string; rationale: string; evidence_ref: string; disposition: string; repair_instruction: string | null }>) : [];
    const acceptance = state.acceptanceId ? this.database.authQuery((db) => db.prepare("SELECT id, decision, status, actor_user_id, created_at, ready_at, reason_artifact_id FROM forge_acceptances WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.acceptanceId, row.id, row.company_id, row.workflow_id) as { id: string; decision: "accept" | "request_changes" | "cancel"; status: string; actor_user_id: string; created_at: string; ready_at: string | null; reason_artifact_id: string | null } | undefined) : undefined;
    const observation = state.mergeObservationId ? this.database.authQuery((db) => db.prepare("SELECT id, observed_at, provider_merged_at, evidence_artifact_id FROM forge_merge_observations WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.mergeObservationId, row.id, row.company_id, row.workflow_id) as { id: string; observed_at: string; provider_merged_at: string | null; evidence_artifact_id: string | null } | undefined) : undefined;
    const receipt = state.completionReceiptId ? this.database.authQuery((db) => db.prepare("SELECT id, receipt_artifact_id AS receiptArtifactId FROM forge_completion_receipts WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(state.completionReceiptId, row.id, row.company_id, row.workflow_id) as { id: string; receiptArtifactId: string } | undefined) : undefined;
    const releaseState = state.mergeOutcome === "merged" ? "merged" : state.mergeOutcome === "closed_without_merge" ? "closed" : state.githubPullRequestDraft === false ? "ready" : "draft";
    return { release: { id: release.id, repository: release.repository, pullRequestNumber: release.pr_number, pullRequestUrl: release.pr_url, baseBranch: release.base_branch, baseSha: release.base_sha, headSha: release.head_sha, headTree: release.head_tree, state: releaseState }, ci: ci ? { id: ci.id, status: ci.status, summary: ci.summary, updatedAt: ci.updated_at, checks: checks.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, detailsUrl: check.details_url })) } : null, finalReview: finalReview ? { id: finalReview.id, outcome: finalReview.outcome, summary: finalReview.summary, leadExecutionId: finalReview.leadExecutionId, createdAt: finalReview.createdAt, sessionRef: finalReview.session_ref, opinionArtifactId: finalReview.opinion_artifact_id, evidenceArtifactId: finalReview.evidence_artifact_id, findings: finalFindings.map((finding) => ({ id: finding.id, severity: finding.severity, rationale: finding.rationale, evidenceRef: finding.evidence_ref, disposition: finding.disposition, repairInstruction: finding.repair_instruction })) } : null, acceptance: acceptance ? { id: acceptance.id, decision: acceptance.decision as "accept" | "request_changes" | "cancel", status: acceptance.status, actorUserId: acceptance.actor_user_id, decidedAt: acceptance.created_at, readyAt: acceptance.ready_at, reasonArtifactId: acceptance.reason_artifact_id, evidenceArtifactId: null } : null, merge: { outcome: state.mergeOutcome ?? null, observationId: observation?.id ?? null, observedAt: observation?.observed_at ?? null, mergedAt: observation?.provider_merged_at ?? null, receiptId: receipt?.id ?? null, receiptArtifactId: receipt?.receiptArtifactId ?? null, evidenceArtifactId: null }, deployment: { status: "unknown", summary: "Out of scope" } };
  }

  private leadOutput(taskId: string, companyId: string): ForgeTask["leadOutput"] {
    const row = this.database.authQuery((db) => db.prepare(`SELECT o.company_id, o.output_kind AS kind, o.output_summary AS summary, o.session_ref, o.id AS execution_id, o.output_artifact_id, o.evidence_artifact_id, a.sha256 AS output_sha256, e.sha256 AS evidence_sha256, a.storage_path, a.sha256
      FROM forge_agent_executions o JOIN forge_artifacts a ON a.id = o.output_artifact_id JOIN forge_artifacts e ON e.id = o.evidence_artifact_id
      WHERE o.task_id = ? AND o.company_id = ? AND o.output_artifact_id IS NOT NULL ORDER BY o.output_revision DESC LIMIT 1`).get(taskId, companyId) as LeadOutputRow | undefined);
    if (!row) return undefined;
    const content = PersistedLeadOutputSchema.parse(jsonRequired(this.artifacts.getArtifactSync({ companyId: row.company_id, storagePath: row.storage_path, sha256: row.sha256 }).toString("utf8")));
    return { kind: row.kind, summary: row.summary, sessionRef: row.session_ref, executionId: row.execution_id, outputArtifactId: row.output_artifact_id, evidenceArtifactId: row.evidence_artifact_id, content };
  }

  private ciProjection(taskId: string, companyId: string): TaskCiProjection | undefined {
    type RunRow = { runId: string; releaseId: string; repository: string; pullRequestNumber: number | null; pullRequestUrl: string | null; baseBranch: string; headBranch: string; expectedHeadSha: string; expectedHeadTree: string | null; status: string; policyHash: string | null; policyJson: string | null; firstObservedAt: string | null; propagationDeadline: string | null; overallDeadline: string | null; nextRetryAt: string | null; completedAt: string | null; supersededAt: string | null };
    const run = this.database.authQuery((db) => db.prepare(`SELECT c.id AS runId, c.release_id AS releaseId, r.repository, r.pr_number AS pullRequestNumber, r.pr_url AS pullRequestUrl, r.base_branch AS baseBranch, r.head_branch AS headBranch, c.expected_head_sha AS expectedHeadSha, COALESCE(c.expected_head_tree, r.head_tree) AS expectedHeadTree, c.status, c.policy_hash AS policyHash, c.policy_json AS policyJson, c.first_observed_at AS firstObservedAt, c.propagation_deadline AS propagationDeadline, c.overall_deadline AS overallDeadline, c.next_poll_at AS nextRetryAt, c.completed_at AS completedAt, c.superseded_at AS supersededAt
      FROM forge_ci_runs c JOIN forge_releases r ON r.id = c.release_id
      WHERE c.task_id = ? AND c.company_id = ?
      ORDER BY c.updated_at DESC, c.id DESC LIMIT 1`).get(taskId, companyId) as RunRow | undefined);
    if (!run || run.pullRequestNumber === null || !run.pullRequestUrl || !run.expectedHeadTree) return undefined;
    type LegacyCiAttemptRow = Omit<TaskCiProjection["attempts"][number], "checks" | "owner" | "repairable"> & { owner: CiOwner | "lead"; repairable: number };
    const attemptRows = this.database.authQuery((db) => db.prepare(`SELECT id, attempt_number AS attemptNumber, observed_repository AS observedRepository, observed_pr_number AS observedPrNumber, observed_base_branch AS observedBaseBranch, observed_base_sha AS observedBaseSha, observed_head_branch AS observedHeadBranch, observed_head_sha AS observedHeadSha, outcome, reason, owner, repairable, retry_at AS retryAt, summary, evidence_artifact_id AS evidenceArtifactId, created_at AS createdAt FROM forge_ci_attempts WHERE run_id = ? ORDER BY attempt_number DESC LIMIT 20`).all(run.runId) as LegacyCiAttemptRow[]);
    const attempts = attemptRows.map((attempt) => ({ ...attempt, owner: attempt.owner === "lead" ? "integrator" : attempt.owner, repairable: attempt.repairable === 1, checks: this.database.authQuery((db) => db.prepare("SELECT provider_check_id AS providerCheckId, name, head_sha AS headSha, status, conclusion, details_url AS detailsUrl, summary, started_at AS startedAt, completed_at AS completedAt, selected_for_evaluation AS selectedForEvaluation FROM forge_ci_attempt_checks WHERE attempt_id = ? ORDER BY name, provider_check_id").all(attempt.id) as Array<Omit<TaskCiProjection["attempts"][number]["checks"][number], "selectedForEvaluation"> & { selectedForEvaluation: number }>).map((check) => ({ ...check, selectedForEvaluation: check.selectedForEvaluation === 1 })) }));
    const latest = attempts[0];
    const repairPlanRow = this.database.authQuery((db) => db.prepare("SELECT p.id, p.status, p.ci_run_id AS ciRunId, p.ci_attempt_id AS ciAttemptId, p.failed_head_sha AS failedHeadSha, p.plan_artifact_id AS planArtifactId, p.evidence_artifact_id AS evidenceArtifactId, p.summary, p.created_at AS createdAt, p.updated_at AS updatedAt, p.consumed_at AS consumedAt, p.superseded_at AS supersededAt, a.storage_path AS planStoragePath, a.sha256 AS planSha256 FROM forge_ci_repair_plans p JOIN forge_artifacts a ON a.id = p.plan_artifact_id AND a.company_id = p.company_id WHERE p.task_id = ? AND p.company_id = ? ORDER BY p.created_at DESC LIMIT 1").get(taskId, companyId) as (Omit<NonNullable<TaskCiProjection["repairPlan"]>, "steps"> & { planStoragePath: string; planSha256: string }) | undefined);
    const repairPlan = repairPlanRow ? (() => { const { planStoragePath, planSha256, ...publicPlan } = repairPlanRow; let steps: Array<{ number: number; instruction: string; verification: string }> = []; try { const value = json<{ steps?: unknown }>(this.artifacts.getArtifactSync({ companyId, storagePath: planStoragePath, sha256: planSha256 }).toString("utf8"), {}); steps = Array.isArray(value.steps) ? value.steps.filter((step): step is { number: number; instruction: string; verification: string } => Boolean(step) && typeof step === "object" && typeof (step as Record<string, unknown>).number === "number" && typeof (step as Record<string, unknown>).instruction === "string" && typeof (step as Record<string, unknown>).verification === "string").slice(0, 32) : []; } catch { /* projection remains bounded when the artifact is unavailable */ } return { ...publicPlan, steps }; })() : null;
    const repairs = this.database.authQuery((db) => db.prepare("SELECT x.id, x.repair_plan_id AS repairPlanId, x.prior_commit AS priorCommit, x.prior_tree AS priorTree, x.new_commit AS newCommit, x.new_tree AS newTree, x.delivery_artifact_id AS deliveryArtifactId, x.evidence_artifact_id AS evidenceArtifactId, x.status, x.summary, x.created_at AS createdAt, x.completed_at AS completedAt FROM forge_ci_repairs x JOIN forge_ci_repair_plans p ON p.id = x.repair_plan_id WHERE p.task_id = ? AND p.company_id = ? ORDER BY x.created_at DESC LIMIT 20").all(taskId, companyId) as TaskCiProjection["repairs"]);
    const supersededRuns = this.database.authQuery((db) => db.prepare("SELECT c.id AS runId, c.release_id AS releaseId, c.expected_head_sha AS expectedHeadSha, c.expected_head_tree AS expectedHeadTree, c.status, c.superseded_at AS supersededAt FROM forge_ci_runs c WHERE c.task_id = ? AND c.company_id = ? AND c.superseded_at IS NOT NULL ORDER BY c.superseded_at DESC, c.id DESC LIMIT 5").all(taskId, companyId) as TaskCiProjection["supersededRuns"]);
    const continuity = this.database.authQuery((db) => db.prepare(`SELECT
      EXISTS (SELECT 1 FROM forge_ci_repair_plans p JOIN forge_agent_executions o ON o.task_id = p.task_id AND o.company_id = p.company_id AND o.workflow_id = p.workflow_id AND o.session_ref = p.lead_session_ref WHERE p.task_id = ? AND p.company_id = ?) AS lead,
      EXISTS (SELECT 1 FROM forge_ci_repairs x JOIN forge_ci_repair_plans p ON p.id = x.repair_plan_id JOIN forge_developer_executions d ON d.id = x.prior_developer_execution_id AND d.task_id = p.task_id AND d.company_id = p.company_id AND d.workflow_id = p.workflow_id WHERE p.task_id = ? AND p.company_id = ? AND d.session_ref = x.prior_developer_session_ref AND x.result_developer_session_ref = x.prior_developer_session_ref) AS developer`).get(taskId, companyId, taskId, companyId) as { lead: number; developer: number });
    const policyDefaults: TaskCiProjection["policy"] = { projectRevisionId: "", requiredChecks: [], acceptedConclusions: ["success", "skipped"] };
    // A degenerate policy_json (empty/partial row) must never fail the whole task list — fill from defaults.
    const policy: TaskCiProjection["policy"] = { ...policyDefaults, ...json<Partial<TaskCiProjection["policy"]>>(run.policyJson || "{}", {}), acceptedConclusions: ["success", "skipped"] };
    return { runId: run.runId, releaseId: run.releaseId, repository: run.repository, pullRequestNumber: run.pullRequestNumber, pullRequestUrl: run.pullRequestUrl, baseBranch: run.baseBranch, headBranch: run.headBranch, expectedHeadSha: run.expectedHeadSha, expectedHeadTree: run.expectedHeadTree, status: run.status, outcome: latest?.outcome ?? null, reason: latest?.reason ?? null, owner: latest?.owner ?? null, repairable: latest?.repairable ?? false, policyHash: run.policyHash ?? "", policy, leadSessionContinuity: continuity.lead === 1, developerSessionContinuity: continuity.developer === 1, firstObservedAt: run.firstObservedAt, propagationDeadline: run.propagationDeadline, overallDeadline: run.overallDeadline, nextRetryAt: run.nextRetryAt, completedAt: run.completedAt, supersededAt: run.supersededAt, supersededRuns, attempts, repairPlan, repairs };
/*
    if (content.kind === "plan") return { kind: "plan", summary: row.summary, executionId: row.execution_id, outputArtifactId: row.output_artifact_id, evidenceArtifactId: row.evidence_artifact_id, content };
    return { kind: "decision_blocker", summary: row.summary, executionId: row.execution_id, outputArtifactId: row.output_artifact_id, evidenceArtifactId: row.evidence_artifact_id, content };
*/
  }

  private taskQuery(scope: string): string {
    return `SELECT t.id, t.company_id, t.project_id, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issue_key, t.title, t.archived_at, t.brief_artifact_id, t.description, t.image_artifact_ids_json, t.role_agents_json, t.supplemental_review, t.auto_approve_plan, t.auto_approve_plan AS autoApprovePlan, t.pull_request_mode, t.delivery_target, t.run_project_tests, t.visual_evidence, t.delivery_worktree_path, t.delivery_branch_name, t.delivery_commit, t.workflow_id, t.project_revision_id, t.predecessor_task_id, t.successor_task_id, t.created_at, t.updated_at, ip.revision AS projection_revision, ip.projected_at, ip.phase, ip.step, ip.owner, ip.allowed_commands_json, ip.pending_action, COALESCE((SELECT s.state_json FROM forge_workflow_snapshots s WHERE s.task_id = t.id AND s.revision = ip.revision), '{}') AS state_json, COALESCE((SELECT json_group_array(json_object('role', rs.session_role, 'status', rs.status)) FROM forge_herdr_role_sessions rs WHERE rs.task_id = t.id AND rs.is_current = 1), '[]') AS live_status_json FROM forge_tasks t JOIN forge_companies c ON c.id = t.company_id JOIN forge_issue_projections ip ON ip.task_id = t.id LEFT JOIN forge_memberships m ON m.company_id = t.company_id WHERE ${scope}`;
  }

  private user(userId: string): AuthUser {
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new AuthFailure("Authentication required", 401);
    return user;
  }
}

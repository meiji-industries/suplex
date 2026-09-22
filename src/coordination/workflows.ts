import { z } from "zod";
import { AdvisorResultSchema, AdvisorRoleSchema, REPAIR_RATING_TARGET, RaterResultSchema, ReviewerResultSchema, type AdvisorRole } from "./advisor-report.js";

export { AdvisorResultSchema, AdvisorRoleSchema, PlannerResultSchema, REPAIR_RATING_TARGET, RaterResultSchema, ReviewerResultSchema, parseAdvisorReport } from "./advisor-report.js";
export type { AdvisorResult, AdvisorRole, RaterResult, ReviewerResult } from "./advisor-report.js";

// Shared workflow catalog, schemas, and pure policy helpers. Frontend-safe: zod only.

const id = z.string().min(1).max(256);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/i);
export const WorkflowIdSchema = z.enum(["standard", "direct_build", "independent_review", "competing_plans", "refine_pull_request"]);
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;
export const AdvisorProfileIdsSchema = z.object({ reviewer: id.optional(), planner_a: id.optional(), planner_b: id.optional(), rater: id.optional() }).strict();
export type AdvisorProfileIds = z.infer<typeof AdvisorProfileIdsSchema>;

export interface WorkflowDefinition {
  id: WorkflowId;
  name: string;
  description: string;
  advisorRoles: AdvisorRole[];
  agents: string;
  delivery: string;
  steps: string[];
}

export const WORKFLOWS: readonly WorkflowDefinition[] = [
  { id: "standard", name: "Standard", description: "Coordinator plans, Worker builds, and Coordinator reviews the result.", advisorRoles: [], agents: "Coordinator, Worker", delivery: "Selected target",
    steps: ["Coordinator reads the source and writes the plan and acceptance criteria.", "Worker builds the plan and runs the checks.", "Coordinator reviews the changes and the check evidence.", "Coordinator requests the selected delivery target."] },
  { id: "direct_build", name: "Direct build", description: "Worker builds from your instructions. Coordinator reviews the result before delivery.", advisorRoles: [], agents: "Coordinator, Worker", delivery: "Selected target",
    steps: ["Coordinator observes the source and delegates Worker with your instructions.", "Worker chooses the approach, builds, and runs the checks.", "Coordinator reviews the changes and the check evidence.", "Coordinator requests the selected delivery target."] },
  { id: "independent_review", name: "Second opinion", description: "A separate Reviewer checks the changes before Coordinator delivers the result.", advisorRoles: ["reviewer"], agents: "Coordinator, Worker, Reviewer", delivery: "Selected target",
    steps: ["Coordinator writes the plan and acceptance criteria.", "Worker builds the plan and runs the checks.", "Coordinator reviews the changes and the check evidence.", "Reviewer inspects the complete change independently.", "Worker repairs every blocking finding, then Reviewer makes a new assessment of the current change.", "Coordinator requests the selected delivery target after Reviewer approves."] },
  { id: "competing_plans", name: "Combined planning", description: "Two agents write separate plans. Coordinator combines them and assigns the build to Worker.", advisorRoles: ["planner_a", "planner_b"], agents: "Coordinator, Worker, Plan A, Plan B", delivery: "Selected target",
    steps: ["Plan A writes an implementation plan from the objective.", "Plan B writes a separate plan from the same objective.", "Coordinator combines both plans into one plan with acceptance criteria.", "Worker builds the combined plan and runs the checks.", "Coordinator reviews the changes and requests the selected delivery target."] },
  { id: "refine_pull_request", name: "Pull request repair", description: "Rater reviews an existing pull request. Worker applies repairs until it scores at least 9/10. Forge then pushes and merges it.", advisorRoles: ["rater"], agents: "Coordinator, Worker, Rater", delivery: "Merged pull request",
    steps: ["Rater rates the existing pull request from 1 to 10 and writes a repair plan.", "Worker applies the repair plan and runs the checks.", "Rater makes a new assessment of the current result. Forge repeats until the rating is at least 9/10.", "Forge pushes the branch and observes the checks.", "If CI fails, Rater reviews the failure and Worker repairs it.", "Forge merges the same pull request after GitHub reports it ready."] },
];

export function workflowDefinition(workflow: WorkflowId): WorkflowDefinition {
  return WORKFLOWS.find(definition => definition.id === workflow)!;
}

export const ADVISOR_LABELS: Record<AdvisorRole, string> = { reviewer: "Reviewer", planner_a: "Plan A", planner_b: "Plan B", rater: "Rater" };

/** One label helper for native titles, panes, API labels, and UI. */
export function roleLabel(session: { kind: "root" | "worker"; advisorRole?: AdvisorRole | null | undefined }): string {
  if (session.kind === "root") return "Coordinator";
  return session.advisorRole ? ADVISOR_LABELS[session.advisorRole] : "Worker";
}

export const ReviewRangeSchema = z.object({ baseSha: commit, headSha: commit, files: z.array(z.string().min(1)), commits: z.array(commit), patchDigest: z.string().optional() }).strict();
export type ReviewRange = z.infer<typeof ReviewRangeSchema>;

/** Two ranges are review-equivalent when head, commit set, and file set are identical and either the base is identical or the sha256 digests of the complete three-dot patch are identical; file names, commit counts, and the truncated display patch are never sufficient. */
export function rangeDifferences(review: ReviewRange, actual: ReviewRange): string[] {
  const same = (left: string[], right: string[]) => {
    const sortedRight = [...right].sort();
    return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index]);
  };
  const differences: string[] = [];
  if (review.headSha !== actual.headSha) differences.push("head");
  if (!same(review.commits, actual.commits)) differences.push("commits");
  if (!same(review.files, actual.files)) differences.push("files");
  if (review.baseSha !== actual.baseSha && (!review.patchDigest || !actual.patchDigest || review.patchDigest !== actual.patchDigest)) differences.push("patch content");
  return differences;
}

export function sameRange(review: ReviewRange, actual: ReviewRange): boolean {
  return rangeDifferences(review, actual).length === 0;
}

const verified = (verification: "passed" | "not_applicable" | "missing" | "failed") => verification === "passed" || verification === "not_applicable";

const reviewRecordBase = { sessionId: id, turnId: id, range: ReviewRangeSchema, invalidReason: z.string().nullable(), recordedAt: z.string() };
export const ReviewRecordSchema = z.discriminatedUnion("role", [
  z.object({ ...reviewRecordBase, role: z.literal("reviewer"), result: ReviewerResultSchema.nullable() }).strict(),
  z.object({ ...reviewRecordBase, role: z.literal("rater"), result: RaterResultSchema.nullable() }).strict(),
]);
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const ReportReferenceSchema = z.object({ sessionId: id, turnId: id }).strict();
export type ReportReference = z.infer<typeof ReportReferenceSchema>;
const AdvisorWorkflowInputSchema = z.object({ kind: z.literal("advisor"), role: AdvisorRoleSchema, range: ReviewRangeSchema, evidenceDirectory: z.string().min(1), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), verificationTurnIds: z.array(id), plannerPairId: id.optional() }).strict();
const WorkerInputBase = { kind: z.literal("worker"), mode: z.enum(["planned", "direct"]), purpose: z.enum(["implementation", "verification"]), range: ReviewRangeSchema, plan: z.string().nullable(), acceptanceCriteria: z.array(z.string()), instruction: z.string() };
const LegacyWorkerWorkflowInputSchema = z.object({ ...WorkerInputBase, advisorSessionId: id.nullable(), candidateSessionIds: z.tuple([id, id]).nullable() }).strict();
export const WorkerWorkflowInputSchema = z.object({ ...WorkerInputBase, version: z.literal(2), advisorReport: ReportReferenceSchema.nullable(), candidateReports: z.tuple([ReportReferenceSchema, ReportReferenceSchema]).nullable() }).strict();
export const WorkflowInputSchema = z.union([AdvisorWorkflowInputSchema, WorkerWorkflowInputSchema, LegacyWorkerWorkflowInputSchema]);
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;
export type WorkerWorkflowInput = Extract<WorkflowInput, { kind: "worker" }>;

export function workerCandidateReports(input: WorkerWorkflowInput): [ReportReference, ReportReference] | null {
  if ("version" in input) return input.candidateReports;
  if (!input.candidateSessionIds) return null;
  const [first, second] = input.candidateSessionIds;
  return [{ sessionId: first, turnId: first }, { sessionId: second, turnId: second }];
}

/** Proof that a check-only Worker ran against one committed source: identical clean endpoints before and after. */
export const VerificationRangeSchema = z.object({ before: ReviewRangeSchema, after: ReviewRangeSchema.nullable(), cleanAfter: z.boolean().nullable(), valid: z.boolean(), invalidReason: z.string().nullable() }).strict();
export type VerificationRange = z.infer<typeof VerificationRangeSchema>;

export const DeliveryWaitSchema = z.object({ headSha: z.string().min(1), fingerprint: z.string().min(1), since: z.string(), reason: z.enum(["checks", "mergeability", "merge_queue", "observation"]) }).strict();
export type DeliveryWait = z.infer<typeof DeliveryWaitSchema>;
export const WorkflowCompletionSchema = z.object({ kind: z.enum(["workflow", "external_merge"]), reviewedHead: z.string().nullable(), pullRequestNumber: z.number().int().positive().nullable(), observedAt: z.string() }).strict();
export type WorkflowCompletion = z.infer<typeof WorkflowCompletionSchema>;
export const PublicWorkflowStateSchema = z.object({ version: z.literal(1), reviews: z.array(ReviewRecordSchema), acceptedDelivery: ReviewRangeSchema.nullable(), deliveryWait: DeliveryWaitSchema.nullable(), completion: WorkflowCompletionSchema.nullable() }).strict();
export const AgentSelectionIntentSchema = z.object({ role: z.enum(["root", "worker", ...AdvisorRoleSchema.options]), expectedProfileId: z.string(), expectedSessionId: z.string().nullable(), profileId: z.string(), direction: z.string(), resume: z.boolean(), questionId: z.string().nullable() }).strict();
export const WorkflowStateSchema = PublicWorkflowStateSchema.extend({ followUp: z.boolean().optional(), deliveryHistory: z.array(z.object({ resumedAt: z.string(), acceptedDelivery: ReviewRangeSchema.nullable(), completion: WorkflowCompletionSchema.nullable() }).strict()).optional(), toolOwner: z.object({ token: z.string().min(1), pid: z.number().int().positive(), processStartTime: z.string().min(1) }).strict().nullable(), agentSelections: z.partialRecord(z.enum(["root", "worker", ...AdvisorRoleSchema.options]), AgentSelectionIntentSchema).optional(), initialRootSelectionSessionId: z.string().optional() }).strict();
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type PublicWorkflowState = z.infer<typeof PublicWorkflowStateSchema>;

export function emptyWorkflowState(): WorkflowState { return { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null, toolOwner: null }; }
export function publicWorkflowState(state: WorkflowState): PublicWorkflowState {
  return { version: state.version, reviews: state.reviews, acceptedDelivery: state.acceptedDelivery, deliveryWait: state.deliveryWait, completion: state.completion };
}

export class WorkflowInputFailure extends Error {
  readonly statusCode = 422;
  constructor(message: string) { super(message); this.name = "WorkflowInputFailure"; }
}

export type RawWorkflowInput = { workflow?: unknown; advisorProfileIds?: unknown; deliveryTarget?: unknown; runProjectTests?: unknown; source?: unknown; [key: string]: unknown };

/** Applies workflow defaults before schema defaults can erase whether a caller supplied a field. */
export function normalizeWorkflowInput<T extends RawWorkflowInput>(raw: T, options: { requireSource: boolean }): T & { workflow: WorkflowId; advisorProfileIds: AdvisorProfileIds } {
  if (typeof raw !== "object" || raw === null) throw new WorkflowInputFailure("The task request is not an object");
  const workflow = WorkflowIdSchema.safeParse(raw.workflow ?? "standard");
  if (!workflow.success) throw new WorkflowInputFailure("The selected workflow does not exist");
  const advisors = AdvisorProfileIdsSchema.safeParse(raw.advisorProfileIds ?? {});
  if (!advisors.success) throw new WorkflowInputFailure("The Advisor profile selection is not valid");
  const allowed = workflowDefinition(workflow.data).advisorRoles;
  const extra = AdvisorRoleSchema.options.filter(role => advisors.data[role] !== undefined && !allowed.includes(role));
  if (extra.length) throw new WorkflowInputFailure(`The ${workflowDefinition(workflow.data).name} workflow has no ${extra.map(role => ADVISOR_LABELS[role]).join(", ")} Advisor`);
  const result = { ...raw, workflow: workflow.data, advisorProfileIds: advisors.data };
  if (workflow.data !== "refine_pull_request") return result;
  if (raw.deliveryTarget !== undefined && raw.deliveryTarget !== "merged") throw new WorkflowInputFailure("Pull request repair always delivers a merged pull request");
  if (raw.runProjectTests !== undefined && raw.runProjectTests !== true) throw new WorkflowInputFailure("Pull request repair always runs the project tests");
  const source = raw.source as { kind?: unknown } | undefined;
  if (options.requireSource && source?.kind !== "pull_request") throw new WorkflowInputFailure("Select a pull request source for Pull request repair");
  return { ...result, deliveryTarget: "merged", runProjectTests: true };
}

export function advisorKeysSorted(ids: AdvisorProfileIds): Record<string, string> {
  return Object.fromEntries(Object.entries(ids).flatMap(([key, value]) => value === undefined ? [] : [[key, value] as [string, string]]).sort(([left], [right]) => left.localeCompare(right)));
}

/** The advisor outcome that Forge stored inside an Advisor turn's terminal observation. */
export const AdvisorOutcomeSchema = z.object({ role: AdvisorRoleSchema, result: AdvisorResultSchema.nullable(), invalidReason: z.string().nullable() });
export type AdvisorOutcome = z.infer<typeof AdvisorOutcomeSchema>;
export function turnOutcome(observation: string | null): { state: string | null; advisor: AdvisorOutcome | null; text: string | null } {
  if (!observation) return { state: null, advisor: null, text: null };
  try {
    const parsed = z.object({ state: z.string().optional(), text: z.string().optional(), advisor: AdvisorOutcomeSchema.optional() }).safeParse(JSON.parse(observation));
    if (!parsed.success) return { state: null, advisor: null, text: null };
    return { state: parsed.data.state ?? null, advisor: parsed.data.advisor ?? null, text: parsed.data.text ?? null };
  } catch { return { state: null, advisor: null, text: null }; }
}

type SessionLike = { id: string; kind: "root" | "worker"; advisorRole: AdvisorRole | null; workflowInput: WorkflowInput | null };
type TurnLike = { id?: string; sessionId: string; generation?: number; status: string; terminalObservation: string | null; workflowInput?: WorkflowInput | null };
type ControlLike = { workflow: WorkflowId; workflowState: WorkflowState };

export function latestReview(reviews: ReviewRecord[], role: "reviewer" | "rater"): ReviewRecord | undefined {
  return reviews.filter(record => record.role === role).at(-1);
}

/** Pure gate over the latest Reviewer or Rater record; a newer invalid or negative record supersedes an earlier positive one. */
export function reviewGate(workflow: WorkflowId, reviews: ReviewRecord[], actualRange: ReviewRange): { ok: true } | { ok: false; reason: string } {
  if (workflow !== "independent_review" && workflow !== "refine_pull_request") return { ok: true };
  const role = workflow === "independent_review" ? "reviewer" : "rater";
  const latest = latestReview(reviews, role);
  if (!latest) return { ok: false, reason: `No ${ADVISOR_LABELS[role]} result exists yet. Request ${ADVISOR_LABELS[role]} for the current range.` };
  if (!latest.result) return { ok: false, reason: `The latest ${ADVISOR_LABELS[role]} result is invalid: ${latest.invalidReason ?? "unknown"}. Request a new ${ADVISOR_LABELS[role]} assessment.` };
  if (!sameRange(latest.range, actualRange)) return { ok: false, reason: `The latest ${ADVISOR_LABELS[role]} result reviewed ${latest.range.baseSha.slice(0, 12)}..${latest.range.headSha.slice(0, 12)}, not the current range. Request a new ${ADVISOR_LABELS[role]} assessment.` };
  if (latest.result.role === "reviewer") return latest.result.approved ? { ok: true } : { ok: false, reason: "Reviewer did not approve the current range. Repair every blocking finding and request a new Reviewer assessment." };
  if (latest.result.rating < REPAIR_RATING_TARGET) return { ok: false, reason: `Rater scored the current range ${latest.result.rating}/10. Repair the findings and request a new Rater assessment.` };
  if (latest.result.blockingFindings.length || !verified(latest.result.verification)) return { ok: false, reason: "The Rater result carries blocking findings or missing verification." };
  return { ok: true };
}

function inputForTurn(sessions: SessionLike[], turn: TurnLike): WorkflowInput | null {
  return turn.workflowInput ?? sessions.find(session => session.id === turn.sessionId)?.workflowInput ?? null;
}

function succeeded(turn: TurnLike): boolean {
  return turn.status === "completed" && turnOutcome(turn.terminalObservation).state === "completed";
}

export function validAdvisorSession(sessions: SessionLike[], turns: TurnLike[], sessionId: string, role: AdvisorRole): boolean {
  const session = sessions.find(candidate => candidate.id === sessionId);
  if (!session || session.kind !== "worker" || session.advisorRole !== role) return false;
  return turns.some(turn => turn.sessionId === sessionId && turn.status === "completed" && turnOutcome(turn.terminalObservation).advisor?.result !== null && turnOutcome(turn.terminalObservation).advisor?.role === role);
}

function validAdvisorReference(sessions: SessionLike[], turns: TurnLike[], reference: ReportReference, role: AdvisorRole, exact: boolean): boolean {
  if (!exact) return validAdvisorSession(sessions, turns, reference.sessionId, role);
  const session = sessions.find(candidate => candidate.id === reference.sessionId);
  const turn = turns.find(candidate => candidate.id === reference.turnId && candidate.sessionId === reference.sessionId);
  const outcome = turn ? turnOutcome(turn.terminalObservation).advisor : null;
  return session?.kind === "worker" && session.advisorRole === role && turn?.status === "completed" && outcome?.result !== null && outcome?.role === role;
}

/** Whether the workflow's obligations for the actual range are complete. Standard keeps its existing behavior. */
export function workflowReadyForDelivery(control: ControlLike, sessions: SessionLike[], turns: TurnLike[], actualRange: ReviewRange): { ok: true } | { ok: false; reason: string } {
  const workflow = control.workflow;
  if (workflow === "standard") return { ok: true };
  const workers = sessions.filter(session => session.kind === "worker" && session.advisorRole === null);
  if (workflow === "direct_build") {
    return turns.some(turn => {
      const input = inputForTurn(sessions, turn);
      return workers.some(session => session.id === turn.sessionId) && input?.kind === "worker" && input.mode === "direct" && input.purpose === "implementation" && succeeded(turn);
    })
      ? { ok: true } : { ok: false, reason: "Direct build requires a completed Worker assignment in direct mode before delivery." };
  }
  if (workflow === "competing_plans") {
    const build = turns.find(turn => {
      const input = inputForTurn(sessions, turn);
      return workers.some(session => session.id === turn.sessionId) && input?.kind === "worker" && input.plan && workerCandidateReports(input) && succeeded(turn);
    });
    const input = build ? inputForTurn(sessions, build) : null;
    const candidates = input?.kind === "worker" ? workerCandidateReports(input) : null;
    const exact = input?.kind === "worker" && "version" in input;
    if (!build || !candidates || !validAdvisorReference(sessions, turns, candidates[0], "planner_a", exact) || !validAdvisorReference(sessions, turns, candidates[1], "planner_b", exact)) {
      return { ok: false, reason: "Combined planning requires two valid plan reports and a completed Worker build of the combined plan before delivery." };
    }
    return { ok: true };
  }
  return reviewGate(workflow, control.workflowState.reviews, actualRange);
}

export type DeliveryFailureCode = "worktree_missing" | "pull_request_ambiguous" | "pull_request_closed" | "head_diverged" | "delivery_target_mismatch" | "delivery_review_required" | "pull_request_title_required" | "pull_request_body_required" | "workflow_review_required" | "worktree_dirty" | "delegate_active" | "merge_not_eligible" | "observation_unavailable";
export type DeliveryDecision = { ok: true } | { ok: false; code: DeliveryFailureCode; reason: string };
export type LocalSourceFacts = { branch?: string | undefined; headSha?: string | undefined; clean: boolean };
type DeliverySessionLike = SessionLike & { current?: boolean; lifecycle?: string; generation?: number; launchOwner?: string | null };

export function reviewRole(workflow: WorkflowId): "rater" | "reviewer" | null {
  return workflow === "refine_pull_request" ? "rater" : workflow === "independent_review" ? "reviewer" : null;
}

export function freshReviewHint(workflow: WorkflowId): string {
  const role = reviewRole(workflow);
  return role ? ` Inspect the new range and request a new ${ADVISOR_LABELS[role]} assessment.` : " Inspect the new range and review it again.";
}

/**
 * The one delivery policy for non-Standard workflows, applied to one exact range: the source is on the task branch at the reviewed head and clean,
 * no delegate is reserved, live, or unknown, and the workflow's own obligations hold. Pre-publication guards and the completion transaction both call it
 * with freshly observed local facts; the transaction reloads sessions, turns, and reviews so a change after those facts were read is still seen.
 */
export function deliveryDecision(control: ControlLike & { deliveryIntent: { headBranch: string } }, sessions: DeliverySessionLike[], turns: TurnLike[], range: ReviewRange, local: LocalSourceFacts, requireReview = true): DeliveryDecision {
  if (control.workflow === "standard") return { ok: true };
  if (local.branch !== undefined && local.branch !== control.deliveryIntent.headBranch) return { ok: false, code: "head_diverged", reason: `The worktree is on ${local.branch}, not the task branch ${control.deliveryIntent.headBranch}.` };
  if (local.headSha !== undefined && local.headSha !== range.headSha) return { ok: false, code: "head_diverged", reason: `The worktree head ${local.headSha.slice(0, 12)} is not the reviewed head ${range.headSha.slice(0, 12)}.${freshReviewHint(control.workflow)}` };
  if (!local.clean) return { ok: false, code: "worktree_dirty", reason: "The worktree has uncommitted changes. Commit or discard them, inspect delivery again, and review the committed range." };
  const delegate = sessions.find(session => session.kind === "worker" && session.current === true && (session.launchOwner || turns.some(turn => turn.sessionId === session.id && (turn.generation === undefined || session.generation === undefined || turn.generation === session.generation) && ["pending_prompt", "prompted", "unknown"].includes(turn.status))));
  if (delegate) return { ok: false, code: "delegate_active", reason: `${delegate.advisorRole ? ADVISOR_LABELS[delegate.advisorRole] : "Worker"} is still active. Wait for its result before requesting delivery.` };
  if (!requireReview) return { ok: true };
  const ready = workflowReadyForDelivery(control, sessions, turns, range);
  return ready.ok ? { ok: true } : { ok: false, code: "workflow_review_required", reason: ready.reason };
}

type DeliveryWaitObservation = { number: number | null; headSha: string | null; baseSha: string | null; isDraft: boolean | null; reviewDecision: string | null; mergeable: string | null; mergeStateStatus: string | null; state: string | null; checks: { pending: number; failing: number; runs: Array<{ name: string; status: string; conclusion?: string | undefined }> } };

export function deliveryWaitFingerprint(observation: DeliveryWaitObservation): string {
  const failures = observation.checks.runs.filter(run => run.status === "failing").map(run => `${run.name}:${run.status}:${run.conclusion ?? ""}`).sort();
  const checks = [observation.checks.pending > 0 ? "pending" : "settled", ...(observation.checks.failing > 0 ? [`failed:${observation.checks.failing}`, ...failures] : [])];
  return JSON.stringify({ number: observation.number, head: observation.headSha, draft: observation.isDraft, review: observation.reviewDecision, mergeable: observation.mergeable, mergeState: observation.mergeStateStatus, state: observation.state, checks });
}

export function sameDeliveryWaitFingerprint(stored: string, observation: DeliveryWaitObservation): boolean {
  const current = deliveryWaitFingerprint(observation);
  if (stored === current) return true;
  if (observation.checks.pending === 0 || observation.checks.failing > 0) return false;
  try {
    const legacy = z.object({ number: z.number().nullable(), head: z.string().nullable(), draft: z.boolean().nullable(), review: z.string().nullable(), mergeable: z.string().nullable(), mergeState: z.string().nullable(), state: z.string().nullable(), checks: z.array(z.string()) }).strict().safeParse(JSON.parse(stored));
    if (!legacy.success || !legacy.data.checks.some(check => check.endsWith(":pending:")) || legacy.data.checks.some(check => check.includes(":failing:"))) return false;
    return JSON.stringify({ ...legacy.data, checks: ["pending"] }) === current;
  } catch { return false; }
}

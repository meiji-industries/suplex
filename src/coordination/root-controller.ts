import type { WorkerReplacementRequest } from "./worker-replacement-contracts.js";
import type { HumanQuestionOptions } from "./human-question.js";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ArtifactStore } from "../platform/artifacts.js";
import { DeliveryOperationFailure, DeliveryOperations } from "../delivery/operations.js";
import { GithubReleaseFailure } from "../integrations/github/failure.js";
import type { RootBridgeAdapter } from "./root-bridge.js";
import type { AdvisorRequest, DeliveryOperation, DeliveryReview, PullRequestBody, PullRequestTitle, RootIdentity, RootImageResult, WorkerAssignment, WorkerEvidenceRequest } from "./root-contracts.js";
import type { TaskControlStore } from "./root-session-store.js";
import type { TaskControl, TaskSession } from "../tasks/control.js";
import type { NativeSessionReader, TaskHarness, TaskScope } from "../runtimes/task-harness.js";
import { writeTaskEvidence } from "./workflow-evidence.js";
import { composeAdvisorAssignment, composeWorkerAssignment, initialCoordinatorPrompt } from "./workflow-prompts.js";
import { ADVISOR_LABELS, latestReview, publicWorkflowState, sameRange, turnOutcome, workflowDefinition, type ReportReference, type ReviewRange, type WorkflowInput, type WorkerWorkflowInput } from "./workflows.js";
import { readWorkerEvidence } from "./worker-turn-evidence.js";
import type { ModelPricingCatalog } from "../profiles/model-pricing.js";
import { ModelsDevCatalogReader } from "../profiles/models-dev-catalog.js";
import { findAdvisorReport, observeWorktree, resolveAdvisorReport, summarizeWorkerObservation, turnWorkflowInput } from "./controller-reports.js";
import { prepareAdvisorEvidence } from "./advisor-evidence.js";
import { reconcileCompletedAdvisorReport, recoverSession, stopRetiredSessions, type SessionRecoveryDependencies } from "./session-recovery.js";
import type { AdvisorReportOutcome } from "./advisor-report.js";

export type TaskDelivery = Pick<DeliveryOperations, "observe" | "execute" | "currentRange"> & Partial<Pick<DeliveryOperations, "checksObservation">>;
type AcceptedWorkerAssignment = { kind: "workflow_input"; input: WorkerWorkflowInput } | { kind: "saved_prompt"; prompt: string };

const advisorSuccess = "End this Coordinator turn now. Forge will send the Advisor's native report as a new turn on this same session. Do not poll or wait inside this turn.";
const defaultPricing = new ModelsDevCatalogReader();
const readDefaultPricing = () => defaultPricing.read();

export class RootController implements RootBridgeAdapter {
  constructor(readonly store: TaskControlStore, private readonly harness: TaskHarness, private readonly delivery: TaskDelivery = new DeliveryOperations(store), private readonly artifacts?: ArtifactStore, private readonly evidence?: { root: string }, private readonly reader?: (session: TaskSession) => Pick<NativeSessionReader, "turnEvidence"> & Partial<Pick<NativeSessionReader, "timeline">>, private readonly readPricing: () => Promise<ModelPricingCatalog | undefined> = readDefaultPricing) {}

  private scope(control: TaskControl, session: TaskSession, workflowInput: WorkflowInput | null = null): TaskScope {
    if (!control.worktree) throw new Error("Task worktree is not configured");
    const advisorRole = session.kind === "worker" ? session.advisorRole : null;
    const selected = session.profile ?? (session.kind === "root" ? control.rootProfile : advisorRole ? control.advisorProfiles[advisorRole] ?? control.rootProfile : control.workerProfile);
    const common = {
      id: session.id, taskId: control.taskId, directory: control.worktree.path, workflow: control.workflow, evidenceRoot: this.evidenceRoot(control.taskId),
      profile: { providerID: selected.provider, modelID: selected.model, reasoningEffort: selected.reasoningLevel, serviceTier: selected.serviceTier, instanceHomeDirectory: selected.instanceHomeDirectory ?? null },
    };
    if (session.kind === "root") return { ...common, role: "root", identity: { taskId: control.taskId, sessionId: session.id, generation: session.generation } };
    if (advisorRole) return { ...common, role: "advisor", advisorRole, label: ADVISOR_LABELS[advisorRole] };
    const input = workflowInput?.kind === "worker" ? workflowInput : null;
    return { ...common, role: "worker", workerMode: input?.mode ?? "planned", purpose: input?.purpose ?? "implementation" };
  }

  private evidenceRoot(taskId: string): string | null {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw new Error("Invalid task identity");
    return this.evidence ? join(this.evidence.root, taskId) : null;
  }

  private readonly tokens = new Map<string, string>();

  async assertCurrentRoot(root: RootIdentity): Promise<void> { this.store.assertCurrentRoot(root); }

  async claimToolOwner(root: RootIdentity): Promise<string | null> {
    const token = await this.store.claimToolOwner(root.taskId);
    if (token) this.tokens.set(root.taskId, token);
    return token;
  }

  async releaseToolOwner(root: RootIdentity, token: string): Promise<void> {
    if (this.tokens.get(root.taskId) === token) this.tokens.delete(root.taskId);
    this.store.releaseToolOwner(root.taskId, token);
  }

  /** Before an external mutation: the root is still current and this bridge still owns the task's tool token. */
  private recheck(root: RootIdentity): void {
    this.store.assertCurrentRoot(root);
    const token = this.tokens.get(root.taskId);
    if (token) this.store.assertToolOwner(root.taskId, token);
  }

  async readImage(root: RootIdentity, artifactId: string): Promise<RootImageResult> {
    this.store.assertCurrentRoot(root);
    if (!this.artifacts) throw new Error("Task image storage is not configured");
    const artifact = this.store.image(root.taskId, artifactId);
    const bytes = await this.artifacts.getArtifact(artifact);
    this.store.assertCurrentRoot(root);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("The task image changed in storage");
    return { kind: "image", filename: artifact.filename, mimeType: artifact.mimeType, data: bytes.toString("base64") };
  }

  async observe(root: RootIdentity): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    const control = this.store.get(root.taskId);
    let pullRequest = control.pullRequest;
    let github: { available: boolean; code?: string; message?: string; retry?: string } = { available: true };
    try { pullRequest = await this.delivery.observe(root.taskId); }
    catch (error) {
      if (!(error instanceof GithubReleaseFailure || error instanceof DeliveryOperationFailure)) throw error;
      github = { available: false, code: error.code, message: error.message, retry: "Forge re-observes on its normal cadence; continue local review and repair. Ask a human only for authentication or a missing executable." };
    }
    const worktree = control.worktree ? await observeWorktree(control.worktree.path) : null;
    const workers = this.store.currentDelegates(root.taskId);
    const worker = this.store.currentSession(root.taskId, "worker");
    const results = Object.fromEntries(workers.map(session => {
      const turn = this.store.turns(root.taskId).filter(candidate => candidate.sessionId === session.id && candidate.status === "completed").at(-1);
      return [session.id, turn ? summarizeWorkerObservation(turn) : null];
    }));
    const workerResult = worker ? results[worker.id] ?? null : null;
    const acceptedAssignment = worker?.advisorRole === null ? this.acceptedWorkerAssignment(root.taskId, worker) : null;
    return { control: { ...this.store.get(root.taskId), workflowState: publicWorkflowState(this.store.get(root.taskId).workflowState) }, context: this.store.context(root.taskId), root: this.store.currentSession(root.taskId, "root"), worker, acceptedAssignment, workerResult, workers, results, worktree, pullRequest, github };
  }

  private acceptedWorkerAssignment(taskId: string, worker: TaskSession): AcceptedWorkerAssignment | null {
    const turn = this.store.turns(taskId).filter(candidate => candidate.sessionId === worker.id && candidate.generation === worker.generation).at(-1);
    if (!turn) return null;
    return turn.workflowInput?.kind === "worker" ? { kind: "workflow_input", input: turn.workflowInput } : { kind: "saved_prompt", prompt: turn.promptText };
  }

  async readWorkerEvidence(root: RootIdentity, request: WorkerEvidenceRequest) {
    this.store.assertCurrentRoot(root);
    if (!this.reader) throw new Error("Native session evidence reading is not configured");
    const turn = this.store.turns(root.taskId).find(candidate => candidate.id === request.turnId);
    const session = turn ? this.store.sessions(root.taskId).find(candidate => candidate.id === turn.sessionId) : undefined;
    if (!turn || !session || session.kind !== "worker" || session.advisorRole !== null) throw new Error("Worker turn does not belong to this task");
    const evidence = await this.reader(session).turnEvidence(session, turn.id);
    return { turnId: turn.id, sessionId: session.id, localObservation: { status: turn.status, terminalObservationAvailable: turn.terminalObservation !== null, nativeTurnIdAvailable: turn.nativeTurnId !== null }, limitation: evidence.limitation, ...readWorkerEvidence(evidence.tools, { toolId: request.toolId, field: request.field, position: request.position, cursor: request.cursor, maxCharacters: request.maxCharacters ?? 12_000 }) };
  }

  async replaceWorker(root: RootIdentity, request: WorkerReplacementRequest): Promise<unknown> {
    this.recheck(root);
    const worker = this.store.replaceWorker(root.taskId, request);
    return { worker, acceptedAssignment: this.acceptedWorkerAssignment(root.taskId, worker), next: "End this Coordinator turn. Forge will stop the outgoing execution before starting this fresh Worker. Existing task limits remain in effect." };
  }

  async delegateWorker(root: RootIdentity, assignment: WorkerAssignment): Promise<unknown> {
    const control = this.store.get(root.taskId);
    const mode = assignment.mode ?? "planned";
    const purpose = assignment.purpose ?? "implementation";
    if (mode === "direct" && control.workflow !== "direct_build") throw new Error("Direct mode is legal only for the Direct build workflow. Supply a plan in planned mode.");
    if (mode === "planned" && !assignment.plan) throw new Error("A planned assignment requires the Coordinator's plan.");
    if (control.workflow === "standard") {
      let workflowInput: WorkerWorkflowInput | undefined;
      let range: ReviewRange | undefined;
      if (purpose === "verification") {
        this.recheck(root);
        const observed = await this.currentRange(root.taskId);
        if (!observed.clean) throw new DeliveryOperationFailure("worktree_dirty", "The worktree has uncommitted changes. A check-only assignment needs a committed source; commit or discard the changes first.");
        range = observed.range;
        workflowInput = { kind: "worker", version: 2, mode: "planned", purpose, range, plan: assignment.plan ?? null, acceptanceCriteria: assignment.acceptanceCriteria, instruction: assignment.instruction, advisorReport: null, candidateReports: null };
      }
      const instruction = composeWorkerAssignment({ mode: "planned", purpose, plan: assignment.plan ?? null, acceptanceCriteria: assignment.acceptanceCriteria, instruction: assignment.instruction, visualEvidence: this.store.context(root.taskId).configuration.visualEvidence, ...(range ? { range } : {}) });
      const worker = this.store.launchWorker({ taskId: root.taskId, rootSessionId: root.sessionId, rootGeneration: root.generation, instruction, ...(workflowInput ? { workflowInput } : {}) });
      return { worker, acceptedAssignment: this.acceptedWorkerAssignment(root.taskId, worker), next: "End this Coordinator turn now. Forge will send the Worker's native result as a new turn on this same session. Do not poll or wait inside this turn." };
    }
    this.recheck(root);
    const observed = await this.currentRange(root.taskId);
    if (purpose === "verification" && !observed.clean) throw new DeliveryOperationFailure("worktree_dirty", "The worktree has uncommitted changes. A check-only assignment needs a committed source; commit or discard the changes first.");
    const range = observed.range;
    const sessions = this.store.sessions(root.taskId);
    const turns = this.store.turns(root.taskId);
    let advisorReport: { label: string; text: string } | undefined;
    let candidateReports: [ReportReference, ReportReference] | null = null;
    if (control.workflow === "competing_plans" && purpose === "implementation") {
      const built = turns.some(turn => {
        const session = sessions.find(candidate => candidate.id === turn.sessionId);
        const input = session ? turnWorkflowInput(session, turn) : null;
        return session?.kind === "worker" && session.advisorRole === null && input?.kind === "worker" && input.purpose === "implementation" && turn.status === "completed" && turnOutcome(turn.terminalObservation).state === "completed";
      });
      if (!built) {
        const requested = assignment.candidateTurnIds ?? assignment.candidateSessionIds;
        if (!requested) throw new Error("Combined planning requires candidateSessionIds or candidateTurnIds [Plan A, Plan B] for the first implementation.");
        const [a, b] = requested;
        if (a === b) throw new Error("candidateSessionIds must name two distinct Advisor sessions.");
        const reports: ReportReference[] = [];
        for (const [id, role] of [[a, "planner_a"], [b, "planner_b"]] as const) {
          const report = resolveAdvisorReport(sessions, turns, role, assignment.candidateTurnIds ? { turnId: id } : { sessionId: id });
          if (!report) throw new Error(`${ADVISOR_LABELS[role]} session ${id} is not a completed valid ${ADVISOR_LABELS[role]} report for this task.`);
          if (!sameRange(report.input.range, range)) throw new Error(`${ADVISOR_LABELS[role]} planned against a different source range. Request new plans for the current range.`);
          reports.push({ sessionId: report.session.id, turnId: report.turn.id });
        }
        const [first, second] = reports;
        if (!first || !second) throw new Error("Combined planning requires two report turns.");
        candidateReports = [first, second];
      }
    }
    if ((assignment.candidateTurnIds || assignment.candidateSessionIds) && control.workflow !== "competing_plans") throw new Error("candidateTurnIds apply only to Combined planning.");
    let advisorReportReference: ReportReference | null = null;
    if (control.workflow === "refine_pull_request" && purpose === "implementation") {
      const requested = assignment.advisorTurnId ?? assignment.advisorSessionId;
      if (!requested) throw new Error("Pull request repair implementation requires advisorSessionId or advisorTurnId for the latest valid Rater report.");
      const latest = latestReview(control.workflowState.reviews, "rater");
      const matches = assignment.advisorTurnId ? latest?.turnId === requested : latest?.sessionId === requested;
      if (!latest || !matches || !latest.result) throw new Error("advisorTurnId must be the latest valid Rater report for this task.");
      const report = turns.find(turn => turn.id === latest.turnId && turn.sessionId === latest.sessionId && turn.status === "completed");
      if (!report) throw new Error("The latest Rater report turn is missing.");
      advisorReport = { label: "Rater", text: turnOutcome(report?.terminalObservation ?? null).text ?? "" };
      advisorReportReference = { sessionId: latest.sessionId, turnId: latest.turnId };
    } else if (assignment.advisorTurnId || assignment.advisorSessionId) {
      const requested = assignment.advisorTurnId ?? assignment.advisorSessionId;
      if (!requested) throw new Error("The Advisor reference is missing.");
      const report = findAdvisorReport(sessions, turns, assignment.advisorTurnId ? { turnId: requested } : { sessionId: requested });
      if (!report) throw new Error("The Advisor reference does not name a completed report for this task.");
      advisorReportReference = { sessionId: report.session.id, turnId: report.turn.id };
    }
    const instruction = composeWorkerAssignment({ mode, purpose, plan: assignment.plan ?? null, acceptanceCriteria: assignment.acceptanceCriteria, instruction: assignment.instruction, visualEvidence: this.store.context(root.taskId).configuration.visualEvidence, range, advisorReport });
    const workflowInput: WorkerWorkflowInput = { kind: "worker", version: 2, mode, purpose, range, plan: assignment.plan ?? null, acceptanceCriteria: assignment.acceptanceCriteria, instruction: assignment.instruction, advisorReport: advisorReportReference, candidateReports };
    const worker = this.store.launchWorker({ taskId: root.taskId, rootSessionId: root.sessionId, rootGeneration: root.generation, instruction, workflowInput });
    return { worker, acceptedAssignment: this.acceptedWorkerAssignment(root.taskId, worker), next: "End this Coordinator turn now. Forge will send the Worker's native result as a new turn on this same session. Do not poll or wait inside this turn." };
  }

  async delegateAdvisor(root: RootIdentity, request: AdvisorRequest): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    const control = this.store.get(root.taskId);
    const definition = workflowDefinition(control.workflow);
    const label = ADVISOR_LABELS[request.role];
    if (!definition.advisorRoles.includes(request.role)) throw new Error(`The ${definition.name} workflow has no ${label} Advisor.`);
    if (request.brief && request.role !== "reviewer") throw new Error(`Forge composes the ${label} input; a brief is accepted only for Reviewer.`);
    if (request.role === "reviewer" && !request.brief) throw new Error("Reviewer requires a brief with your plan and acceptance criteria.");
    const sessions = this.store.sessions(root.taskId);
    const turns = this.store.turns(root.taskId);
    if (!control.worktree) throw new Error("The task has no worktree");
    this.recheck(root);
    const observedSource = await this.currentRange(root.taskId);
    if (!observedSource.clean) throw new DeliveryOperationFailure("worktree_dirty", "The worktree has uncommitted changes. Commit or discard them before requesting an Advisor; Advisors review committed source only.");
    const range = observedSource.range;
    const { context, images, workerTurns, evidence, attachments } = await prepareAdvisorEvidence({ store: this.store, delivery: this.delivery, artifacts: this.artifacts, evidenceRoot: this.evidence?.root, control, range, sessions, turns });
    const previous = request.role === "rater" ? latestReview(control.workflowState.reviews, "rater") : undefined;
    const previousTurnIndex = previous ? turns.findIndex(turn => turn.id === previous.turnId) : -1;
    const repairEvidence = previous ? workerTurns.filter(({ turn }) => turns.indexOf(turn) > previousTurnIndex).map(({ turn, parsed }) => `Turn ${turn.id}: ${parsed.text ?? "(no text)"}`) : null;
    const prompt = composeAdvisorAssignment({
      role: request.role, objective: control.objective, configuration: context.configuration, visualEvidence: context.configuration.visualEvidence, images, repository: control.deliveryIntent.repository, headBranch: control.deliveryIntent.headBranch, baseBranch: observedSource.baseBranch,
      pullRequestNumber: control.deliveryIntent.pullRequestNumber, range, evidenceDirectory: evidence.directory, attachments, brief: request.brief ?? null,
      priorFindings: previous?.result?.blockingFindings ?? null, repairEvidence,
    });
    const advisor = this.store.launchWorker({ taskId: root.taskId, rootSessionId: root.sessionId, rootGeneration: root.generation, advisor: { role: request.role, prompt, input: { kind: "advisor", role: request.role, range, evidenceDirectory: evidence.directory, evidenceSha256: evidence.sha256, verificationTurnIds: workerTurns.map(({ turn }) => turn.id) } } });
    return { advisor, evidenceDirectory: evidence.directory, next: advisorSuccess };
  }

  async delegatePlanners(root: RootIdentity): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    const control = this.store.get(root.taskId);
    if (control.workflow !== "competing_plans") throw new Error("delegate_planners is legal only for Combined planning.");
    const sessions = this.store.sessions(root.taskId);
    const turns = this.store.turns(root.taskId);
    if (!control.worktree) throw new Error("The task has no worktree");
    this.recheck(root);
    const observedSource = await this.currentRange(root.taskId);
    if (!observedSource.clean) throw new DeliveryOperationFailure("worktree_dirty", "The worktree has uncommitted changes. Commit or discard them before requesting planners; planners inspect committed source only.");
    const { context, images, workerTurns, evidence, attachments } = await prepareAdvisorEvidence({ store: this.store, delivery: this.delivery, artifacts: this.artifacts, evidenceRoot: this.evidence?.root, control, range: observedSource.range, sessions, turns });
    const pairId = randomUUID();
    const planners = (["planner_a", "planner_b"] as const).map(role => ({ role, prompt: composeAdvisorAssignment({ role, objective: control.objective, configuration: context.configuration, visualEvidence: context.configuration.visualEvidence, images, repository: control.deliveryIntent.repository, headBranch: control.deliveryIntent.headBranch, baseBranch: observedSource.baseBranch, pullRequestNumber: control.deliveryIntent.pullRequestNumber, range: observedSource.range, evidenceDirectory: evidence.directory, attachments, brief: null, priorFindings: null, repairEvidence: null }), input: { kind: "advisor" as const, role, range: observedSource.range, evidenceDirectory: evidence.directory, evidenceSha256: evidence.sha256, verificationTurnIds: workerTurns.map(({ turn }) => turn.id), plannerPairId: pairId } }));
    const pair = this.store.launchPlannerPair({ taskId: root.taskId, rootSessionId: root.sessionId, rootGeneration: root.generation, pairId, planners: planners as [{ role: "planner_a"; prompt: string; input: Extract<WorkflowInput, { kind: "advisor" }> }, { role: "planner_b"; prompt: string; input: Extract<WorkflowInput, { kind: "advisor" }> }] });
    const launches = await Promise.allSettled(pair.map(session => recoverSession(this.recoveryDependencies(), session)));
    return { planners: pair, evidenceDirectory: evidence.directory, launches: launches.map(result => result.status), next: "End this Coordinator turn now. Forge will send one combined planning result after both Plan A and Plan B have terminal reports. Do not poll or wait inside this turn." };
  }

  /** The live range plus whether the worktree is clean; callers decide what an unclean tree means for them. */
  private async currentRange(taskId: string): Promise<{ range: ReviewRange; baseBranch: string; clean: boolean }> {
    const observed = await this.delivery.currentRange(taskId);
    return { range: { baseSha: observed.baseSha, headSha: observed.headSha, files: observed.files, commits: observed.commits, patchDigest: observed.patchDigest }, baseBranch: observed.baseBranch, clean: observed.clean };
  }

  /** Compares the live committed source with a pinned range; any observation failure is a concrete reason, never an approval. */
  private async sourceStillMatches(taskId: string, pinned: ReviewRange, activity: string): Promise<{ ok: true; range: ReviewRange } | { ok: false; reason: string; range: ReviewRange | null; clean: boolean | null }> {
    let observed: { range: ReviewRange; baseBranch: string; clean: boolean };
    try { observed = await this.currentRange(taskId); }
    catch (error) { return { ok: false, reason: `The source could not be observed after the ${activity}: ${error instanceof Error ? error.message : String(error)}`, range: null, clean: null }; }
    if (!observed.clean) return { ok: false, reason: `The worktree has uncommitted changes after the ${activity}; the pinned range ${pinned.baseSha.slice(0, 12)}..${pinned.headSha.slice(0, 12)} cannot be confirmed`, range: observed.range, clean: false };
    if (!sameRange(observed.range, pinned)) return { ok: false, reason: `The source range changed during the ${activity}: pinned base ${pinned.baseSha.slice(0, 12)} head ${pinned.headSha.slice(0, 12)} (${pinned.files.length} files), observed base ${observed.range.baseSha.slice(0, 12)} head ${observed.range.headSha.slice(0, 12)} (${observed.range.files.length} files)`, range: observed.range, clean: true };
    return { ok: true, range: observed.range };
  }

  async requestDelivery(root: RootIdentity, operation: DeliveryOperation, expectedHead?: string, review?: DeliveryReview, pullRequestTitle?: PullRequestTitle, pullRequestBody?: PullRequestBody): Promise<unknown> {
    const result = await this.delivery.execute(root, operation, expectedHead, review, pullRequestTitle, pullRequestBody, { recheck: () => this.recheck(root) });
    if (operation !== "inspect_delivery_diff" || this.store.get(root.taskId).workflow === "standard" || !this.evidence) return result;
    const control = this.store.get(root.taskId);
    const diff = result as ReviewRange;
    if (!control.worktree) return result;
    const evidence = await writeTaskEvidence({ root: this.evidence.root, taskId: root.taskId, worktree: control.worktree.path, range: { baseSha: diff.baseSha, headSha: diff.headSha, files: diff.files, commits: diff.commits, patchDigest: diff.patchDigest }, attachments: [], verification: { note: "Coordinator inspection; Worker evidence is attached to Advisor requests." } });
    return { ...(result as object), evidenceDirectory: evidence.directory };
  }

  async askHuman(root: RootIdentity, question: string, options: HumanQuestionOptions): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    this.store.askHuman(root.taskId, question, options);
    return this.store.get(root.taskId);
  }

  async wakeRoot(root: RootIdentity, prompt: string): Promise<void> {
    this.store.wakeRoot({ taskId: root.taskId, rootSessionId: root.sessionId, generation: root.generation, prompt });
    const session = this.store.currentSession(root.taskId, "root");
    if (session) await recoverSession(this.recoveryDependencies(), session);
  }

  async recordWorkerResult(input: { taskId: string; sessionId: string; generation: number; receiptId: string; observation: string; nativeTurnId?: string }): Promise<void> {
    this.store.recordWorkerResultAndWake(input);
    const root = this.store.currentSession(input.taskId, "root");
    if (root && this.store.get(input.taskId).status === "active") await recoverSession(this.recoveryDependencies(), root);
  }

  async recover(taskId: string): Promise<void> {
    this.store.retireDeliveredSessions(taskId);
    await stopRetiredSessions(this.recoveryDependencies(), taskId);
    if (this.store.get(taskId).status !== "active") return;
    const root = this.prepareRoot(taskId);
    await recoverSession(this.recoveryDependencies(), root);
    const recovered = await Promise.allSettled(this.store.currentDelegates(taskId).filter(worker => worker.lifecycle !== "stopped" && worker.lifecycle !== "cancelled").map(worker => recoverSession(this.recoveryDependencies(), worker)));
    const failures = recovered.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw failures[0];
    await stopRetiredSessions(this.recoveryDependencies(), taskId);
    const control = this.store.get(taskId);
    if (control.status === "active") {
      this.store.wakeIdleRoot(taskId);
      // A delivery wait keeps its own 30-second observation schedule.
      if (!control.workflowState.deliveryWait) this.store.scheduleWake(taskId, new Date(Date.now() + 15_000).toISOString());
    }
  }

  /** Revalidates one retained invalid Advisor turn without launching or resuming an agent. */
  async reconcileAdvisorReport(taskId: string, turnId: string): Promise<AdvisorReportOutcome> {
    return reconcileCompletedAdvisorReport(this.recoveryDependencies(), { taskId, turnId });
  }

  prepareRoot(taskId: string): TaskSession {
    const root = this.store.currentSession(taskId, "root") ?? this.store.claimRoot({ taskId });
    if (!this.store.hasTurns(root.id)) {
      const context = this.store.context(taskId);
      this.store.ensureInitialPrompt(root, initialCoordinatorPrompt(this.store.get(taskId), context, this.store.dependencySummaries(taskId)));
    }
    return root;
  }

  private recoveryDependencies(): SessionRecoveryDependencies {
    return {
      store: this.store,
      harness: this.harness,
      scope: (control, session, workflowInput = null) => this.scope(control, session, workflowInput),
      sourceStillMatches: (taskId, pinned, activity) => this.sourceStillMatches(taskId, pinned, activity),
      ...(this.reader ? { reader: this.reader } : {}),
      readPricing: this.readPricing,
    };
  }

  async cancel(taskId: string): Promise<void> {
    this.store.cancel(taskId);
    await this.recover(taskId);
  }

}

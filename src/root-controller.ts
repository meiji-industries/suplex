import { runCommand } from "./command-runner.js";
import type { HumanQuestionOptions } from "./human-question.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ArtifactStore } from "./artifacts.js";
import { DeliveryOperationFailure, DeliveryOperations } from "./delivery-operations.js";
import { StructuredLogger } from "./logging.js";
import { createOpenCodePromptIntent } from "./opencode-session.js";
import type { RootBridgeAdapter } from "./root-bridge.js";
import type { AdvisorRequest, DeliveryOperation, DeliveryReview, PullRequestTitle, RootIdentity, RootImageResult, WorkerAssignment } from "./root-contracts.js";
import type { TaskControlStore } from "./root-session-store.js";
import type { TaskControl, TaskSession, TaskTurn } from "./task-control.js";
import type { NativeSessionReader, PromptObservation, TaskHarness, TaskScope } from "./task-harness.js";
import { verifyTaskEvidence, writeTaskEvidence } from "./workflow-evidence.js";
import { advisorResultWake, composeAdvisorAssignment, composeWorkerAssignment, initialCoordinatorPrompt, workerResultWake } from "./workflow-prompts.js";
import { ADVISOR_LABELS, latestReview, parseAdvisorReport, publicWorkflowState, repairStalled, REPAIR_RATING_TARGET, sameRange, turnOutcome, workflowDefinition, type AdvisorRole, type ReportReference, type ReviewRange, type VerificationRange, type WorkflowInput, type WorkerWorkflowInput } from "./workflows.js";
import { pageWorkerEvidence } from "./worker-turn-evidence.js";

export type TaskDelivery = Pick<DeliveryOperations, "observe" | "execute" | "currentRange"> & Partial<Pick<DeliveryOperations, "checksObservation">>;

const advisorSuccess = "End this Coordinator turn now. Forge will send the Advisor's native report as a new turn on this same session. Do not poll or wait inside this turn.";

export class RootController implements RootBridgeAdapter {
  constructor(readonly store: TaskControlStore, private readonly harness: TaskHarness, private readonly delivery: TaskDelivery = new DeliveryOperations(store), private readonly artifacts?: ArtifactStore, private readonly evidence?: { root: string }, private readonly reader?: (session: TaskSession) => Pick<NativeSessionReader, "turnEvidence">) {}

  private scope(control: TaskControl, session: TaskSession, workflowInput: WorkflowInput | null = null): TaskScope {
    if (!control.worktree) throw new Error("Task worktree is not configured");
    const advisorRole = session.kind === "worker" ? session.advisorRole : null;
    const selected = session.kind === "root" ? control.rootProfile : advisorRole ? control.advisorProfiles[advisorRole] ?? control.rootProfile : control.workerProfile;
    const common = {
      id: session.id, taskId: control.taskId, directory: control.worktree.path, workflow: control.workflow, evidenceRoot: this.evidenceRoot(control.taskId),
      profile: { providerID: selected.provider, modelID: selected.model, reasoningEffort: selected.reasoningLevel, serviceTier: selected.serviceTier },
    };
    if (session.kind === "root") return { ...common, role: "root", identity: { taskId: control.taskId, sessionId: session.id, generation: session.generation } };
    if (advisorRole) return { ...common, role: "advisor", label: ADVISOR_LABELS[advisorRole] };
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
    const pullRequest = await this.delivery.observe(root.taskId);
    const worktree = control.worktree ? await observeWorktree(control.worktree.path) : null;
    const worker = this.store.currentSession(root.taskId, "worker");
    const workerTurn = worker ? this.store.turns(root.taskId).filter(turn => turn.sessionId === worker.id && turn.status === "completed").at(-1) : undefined;
    const workerResult = workerTurn ? summarizeWorkerObservation(workerTurn) : null;
    return { control: { ...this.store.get(root.taskId), workflowState: publicWorkflowState(this.store.get(root.taskId).workflowState) }, context: this.store.context(root.taskId), root: this.store.currentSession(root.taskId, "root"), worker, workerResult, worktree, pullRequest };
  }

  async readWorkerEvidence(root: RootIdentity, turnId: string, cursor?: string, maxCharacters = 12_000) {
    this.store.assertCurrentRoot(root);
    if (!this.reader) throw new Error("Native session evidence reading is not configured");
    const turn = this.store.turns(root.taskId).find(candidate => candidate.id === turnId);
    const session = turn ? this.store.sessions(root.taskId).find(candidate => candidate.id === turn.sessionId) : undefined;
    if (!turn || !session || session.kind !== "worker" || session.advisorRole !== null) throw new Error("Worker turn does not belong to this task");
    const evidence = await this.reader(session).turnEvidence(session, turn.id);
    return { turnId: turn.id, sessionId: session.id, localObservation: { status: turn.status, terminalObservationAvailable: turn.terminalObservation !== null, nativeTurnIdAvailable: turn.nativeTurnId !== null }, limitation: evidence.limitation, ...pageWorkerEvidence(evidence.tools, cursor, maxCharacters) };
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
      await this.recoverSession(worker);
      return { worker: this.store.currentSession(root.taskId, "worker"), next: "End this Coordinator turn now. Forge will send the Worker's native result as a new turn on this same session. Do not poll or wait inside this turn." };
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
      if (!requested) throw new Error("Pull request repair implementation requires advisorSessionId or advisorTurnId for the latest valid current-range Rater report below 9.");
      const latest = latestReview(control.workflowState.reviews, "rater");
      const matches = assignment.advisorTurnId ? latest?.turnId === requested : latest?.sessionId === requested;
      if (!latest || !matches || !latest.result) throw new Error("advisorTurnId must be the latest valid Rater report for this task.");
      if (!sameRange(latest.range, range)) throw new Error("The latest Rater report concerns a different source range. Request a new Rater assessment for the current range.");
      if (latest.result.role === "rater" && latest.result.rating >= REPAIR_RATING_TARGET) throw new Error("The current Rater rating is already at least 9. Continue with delivery instead of another repair.");
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
    await this.recoverSession(worker);
    return { worker: this.store.currentSession(root.taskId, "worker"), next: "End this Coordinator turn now. Forge will send the Worker's native result as a new turn on this same session. Do not poll or wait inside this turn." };
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
    // Two consecutive invalid reports since the last human answer become a question instead of another loop.
    const answerFromEnd = [...turns].reverse().findIndex(turn => turn.sessionId === root.sessionId && isHumanAnswer(turn.promptText));
    const lastAnswer = answerFromEnd === -1 ? -1 : turns.length - 1 - answerFromEnd;
    const attempts = turns.slice(lastAnswer + 1).filter(turn => turn.status === "completed" && sessions.find(session => session.id === turn.sessionId)?.advisorRole === request.role).slice(-2);
    if (attempts.length === 2 && attempts.every(turn => turnOutcome(turn.terminalObservation).advisor?.result === null)) {
      const reasons = attempts.map(turn => turnOutcome(turn.terminalObservation).advisor?.invalidReason ?? "unknown");
      const environmental = reasons.every(reason => /source|base|observed|uncommitted|evidence files/i.test(reason));
      this.store.askHuman(root.taskId, environmental
        ? `The source, base, or evidence could not be confirmed for the last two ${label} reviews (${reasons.join("; ")}). Resolve the source state, for example by committing or discarding changes or restoring the base branch, then continue.`
        : `${label} returned two consecutive invalid reports (${reasons.join("; ")}). The selected ${label} profile did not produce the necessary JSON report. How should Forge continue?`, [
        { label: "Retry", description: `Request ${label} once more with the same captured profile.`, recommended: true },
        { label: "Revise scope", description: "Describe a change to the objective or evidence before another attempt.", recommended: false },
      ]);
      return { asked: true, control: this.store.get(root.taskId) };
    }
    if (!control.worktree) throw new Error("The task has no worktree");
    this.recheck(root);
    const observedSource = await this.currentRange(root.taskId);
    if (!observedSource.clean) throw new DeliveryOperationFailure("worktree_dirty", "The worktree has uncommitted changes. Commit or discard them before requesting an Advisor; Advisors review committed source only.");
    const range = observedSource.range;
    const context = this.store.context(root.taskId);
    const images = context.images as Array<{ artifactId: string; filename: string }>;
    const workerTurns = sessions.filter(session => session.kind === "worker" && session.advisorRole === null).flatMap(session => turns.filter(turn => turn.sessionId === session.id && turn.status === "completed").map(turn => ({ session, turn, input: turnWorkflowInput(session, turn) })));
    const verification = {
      configuration: { verificationCommand: context.configuration.verificationCommand, runProjectTests: context.configuration.runProjectTests, visualEvidence: context.configuration.visualEvidence },
      pullRequest: control.pullRequest,
      pullRequestChecks: this.delivery.checksObservation ? await this.delivery.checksObservation(root.taskId) : null,
      workerTurns: workerTurns.map(({ session, turn, input }) => {
        const parsed = parseObservation(turn.terminalObservation);
        return { turnId: turn.id, sessionId: session.id, mode: input?.kind === "worker" ? input.mode : "planned", purpose: input?.kind === "worker" ? input.purpose : "implementation", range: input?.kind === "worker" ? input.range : null, state: parsed.state, text: parsed.text, tools: parsed.tools, limit: parsed.toolsLimit ?? (parsed.tools === null ? "Native tool evidence was not captured for this turn" : null), verificationRange: parsed.verificationRange, sourceRangeProof: parsed.verificationRange ? (parsed.verificationRange.valid ? "valid" : "invalid") : "none" };
      }),
    };
    if (!this.evidence) throw new Error("Task evidence storage is not configured");
    const evidence = await writeTaskEvidence({
      root: this.evidence.root, taskId: root.taskId, worktree: control.worktree.path, range, verification,
      attachments: images.map(image => ({ artifactId: image.artifactId, mimeType: this.store.image(root.taskId, image.artifactId).mimeType, read: async () => {
        if (!this.artifacts) throw new Error("Task image storage is not configured");
        const artifact = this.store.image(root.taskId, image.artifactId);
        const bytes = await this.artifacts.getArtifact(artifact);
        if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("The task image changed in storage");
        return bytes;
      } })),
    });
    const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(evidence.directory, "manifest.json"), "utf8")) as { attachments: Array<{ artifactId: string; path: string | null; error: string | null }> };
    const previous = request.role === "rater" ? latestReview(control.workflowState.reviews, "rater") : undefined;
    const previousTurnIndex = previous ? turns.findIndex(turn => turn.id === previous.turnId) : -1;
    const repairEvidence = previous ? workerTurns.filter(({ turn }) => turns.indexOf(turn) > previousTurnIndex).map(({ turn }) => `Turn ${turn.id}: ${parseObservation(turn.terminalObservation).text ?? "(no text)"}`) : null;
    const prompt = composeAdvisorAssignment({
      role: request.role, objective: control.objective, configuration: context.configuration, visualEvidence: context.configuration.visualEvidence, images, repository: control.deliveryIntent.repository, headBranch: control.deliveryIntent.headBranch, baseBranch: control.deliveryIntent.baseBranch,
      pullRequestNumber: control.deliveryIntent.pullRequestNumber, range, evidenceDirectory: evidence.directory, attachments: manifest.attachments, brief: request.brief ?? null,
      priorFindings: previous?.result?.blockingFindings ?? null, repairEvidence,
    });
    const advisor = this.store.launchWorker({ taskId: root.taskId, rootSessionId: root.sessionId, rootGeneration: root.generation, advisor: { role: request.role, prompt, input: { kind: "advisor", role: request.role, range, evidenceDirectory: evidence.directory, evidenceSha256: evidence.sha256, verificationTurnIds: workerTurns.map(({ turn }) => turn.id) } } });
    await this.recoverSession(advisor);
    return { advisor: this.store.currentSession(root.taskId, "worker"), evidenceDirectory: evidence.directory, next: advisorSuccess };
  }

  /** The live range plus whether the worktree is clean; callers decide what an unclean tree means for them. */
  private async currentRange(taskId: string): Promise<{ range: ReviewRange; clean: boolean }> {
    const observed = await this.delivery.currentRange(taskId);
    return { range: { baseSha: observed.baseSha, headSha: observed.headSha, files: observed.files, commits: observed.commits, patchDigest: observed.patchDigest }, clean: observed.clean };
  }

  /** Compares the live committed source with a pinned range; any observation failure is a concrete reason, never an approval. */
  private async sourceStillMatches(taskId: string, pinned: ReviewRange, activity: string): Promise<{ ok: true; range: ReviewRange } | { ok: false; reason: string; range: ReviewRange | null; clean: boolean | null }> {
    let observed: { range: ReviewRange; clean: boolean };
    try { observed = await this.currentRange(taskId); }
    catch (error) { return { ok: false, reason: `The source could not be observed after the ${activity}: ${error instanceof Error ? error.message : String(error)}`, range: null, clean: null }; }
    if (!observed.clean) return { ok: false, reason: `The worktree has uncommitted changes after the ${activity}; the pinned range ${pinned.baseSha.slice(0, 12)}..${pinned.headSha.slice(0, 12)} cannot be confirmed`, range: observed.range, clean: false };
    if (!sameRange(observed.range, pinned)) return { ok: false, reason: `The source range changed during the ${activity}: pinned base ${pinned.baseSha.slice(0, 12)} head ${pinned.headSha.slice(0, 12)} (${pinned.files.length} files), observed base ${observed.range.baseSha.slice(0, 12)} head ${observed.range.headSha.slice(0, 12)} (${observed.range.files.length} files)`, range: observed.range, clean: true };
    return { ok: true, range: observed.range };
  }

  async requestDelivery(root: RootIdentity, operation: DeliveryOperation, expectedHead?: string, review?: DeliveryReview, pullRequestTitle?: PullRequestTitle): Promise<unknown> {
    const result = await this.delivery.execute(root, operation, expectedHead, review, pullRequestTitle, { recheck: () => this.recheck(root) });
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
    if (session) await this.recoverSession(session);
  }

  async recordWorkerResult(input: { taskId: string; sessionId: string; generation: number; receiptId: string; observation: string; nativeTurnId?: string }): Promise<void> {
    this.store.recordWorkerResultAndWake(input);
    const root = this.store.currentSession(input.taskId, "root");
    if (root && this.store.get(input.taskId).status === "active") await this.recoverSession(root);
  }

  async recover(taskId: string): Promise<void> {
    this.store.retireDeliveredSessions(taskId);
    await this.stopRetiredSessions(taskId);
    if (this.store.get(taskId).status !== "active") return;
    const root = this.prepareRoot(taskId);
    await this.recoverSession(root);
    const worker = this.store.currentSession(taskId, "worker");
    if (worker && worker.lifecycle !== "stopped" && worker.lifecycle !== "cancelled") await this.recoverSession(worker);
    await this.stopRetiredSessions(taskId);
    const control = this.store.get(taskId);
    if (control.status === "active") {
      this.store.wakeIdleRoot(taskId);
      // A delivery wait keeps its own 30-second observation schedule.
      if (!control.workflowState.deliveryWait) this.store.scheduleWake(taskId, new Date(Date.now() + 15_000).toISOString());
    }
  }

  prepareRoot(taskId: string): TaskSession {
    const root = this.store.currentSession(taskId, "root") ?? this.store.claimRoot({ taskId });
    if (!this.store.hasTurns(root.id)) {
      const context = this.store.context(taskId);
      this.store.ensureInitialPrompt(root, initialCoordinatorPrompt(this.store.get(taskId), context));
    }
    return root;
  }

  private async stopRetiredSessions(taskId: string): Promise<void> {
    const failures: unknown[] = [];
    for (const session of await this.store.pendingStops(taskId)) {
      try {
        await this.harness.stop({ id: session.id }, session.nativeSessionId);
        this.store.completeStop(session.id);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const error = new AggregateError(failures, "Some agent sessions could not be stopped");
      if (["cancelled", "delivered"].includes(this.store.get(taskId).status)) throw error;
      new StructuredLogger().warn("Completed session cleanup will be retried", { taskId }, { error: error.message });
    }
  }

  async cancel(taskId: string): Promise<void> {
    this.store.cancel(taskId);
    await this.recover(taskId);
  }

  private async recoverSession(previous: TaskSession): Promise<void> {
    if (this.store.get(previous.taskId).status !== "active") return;
    const owner = await this.store.claimSessionOperation({ sessionId: previous.id, generation: previous.generation });
    if (!owner) return;
    try {
      const control = this.store.get(previous.taskId);
      const current = this.store.currentSession(previous.taskId, previous.kind);
      if (!current || current.id !== previous.id || current.generation !== previous.generation) return;
      const currentTurn = this.store.pendingTurns(current.id)[0];
      const taskScope = this.scope(control, current, currentTurn ? turnWorkflowInput(current, currentTurn) : null);
      const nativeSessionId = await this.harness.ensureSession(taskScope, current.nativeSessionId);
      const session = this.store.bindHarnessSession({ sessionId: previous.id, generation: previous.generation, nativeSessionId });
      try {
        await this.harness.attach({ scope: taskScope, nativeSessionId, paneId: session.paneId, rootPaneId: session.kind === "worker" ? this.store.currentSession(control.taskId, "root")?.paneId ?? null : null, persistPane: (paneId) => this.store.bindPane({ sessionId: session.id, generation: session.generation, paneId }) });
      } catch (error) {
        new StructuredLogger().warn("Task display attachment is unavailable; native work is retained", { taskId: control.taskId }, { error: error instanceof Error ? error.message : String(error) });
      }
      for (const turn of this.store.pendingTurns(session.id)) {
        if (this.store.get(control.taskId).status !== "active") break;
        const intent = createOpenCodePromptIntent({ sessionID: nativeSessionId, messageID: turn.id, directory: taskScope.directory, prompt: turn.promptText, model: { providerID: taskScope.profile.providerID, modelID: taskScope.profile.modelID }, agent: `forge-${taskScope.role}`, variant: taskScope.profile.reasoningEffort, dispatch: turn.status === "pending_prompt" ? "not_submitted" : "ambiguous" });
        let observed = await this.harness.observe(taskScope, intent, turn.dispatchAttempt);
        let replayable = turn.status === "pending_prompt";
        if (turn.status === "unknown" && turn.dispatchAttempt && observed.admission === "not_observed" && Date.now() - Date.parse(turn.dispatchAttempt.claimedAt) >= 30_000) {
          observed = await this.harness.recoverDispatch(taskScope, intent, turn.dispatchAttempt);
          if (observed.retry === "allowed") replayable = this.store.requeueFencedPrompt({ turnId: turn.id, attempt: turn.dispatchAttempt, owner });
        }
        if (observed.retry === "allowed" && replayable) {
          observed = await this.harness.dispatch(taskScope, { ...intent, dispatch: "not_submitted" }, async serverGeneration => this.store.claimPrompt(turn.id, serverGeneration, owner));
        }
        if (this.store.get(control.taskId).status === "cancelled") break;
        if (observed.admission === "observed" && turn.status !== "prompted") this.store.markPrompted({ turnId: turn.id, generation: session.generation });
        if (observed.executionUncertain) { this.store.requireExecutionCleanup(turn); break; }
        if (!["completed", "error", "interrupted", "terminal_incomplete"].includes(observed.state)) break;
        await this.finishTurn(taskScope, session, turn, observed);
      }
    } finally {
      this.store.releaseSessionOperation(previous.id, owner);
    }
  }

  private async finishTurn(taskScope: TaskScope, session: TaskSession, turn: TaskTurn, observed: PromptObservation): Promise<void> {
    const text = await this.harness.resultText(taskScope, observed);
    const base = { state: observed.state, native: observed.native, reason: observed.reason, interruptedExecution: observed.interruptedExecution, text };
    if (session.kind === "root") {
      this.store.completeRootTurn(turn.id, JSON.stringify(base), observed.interruptedExecution ? "The previous execution stopped when its agent process exited. Its admitted message will not be replayed. Observe current task, worktree and GitHub state, preserve any partial work, and continue from that evidence." : undefined);
      if (observed.state !== "completed" && !observed.interruptedExecution && this.store.get(session.taskId).status === "active") {
        this.store.askHuman(session.taskId, `The agent stopped the Coordinator turn (${observed.state}). ${observed.reason ?? text} Can you resolve the failure and continue?`);
      }
      return;
    }
    const receiptId = `${observed.sessionID}:${observed.messageID}:${observed.state}`;
    const nativeTurnId = observed.assistantMessageID ? { nativeTurnId: observed.assistantMessageID } : {};
    const workflowInput = turnWorkflowInput(session, turn);
    if (taskScope.role === "advisor" && session.advisorRole && workflowInput?.kind === "advisor") {
      const role = session.advisorRole;
      const input = workflowInput;
      let outcome = observed.state === "completed" ? parseAdvisorReport(role, text) : { result: null, invalidReason: `The ${ADVISOR_LABELS[role]} turn ended with state ${observed.state}${observed.reason ? ` (${observed.reason})` : ""}` };
      if (outcome.result && !(await verifyTaskEvidence(input.evidenceDirectory, input.evidenceSha256))) outcome = { result: null, invalidReason: "The evidence files changed or are missing since the assignment. Request a new assessment." };
      if (outcome.result) {
        const source = await this.sourceStillMatches(session.taskId, input.range, `${ADVISOR_LABELS[role]} review`);
        if (!source.ok) outcome = { result: null, invalidReason: `${source.reason}. Request a new assessment.` };
      }
      const observation = JSON.stringify({ ...base, advisor: { role, result: outcome.result, invalidReason: outcome.invalidReason } });
      const summary = outcome.result ? outcome.result.role === "rater" ? `Rating ${outcome.result.rating}/10 with ${outcome.result.blockingFindings.length} blocking finding(s); verification ${outcome.result.verification}.` : outcome.result.role === "reviewer" ? `${outcome.result.approved ? "Approved" : "Not approved"} with ${outcome.result.blockingFindings.length} blocking finding(s); verification ${outcome.result.verification}.` : outcome.result.summary : outcome.invalidReason ?? "invalid";
      const review = role === "reviewer" || role === "rater" ? { review: { result: outcome.result as Extract<typeof outcome.result, { role: "reviewer" | "rater" }> | null, invalidReason: outcome.invalidReason } } : {};
      const recorded = this.store.recordWorkerResultAndWake({ taskId: session.taskId, sessionId: session.id, generation: session.generation, receiptId, observation, ...nativeTurnId, ...review, wakePrompt: advisorResultWake(role, receiptId, { valid: outcome.result !== null, summary }, observation) });
      if (recorded.kind === "recorded" && role === "rater" && outcome.result) this.checkStall(session.taskId);
      return;
    }
    const purpose = workflowInput?.kind === "worker" ? workflowInput.purpose : "implementation";
    let verificationRange: VerificationRange | undefined;
    if (purpose === "verification" && workflowInput?.kind === "worker") {
      // Check-only evidence proves which committed source was checked: identical clean endpoints before and after.
      const source = await this.sourceStillMatches(session.taskId, workflowInput.range, "check");
      verificationRange = source.ok ? { before: workflowInput.range, after: source.range, cleanAfter: true, valid: true, invalidReason: null } : { before: workflowInput.range, after: source.range, cleanAfter: source.clean, valid: false, invalidReason: source.reason };
    }
    if (taskScope.workflow === "standard") {
      const observation = JSON.stringify({ ...base, ...(verificationRange ? { verificationRange } : {}) });
      this.store.recordWorkerResultAndWake({ taskId: session.taskId, sessionId: session.id, generation: session.generation, receiptId, observation, ...nativeTurnId, wakePrompt: workerResultWake(taskScope.workflow, receiptId, { turnId: turn.id, state: observed.state, text, verificationRange }, purpose) });
      return;
    }
    const evidence = await this.harness.turnEvidence(taskScope, observed);
    const observation = JSON.stringify({ ...base, tools: evidence.tools, toolsLimit: evidence.limit, ...(verificationRange ? { verificationRange } : {}) });
    this.store.recordWorkerResultAndWake({ taskId: session.taskId, sessionId: session.id, generation: session.generation, receiptId, observation, ...nativeTurnId, wakePrompt: workerResultWake(taskScope.workflow, receiptId, { turnId: turn.id, state: observed.state, text, verificationRange }, purpose) });
  }

  private checkStall(taskId: string): void {
    const control = this.store.get(taskId);
    const stall = repairStalled(control.workflowState.reviews, this.store.sessions(taskId), this.store.turns(taskId));
    if (!stall.stalled || control.status !== "active") return;
    this.store.askHuman(taskId, `Three consecutive repair cycles left the same blocking findings at ${stall.rating}/10: ${stall.findings.join("; ") || "no findings listed"}. Rater and Worker have not resolved this defect. How should Forge continue?`, [
      { label: "Continue", description: "Run another bounded repair attempt with the same 9/10 target.", recommended: true },
      { label: "Revise scope", description: "Describe the decision necessary to resolve the defect. The 9/10 target stays.", recommended: false },
    ]);
  }
}

function turnWorkflowInput(session: TaskSession, turn: TaskTurn): WorkflowInput | null {
  return turn.workflowInput ?? session.workflowInput;
}

function findAdvisorReport(sessions: TaskSession[], turns: TaskTurn[], reference: { turnId: string } | { sessionId: string }): { session: TaskSession; turn: TaskTurn; input: Extract<WorkflowInput, { kind: "advisor" }> } | null {
  const candidates = "turnId" in reference ? turns.filter(turn => turn.id === reference.turnId) : turns.filter(turn => turn.sessionId === reference.sessionId).reverse();
  for (const turn of candidates) {
    const session = sessions.find(candidate => candidate.id === turn.sessionId);
    if (!session?.advisorRole || turn.status !== "completed") continue;
    const input = turnWorkflowInput(session, turn);
    const outcome = turnOutcome(turn.terminalObservation).advisor;
    if (input?.kind === "advisor" && outcome?.result && outcome.role === session.advisorRole) return { session, turn, input };
  }
  return null;
}

function resolveAdvisorReport(sessions: TaskSession[], turns: TaskTurn[], role: AdvisorRole, reference: { turnId: string } | { sessionId: string }): { session: TaskSession; turn: TaskTurn; input: Extract<WorkflowInput, { kind: "advisor" }> } | null {
  const report = findAdvisorReport(sessions, turns, reference);
  return report?.session.advisorRole === role && report.input.role === role ? report : null;
}

function isHumanAnswer(prompt: string): boolean {
  try { const parsed = JSON.parse(prompt) as { question?: unknown; answer?: unknown }; return typeof parsed.question === "string" && typeof parsed.answer === "string"; }
  catch { return false; }
}

function parseObservation(observation: string | null): { state: string | null; text: string | null; tools: unknown[] | null; toolsLimit: string | null; verificationRange: VerificationRange | null } {
  const outcome = turnOutcome(observation);
  try {
    const parsed = observation ? JSON.parse(observation) as { tools?: unknown[]; toolsLimit?: string | null; verificationRange?: VerificationRange } : {};
    return { state: outcome.state, text: outcome.text, tools: Array.isArray(parsed.tools) ? parsed.tools : null, toolsLimit: parsed.toolsLimit ?? null, verificationRange: parsed.verificationRange ?? null };
  } catch { return { state: outcome.state, text: outcome.text, tools: null, toolsLimit: null, verificationRange: null }; }
}

function summarizeWorkerObservation(turn: TaskTurn): unknown {
  const parsed = parseObservation(turn.terminalObservation);
  return { turnId: turn.id, state: parsed.state, text: parsed.text, evidence: { operation: "read_worker_evidence", toolsStored: parsed.tools !== null, limitation: parsed.toolsLimit }, verificationRange: parsed.verificationRange };
}

async function observeWorktree(path: string): Promise<unknown> {
  try {
    const [head, dirty] = await Promise.all([
      runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", path, "rev-parse", "HEAD"] }),
      runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", path, "status", "--porcelain"] }),
    ]);
    return { headSha: head.stdout.trim(), dirty: dirty.stdout.trim().length > 0 };
  } catch (error) { return { state: "unknown", error: error instanceof Error ? error.message : "Git observation failed" }; }
}

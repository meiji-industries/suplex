import { StructuredLogger } from "../platform/logging.js";
import type { ModelPricingCatalog } from "../profiles/model-pricing.js";
import { createOpenCodePromptIntent } from "../runtimes/opencode/session.js";
import type { NativeSessionReader, PromptObservation, TaskHarness, TaskScope } from "../runtimes/task-harness.js";
import type { TaskSession, TaskTurn } from "../tasks/control.js";
import { observeTaskLimitUsage } from "../tasks/limits/limit-observer.js";
import type { TaskControlStore } from "./root-session-store.js";
import { advisorResultWake, workerResultWake } from "./workflow-prompts.js";
import { verifyTaskEvidence } from "./workflow-evidence.js";
import { ADVISOR_LABELS, parseAdvisorReport, type ReviewRange, type VerificationRange } from "./workflows.js";
import { turnWorkflowInput } from "./controller-reports.js";

type SourceMatch = { ok: true; range: ReviewRange } | { ok: false; reason: string; range: ReviewRange | null; clean: boolean | null };

export type SessionRecoveryDependencies = {
  store: TaskControlStore;
  harness: TaskHarness;
  scope: (control: ReturnType<TaskControlStore["get"]>, session: TaskSession, workflowInput?: ReturnType<typeof turnWorkflowInput>) => TaskScope;
  sourceStillMatches: (taskId: string, pinned: ReviewRange, activity: string) => Promise<SourceMatch>;
  reader?: (session: TaskSession) => Pick<NativeSessionReader, "turnEvidence"> & Partial<Pick<NativeSessionReader, "timeline">>;
  readPricing: () => Promise<ModelPricingCatalog | undefined>;
};

export async function stopRetiredSessions(dependencies: Pick<SessionRecoveryDependencies, "store" | "harness">, taskId: string): Promise<void> {
  const failures: unknown[] = [];
  for (const session of await dependencies.store.pendingStops(taskId)) {
    try {
      await dependencies.harness.stop({ id: session.id }, session.nativeSessionId);
      dependencies.store.completeStop(session.id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const error = new AggregateError(failures, "Some agent sessions could not be stopped");
    if (["cancelled", "delivered"].includes(dependencies.store.get(taskId).status)) throw error;
    new StructuredLogger().warn("Completed session cleanup will be retried", { taskId }, { error: error.message });
  }
}

export async function recoverSession(dependencies: SessionRecoveryDependencies, previous: TaskSession): Promise<void> {
  const { store, harness } = dependencies;
  if (store.get(previous.taskId).status !== "active") return;
  const owner = await store.claimSessionOperation({ sessionId: previous.id, generation: previous.generation });
  if (!owner) return;
  try {
    const control = store.get(previous.taskId);
    const current = store.currentSessionByIdentity(previous.id, previous.generation);
    if (!current || current.lifecycle === "stopped" || current.lifecycle === "cancelled") return;
    const currentTurn = store.pendingTurns(current.id)[0];
    const taskScope = dependencies.scope(control, current, currentTurn ? turnWorkflowInput(current, currentTurn) : null);
    const nativeSessionId = await harness.ensureSession(taskScope, current.nativeSessionId);
    const session = store.bindHarnessSession({ sessionId: previous.id, generation: previous.generation, nativeSessionId });
    try {
      await harness.attach({
        scope: taskScope,
        nativeSessionId,
        paneId: session.paneId,
        rootPaneId: session.kind === "worker" ? store.currentSession(control.taskId, "root")?.paneId ?? null : null,
        persistPane: (paneId) => store.bindPane({ sessionId: session.id, generation: session.generation, paneId }),
      });
    } catch (error) {
      new StructuredLogger().warn("Task display attachment is unavailable; native work is retained", { taskId: control.taskId }, { error: error instanceof Error ? error.message : String(error) });
    }
    for (const turn of store.pendingTurns(session.id)) {
      if (store.get(control.taskId).status !== "active") break;
      const intent = createOpenCodePromptIntent({
        sessionID: nativeSessionId,
        messageID: turn.id,
        directory: taskScope.directory,
        prompt: turn.promptText,
        model: { providerID: taskScope.profile.providerID, modelID: taskScope.profile.modelID },
        agent: `forge-${taskScope.role}`,
        variant: taskScope.profile.reasoningEffort,
        dispatch: turn.status === "pending_prompt" ? "not_submitted" : "ambiguous",
      });
      let observed = await harness.observe(taskScope, intent, turn.dispatchAttempt);
      let replayable = turn.status === "pending_prompt";
      if (turn.status === "unknown" && turn.dispatchAttempt && observed.admission === "not_observed" && Date.now() - Date.parse(turn.dispatchAttempt.claimedAt) >= 30_000) {
        observed = await harness.recoverDispatch(taskScope, intent, turn.dispatchAttempt);
        if (observed.retry === "allowed") replayable = store.requeueFencedPrompt({ turnId: turn.id, attempt: turn.dispatchAttempt, owner });
      }
      if (observed.retry === "allowed" && replayable) {
        const usage = await observeTaskLimitUsage({ taskId: control.taskId, store, ...(dependencies.reader ? { reader: dependencies.reader } : {}), readPricing: dependencies.readPricing });
        if (store.pauseAtTaskLimit(control.taskId, usage)) break;
        observed = await harness.dispatch(taskScope, { ...intent, dispatch: "not_submitted" }, async serverGeneration => store.claimPrompt({ taskId: control.taskId, turnId: turn.id, serverGeneration, owner, usage }));
      }
      if (store.get(control.taskId).status === "cancelled") break;
      if (observed.admission === "observed" && turn.status !== "prompted") store.markPrompted({ turnId: turn.id, generation: session.generation });
      if (observed.executionUncertain) {
        store.requireExecutionCleanup(turn);
        break;
      }
      if (!["completed", "error", "interrupted", "terminal_incomplete"].includes(observed.state)) break;
      await finishTurn(dependencies, taskScope, session, turn, observed);
    }
  } finally {
    store.releaseSessionOperation(previous.id, owner);
  }
}

async function finishTurn(dependencies: SessionRecoveryDependencies, taskScope: TaskScope, session: TaskSession, turn: TaskTurn, observed: PromptObservation): Promise<void> {
  const { harness, store } = dependencies;
  const text = await harness.resultText(taskScope, observed);
  const base = { state: observed.state, native: observed.native, reason: observed.reason, interruptedExecution: observed.interruptedExecution, text };
  if (session.kind === "root") {
    store.completeRootTurn(turn.id, JSON.stringify(base), observed.interruptedExecution ? "The previous execution stopped when its agent process exited. Its admitted message will not be replayed. Observe current task, worktree and GitHub state, preserve any partial work, and continue from that evidence." : undefined);
    if (observed.state !== "completed" && !observed.interruptedExecution && store.get(session.taskId).status === "active") {
      store.askHuman(session.taskId, `The agent stopped the Coordinator turn (${observed.state}). ${observed.reason ?? text} Can you resolve the failure and continue?`);
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
      const source = await dependencies.sourceStillMatches(session.taskId, input.range, `${ADVISOR_LABELS[role]} review`);
      if (!source.ok) outcome = { result: null, invalidReason: `${source.reason}. Request a new assessment.` };
    }
    const observation = JSON.stringify({ ...base, advisor: { role, result: outcome.result, invalidReason: outcome.invalidReason } });
    const summary = outcome.result ? outcome.result.role === "rater" ? `Rating ${outcome.result.rating}/10 with ${outcome.result.blockingFindings.length} blocking finding(s); verification ${outcome.result.verification}.` : outcome.result.role === "reviewer" ? `${outcome.result.approved ? "Approved" : "Not approved"} with ${outcome.result.blockingFindings.length} blocking finding(s); verification ${outcome.result.verification}.` : outcome.result.summary : outcome.invalidReason ?? "invalid";
    const reviewResult = outcome.result?.role === "reviewer" || outcome.result?.role === "rater" ? outcome.result : null;
    const review = role === "reviewer" || role === "rater" ? { review: { result: reviewResult, invalidReason: outcome.invalidReason } } : {};
    store.recordWorkerResultAndWake({ taskId: session.taskId, sessionId: session.id, generation: session.generation, receiptId, observation, ...nativeTurnId, ...review, wakePrompt: advisorResultWake(role, receiptId, { valid: outcome.result !== null, summary }, observation) });
    return;
  }
  const purpose = workflowInput?.kind === "worker" ? workflowInput.purpose : "implementation";
  let verificationRange: VerificationRange | undefined;
  if (purpose === "verification" && workflowInput?.kind === "worker") {
    const source = await dependencies.sourceStillMatches(session.taskId, workflowInput.range, "check");
    verificationRange = source.ok ? { before: workflowInput.range, after: source.range, cleanAfter: true, valid: true, invalidReason: null } : { before: workflowInput.range, after: source.range, cleanAfter: source.clean, valid: false, invalidReason: source.reason };
  }
  if (taskScope.workflow === "standard") {
    const observation = JSON.stringify({ ...base, ...(verificationRange ? { verificationRange } : {}) });
    store.recordWorkerResultAndWake({ taskId: session.taskId, sessionId: session.id, generation: session.generation, receiptId, observation, ...nativeTurnId, wakePrompt: workerResultWake(taskScope.workflow, receiptId, { turnId: turn.id, state: observed.state, text, verificationRange }, purpose) });
    return;
  }
  const evidence = await harness.turnEvidence(taskScope, observed);
  const observation = JSON.stringify({ ...base, tools: evidence.tools, toolsLimit: evidence.limit, ...(verificationRange ? { verificationRange } : {}) });
  store.recordWorkerResultAndWake({ taskId: session.taskId, sessionId: session.id, generation: session.generation, receiptId, observation, ...nativeTurnId, wakePrompt: workerResultWake(taskScope.workflow, receiptId, { turnId: turn.id, state: observed.state, text, verificationRange }, purpose) });
}

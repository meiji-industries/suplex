import { runCommand } from "./command-runner.js";
import type { HumanQuestionOptions } from "./human-question.js";
import { createHash } from "node:crypto";
import type { ArtifactStore } from "./artifacts.js";
import { DeliveryOperations } from "./delivery-operations.js";
import { StructuredLogger } from "./logging.js";
import { createOpenCodePromptIntent, type OpenCodePromptObservation } from "./opencode-session.js";
import type { OpenCodeTaskRuntime, OpenCodeTaskScope } from "./opencode-task-runtime.js";
import type { RootBridgeAdapter } from "./root-bridge.js";
import type { DeliveryOperation, DeliveryReview, RootIdentity, RootImageResult } from "./root-contracts.js";
import type { TaskControlStore } from "./root-session-store.js";
import type { TaskControl, TaskSession, TaskTurn } from "./task-control.js";

export type TaskHarness = Pick<OpenCodeTaskRuntime, "ensureSession" | "attach" | "observe" | "dispatch" | "recoverDispatch" | "resultText" | "stop">;

function scope(control: TaskControl, session: TaskSession): OpenCodeTaskScope {
  if (!control.worktree) throw new Error("Task worktree is not configured");
  const selected = session.kind === "root" ? control.rootProfile : control.workerProfile;
  const common = {
    id: session.id, taskId: control.taskId, directory: control.worktree.path,
    profile: { providerID: selected.provider, modelID: selected.model, reasoningEffort: selected.reasoningLevel, serviceTier: selected.serviceTier },
  };
  return session.kind === "root"
    ? { ...common, role: "root", identity: { taskId: control.taskId, sessionId: session.id, generation: session.generation } }
    : { ...common, role: "worker" };
}

function initialPrompt(control: TaskControl): string {
  return `You are the continuing read-only Root for this Forge task. You own repository investigation, planning, and independent review of the Worker's output. Read the relevant source yourself and state your implementation plan and acceptance criteria before delegating. Do not delegate planning, design decisions, or the final verification judgment to the Worker. Read-only limits mutations, not your responsibility to reason about the code.

Use forge_root to observe the task, delegate one scoped Worker at a time, and request Forge-owned delivery operations. Each Worker assignment must implement your plan with concrete scope, constraints, and checks. The Worker edits and runs checks directly, without subagents, pushes, or GitHub mutations. After the Worker returns, read the changed source yourself, compare it with your plan and acceptance criteria, and assess the actual check results. A Worker's claim of success is not verification. If additional commands or repairs are needed, specify them in a bounded Worker assignment, then independently review the new evidence. You decide whether the work is ready for delivery.

Do not write files or launch agents yourself. Preserve out-of-band work and adopt matching GitHub state. Ask one specific human question only when an external ambiguity or necessary decision prevents progress. Continue until the delivery target is observed, a Worker is running, or you have asked that question.\n\nObjective: ${control.objective}\nDelivery target: ${control.deliveryTarget}\nRepository: ${control.deliveryIntent.repository}\nBranch: ${control.deliveryIntent.headBranch}`;
}

export class RootController implements RootBridgeAdapter {
  constructor(readonly store: TaskControlStore, private readonly harness: TaskHarness, private readonly delivery = new DeliveryOperations(store), private readonly artifacts?: ArtifactStore) {}

  async assertCurrentRoot(root: RootIdentity): Promise<void> { this.store.assertCurrentRoot(root); }

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
    const workerResult = worker ? this.store.turns(root.taskId).find(turn => turn.sessionId === worker.id && turn.status === "completed")?.terminalObservation ?? null : null;
    return { control: this.store.get(root.taskId), context: this.store.context(root.taskId), root: this.store.currentSession(root.taskId, "root"), worker, workerResult, worktree, pullRequest };
  }

  async delegateWorker(root: RootIdentity, instruction: string): Promise<unknown> {
    const worker = this.store.launchWorker({ taskId: root.taskId, rootSessionId: root.sessionId, rootGeneration: root.generation, instruction });
    await this.recoverSession(worker);
    return { worker: this.store.currentSession(root.taskId, "worker"), next: "End this Root turn now. Forge will send the Worker's native result as a new turn on this same session. Do not poll or wait inside this turn." };
  }

  async requestDelivery(root: RootIdentity, operation: DeliveryOperation, expectedHead?: string, review?: DeliveryReview): Promise<unknown> {
    return this.delivery.execute(root, operation, expectedHead, review);
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
    if (this.store.get(taskId).status === "active") {
      this.store.wakeIdleRoot(taskId);
      this.store.scheduleWake(taskId, new Date(Date.now() + 15_000).toISOString());
    }
  }

  prepareRoot(taskId: string): TaskSession {
    const root = this.store.currentSession(taskId, "root") ?? this.store.claimRoot({ taskId });
    if (!this.store.hasTurns(root.id)) {
      const context = this.store.context(taskId);
      this.store.ensureInitialPrompt(root, `${initialPrompt(this.store.get(taskId))}\n\nCaptured task configuration:\n${JSON.stringify(context)}\n\nUse forge_root read_image with an attachment's artifactId to inspect task images. Inspect the repository yourself before deciding whether Worker setup is needed. Include the configured verification command in the Worker assignment when runProjectTests is true. Require browser evidence when requested. Review that evidence yourself. These instructions are task intent, not prior verification results.`);
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
      const error = new AggregateError(failures, "Some OpenCode sessions could not be stopped");
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
      const taskScope = scope(control, current);
      const nativeSessionId = await this.harness.ensureSession(taskScope, current.nativeSessionId);
      const session = this.store.bindHarnessSession({ sessionId: previous.id, generation: previous.generation, nativeSessionId });
      try {
        await this.harness.attach({ scope: taskScope, nativeSessionId, paneId: session.paneId, rootPaneId: session.kind === "worker" ? this.store.currentSession(control.taskId, "root")?.paneId ?? null : null, persistPane: (paneId) => this.store.bindPane({ sessionId: session.id, generation: session.generation, paneId }) });
      } catch (error) {
        new StructuredLogger().warn("Task display attachment is unavailable; native work is retained", { taskId: control.taskId }, { error: error instanceof Error ? error.message : String(error) });
      }
      for (const turn of this.store.pendingTurns(session.id)) {
        if (this.store.get(control.taskId).status !== "active") break;
        const intent = createOpenCodePromptIntent({ sessionID: nativeSessionId, messageID: turn.id, directory: taskScope.directory, prompt: turn.promptText, model: { providerID: taskScope.profile.providerID, modelID: taskScope.profile.modelID }, agent: `forge-${session.kind}`, variant: taskScope.profile.reasoningEffort, dispatch: turn.status === "pending_prompt" ? "not_submitted" : "ambiguous" });
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

  private async finishTurn(taskScope: OpenCodeTaskScope, session: TaskSession, turn: TaskTurn, observed: OpenCodePromptObservation): Promise<void> {
    const text = await this.harness.resultText(taskScope, observed);
    const evidence = JSON.stringify({ state: observed.state, native: observed.native, reason: observed.reason, interruptedExecution: observed.interruptedExecution, text });
    if (session.kind === "root") {
      this.store.completeRootTurn(turn.id, evidence, observed.interruptedExecution ? "The previous execution stopped when its OpenCode server exited. Its admitted message will not be replayed. Observe current task, worktree and GitHub state, preserve any partial work, and continue from that evidence." : undefined);
      if (observed.state !== "completed" && !observed.interruptedExecution && this.store.get(session.taskId).status === "active") {
        this.store.askHuman(session.taskId, `OpenCode stopped the Root turn (${observed.state}). ${observed.reason ?? text} Can you resolve the failure and continue?`);
      }
      return;
    }
    this.store.recordWorkerResultAndWake({ taskId: session.taskId, sessionId: session.id, generation: session.generation, receiptId: `${observed.sessionID}:${observed.messageID}:${observed.state}`, observation: evidence, ...(observed.assistantMessageID ? { nativeTurnId: observed.assistantMessageID } : {}) });
  }
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

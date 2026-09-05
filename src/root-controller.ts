import { runCommand } from "./command-runner.js";
import { DeliveryOperations } from "./delivery-operations.js";
import { StructuredLogger } from "./logging.js";
import { createOpenCodePromptIntent, type OpenCodePromptObservation } from "./opencode-session.js";
import type { OpenCodeTaskRuntime, OpenCodeTaskScope } from "./opencode-task-runtime.js";
import type { RootBridgeAdapter } from "./root-bridge.js";
import type { DeliveryOperation, RootIdentity } from "./root-contracts.js";
import type { TaskControlStore } from "./root-session-store.js";
import type { TaskControl, TaskSession, TaskTurn } from "./task-control.js";

export type TaskHarness = Pick<OpenCodeTaskRuntime, "ensureSession" | "attach" | "observe" | "dispatch" | "resultText">;

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
  return `You are the continuing read-only Root for this Forge task. Use forge_root to observe the task, delegate one scoped Worker at a time, and request Forge-owned delivery operations. Read the Worker's actual result and verify the change before delivery. The Worker must edit and verify directly, without subagents, pushes, or GitHub mutations. Do not write files or launch agents yourself. Preserve out-of-band work and adopt matching GitHub state. Ask one specific human question only when an external ambiguity or necessary decision prevents progress. Continue until the delivery target is observed, a Worker is running, or you have asked that question.\n\nObjective: ${control.objective}\nDelivery target: ${control.deliveryTarget}\nRepository: ${control.deliveryIntent.repository}\nBranch: ${control.deliveryIntent.headBranch}`;
}

export class RootController implements RootBridgeAdapter {
  constructor(readonly store: TaskControlStore, private readonly harness: TaskHarness, private readonly delivery = new DeliveryOperations(store)) {}

  async assertCurrentRoot(root: RootIdentity): Promise<void> { this.store.assertCurrentRoot(root); }

  async observe(root: RootIdentity): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    const control = this.store.get(root.taskId);
    const pullRequest = await this.delivery.observe(root.taskId);
    const worktree = control.worktree ? await observeWorktree(control.worktree.path) : null;
    return { control: this.store.get(root.taskId), root: this.store.currentSession(root.taskId, "root"), worker: this.store.currentSession(root.taskId, "worker"), worktree, pullRequest };
  }

  async delegateWorker(root: RootIdentity, instruction: string): Promise<unknown> {
    const worker = this.store.launchWorker({ taskId: root.taskId, rootSessionId: root.sessionId, rootGeneration: root.generation, instruction });
    await this.recoverSession(worker);
    return this.store.currentSession(root.taskId, "worker");
  }

  async requestDelivery(root: RootIdentity, operation: DeliveryOperation, expectedHead?: string): Promise<unknown> {
    return this.delivery.execute(root, operation, expectedHead);
  }

  async askHuman(root: RootIdentity, question: string): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    this.store.askHuman(root.taskId, question);
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
    if (this.store.get(taskId).status !== "active") return;
    const root = this.store.currentSession(taskId, "root") ?? this.store.claimRoot({ taskId });
    await this.recoverSession(root);
    const worker = this.store.currentSession(taskId, "worker");
    if (worker && worker.lifecycle !== "stopped" && worker.lifecycle !== "cancelled") await this.recoverSession(worker);
    if (this.store.get(taskId).status === "active") {
      this.store.wakeIdleRoot(taskId);
      this.store.scheduleWake(taskId, new Date(Date.now() + 15_000).toISOString());
    }
  }

  private async recoverSession(previous: TaskSession): Promise<void> {
    if (this.store.get(previous.taskId).status !== "active") return;
    const owner = this.store.claimSessionOperation({ sessionId: previous.id, generation: previous.generation });
    if (!owner) return;
    try {
      const control = this.store.get(previous.taskId);
      const current = this.store.currentSession(previous.taskId, previous.kind);
      if (!current || current.id !== previous.id || current.generation !== previous.generation) return;
      const taskScope = scope(control, current);
      const nativeSessionId = await this.harness.ensureSession(taskScope, current.nativeSessionId);
      const session = this.store.bindHarnessSession({ sessionId: previous.id, generation: previous.generation, nativeSessionId });
      if (session.kind === "root" && !this.store.hasTurns(session.id)) {
        this.store.wakeRoot({ taskId: control.taskId, rootSessionId: session.id, generation: session.generation, prompt: initialPrompt(control) });
      }
      try {
        await this.harness.attach({ scope: taskScope, nativeSessionId, paneId: session.paneId, rootPaneId: session.kind === "worker" ? this.store.currentSession(control.taskId, "root")?.paneId ?? null : null, persistPane: (paneId) => this.store.bindPane({ sessionId: session.id, generation: session.generation, paneId }) });
      } catch (error) {
        new StructuredLogger().warn("Task display attachment is unavailable; native work is retained", { taskId: control.taskId }, { error: error instanceof Error ? error.message : String(error) });
      }
      for (const turn of this.store.pendingTurns(session.id)) {
        if (this.store.get(control.taskId).status !== "active") break;
        const intent = createOpenCodePromptIntent({ sessionID: nativeSessionId, messageID: turn.id, directory: taskScope.directory, prompt: turn.promptText, model: { providerID: taskScope.profile.providerID, modelID: taskScope.profile.modelID }, agent: `forge-${session.kind}`, variant: taskScope.profile.reasoningEffort, dispatch: turn.status === "pending_prompt" ? "not_submitted" : "ambiguous" });
        let observed = await this.harness.observe(taskScope, intent);
        if (observed.retry === "allowed" && turn.status === "pending_prompt") {
          observed = await this.harness.dispatch(taskScope, intent, async () => this.store.claimPrompt(turn.id));
        }
        if (observed.admission === "observed" && turn.status !== "prompted") this.store.markPrompted({ turnId: turn.id, generation: session.generation });
        if (!["completed", "error", "interrupted", "terminal_incomplete"].includes(observed.state)) break;
        await this.finishTurn(taskScope, session, turn, observed);
      }
    } finally {
      this.store.releaseSessionOperation(previous.id, owner);
    }
  }

  private async finishTurn(taskScope: OpenCodeTaskScope, session: TaskSession, turn: TaskTurn, observed: OpenCodePromptObservation): Promise<void> {
    const text = await this.harness.resultText(taskScope, observed);
    const evidence = JSON.stringify({ state: observed.state, native: observed.native, reason: observed.reason, text });
    if (session.kind === "root") {
      this.store.completeRootTurn(turn.id, evidence);
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

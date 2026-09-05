import { chmod, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrClient } from "./herdr-client.js";
import { herdrRuntime } from "./agent-providers/herdr-runtime.js";
import { runCommand } from "./command-runner.js";
import { rootBridgeMcpConfig } from "./root-bridge.js";
import type { RootBridgeAdapter } from "./root-bridge.js";
import type { RootIdentity } from "./root-contracts.js";
import { TaskControlStore } from "./root-session-store.js";
import type { TaskProfile, TaskSession } from "./task-control.js";
import { observeNativePromptMarker, observeNativeWorkerTurn, type NativeWorkerTurnObservation } from "./root-worker-turn-observation.js";

export interface WorkerRuntime {
  launch(input: { taskId: string; root: RootIdentity; session: TaskSession; instruction: string; persistAttempt: (attempt: { paneId: string; agentName: string }) => void }): Promise<{ paneId: string; agentName: string; nativeSessionId?: string }>;
}
export interface RootRuntime {
  launch(input: { taskId: string; session: TaskSession; objective: string; persistAttempt: (attempt: { paneId: string; agentName: string; nativeSessionId?: string }) => void }): Promise<{ paneId: string; agentName: string; nativeSessionId?: string }>;
}

export type WorkerProfile = TaskProfile;

export class RootController implements RootBridgeAdapter {
  constructor(
    readonly store: TaskControlStore,
    private readonly herdr: Pick<HerdrClient, "runtimeSnapshot" | "prompt" | "readAgent">,
    private readonly workerRuntime?: WorkerRuntime,
    private readonly rootRuntime?: RootRuntime,
    private readonly observeWorkerTurn: (input: { cwd: string; nativeSessionId: string; assignmentMarker: string }) => Promise<NativeWorkerTurnObservation> = observeNativeWorkerTurn,
  ) {}

  async assertCurrentRoot(root: RootIdentity): Promise<void> { this.store.assertCurrentRoot(root); }

  async observe(root: RootIdentity): Promise<unknown> {
    const control = this.store.get(root.taskId);
    const rootSession = this.store.currentSession(root.taskId, "root");
    const worker = this.store.currentSession(root.taskId, "worker");
    const snapshot = await this.herdr.runtimeSnapshot().catch(() => null);
    const worktree = control.worktree ? await observeWorktree(control.worktree.path) : null;
    return { control, root: rootSession, worker, herdr: snapshot, worktree };
  }

  async delegateWorker(root: RootIdentity, instruction: string): Promise<unknown> {
    if (!this.workerRuntime) throw new Error("worker_runtime_unconfigured");
    const worker = this.store.launchWorker({ taskId: root.taskId, rootSessionId: root.sessionId, rootGeneration: root.generation, instruction });
    if (!this.store.claimLaunch({ sessionId: worker.id, generation: worker.generation })) return this.store.currentSession(root.taskId, "worker");
    try {
      const launched = await this.workerRuntime.launch({ taskId: root.taskId, root, session: worker, instruction, persistAttempt: (attempt) => this.store.bindLaunchAttempt({ sessionId: worker.id, generation: worker.generation, ...attempt }) });
      return this.store.bindLive({ sessionId: worker.id, generation: worker.generation, ...launched });
    } catch (error) {
      this.store.observeSession({ sessionId: worker.id, generation: worker.generation, lifecycle: "unknown", terminalObservation: error instanceof Error ? error.message : "Worker launch outcome is unknown" });
      throw error;
    }
  }

  async requestDelivery(root: RootIdentity): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    throw new Error("delivery_operations_unconfigured");
  }

  async askHuman(root: RootIdentity, question: string): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    this.store.askHuman(root.taskId, question);
    return this.store.get(root.taskId);
  }

  async wakeRoot(root: RootIdentity, prompt: string): Promise<void> {
    const turn = this.store.wakeRoot({ taskId: root.taskId, rootSessionId: root.sessionId, generation: root.generation, prompt });
    await this.deliverTurn(root, turn);
  }

  private async deliverTurn(root: RootIdentity, turn: { id: string; promptHash: string; promptText: string; generation: number }): Promise<void> {
    const session = this.store.currentSession(root.taskId, "root");
    if (!session?.agentName) throw new Error("root_not_live");
    this.store.markPromptUnknown(turn.id);
    try {
      await this.herdr.prompt(session.agentName, `${turn.promptText}\n\n[forge-turn:${turn.promptHash}]`, { waitForWorking: false });
      this.store.markPrompted({ turnId: turn.id, generation: turn.generation });
    } catch {}
  }

  async recordWorkerResult(input: { taskId: string; sessionId: string; generation: number; receiptId: string; observation: string; nativeTurnId?: string }): Promise<void> {
    const recorded = this.store.recordWorkerResultAndWake(input);
    if (recorded.kind === "duplicate") return;
    const root = this.store.currentSession(input.taskId, "root");
    if (!root || root.lifecycle !== "live") return;
    const rootIdentity = { taskId: input.taskId, sessionId: root.id, generation: root.generation };
    await this.deliverTurn(rootIdentity, recorded.wake);
  }

  async recover(taskId: string): Promise<void> {
    let root = this.store.currentSession(taskId, "root");
    if (!root || !root.current || root.lifecycle === "cancelled") return;
    let snapshot;
    try { snapshot = await this.herdr.runtimeSnapshot(); } catch { this.store.observeSession({ sessionId: root.id, generation: root.generation, lifecycle: "unknown" }); const worker = this.store.currentSession(taskId, "worker"); if (worker) this.store.observeSession({ sessionId: worker.id, generation: worker.generation, lifecycle: "unknown" }); this.store.scheduleWake(taskId, new Date().toISOString()); return; }
    const rootAgent = root.paneId ? snapshot.agents.find((agent) => agent.paneId === root!.paneId) : undefined;
    if (!root.nativeSessionId && root.paneId && root.agentName && rootAgent?.name === root.agentName && rootAgent.agentSession)
      root = this.store.bindNativeSession({ sessionId: root.id, generation: root.generation, paneId: root.paneId, agentName: root.agentName, nativeSessionId: rootAgent.agentSession });
    const observe = (session: TaskSession): "live" | "stopped" | "unknown" => {
      if (!session.paneId || !session.agentName) return "unknown";
      const agent = session.paneId ? snapshot.agents.find((candidate) => candidate.paneId === session.paneId) : undefined;
      const pane = session.paneId ? snapshot.panes.find((candidate) => candidate.paneId === session.paneId) : undefined;
      if (!agent) return !pane && !session.launchOwner ? "stopped" : "unknown";
      if (agent.name !== session.agentName || session.nativeSessionId && agent.agentSession !== session.nativeSessionId) return "unknown";
      if (["failed", "cancelled", "stopped"].includes(agent.status ?? "")) return "stopped";
      return "live";
    };
    const rootAbsent = !root.paneId || !root.agentName || !snapshot.agents.some((agent) => agent.paneId === root.paneId && agent.name === root.agentName);
    if (root.lifecycle === "reserved" && root.launchOwner) {
      if (this.store.reclaimDeadLaunch({ sessionId: root.id, generation: root.generation, observedAbsent: rootAbsent }) && this.rootRuntime && this.store.claimLaunch({ sessionId: root.id, generation: root.generation })) {
        const control = this.store.get(taskId);
        const launched = await this.rootRuntime.launch({ taskId, session: root, objective: control.objective, persistAttempt: (attempt) => this.store.bindLaunchAttempt({ sessionId: root.id, generation: root.generation, ...attempt }) });
        this.store.bindLive({ sessionId: root.id, generation: root.generation, ...launched });
      } else this.store.scheduleWake(taskId, new Date().toISOString());
      return;
    }
    const rootLifecycle = observe(root);
    this.store.observeSession({ sessionId: root.id, generation: root.generation, lifecycle: rootLifecycle });
    let worker = this.store.currentSession(taskId, "worker");
    if (worker) {
      const liveAgent = worker.paneId ? snapshot.agents.find((candidate) => candidate.paneId === worker!.paneId) : undefined;
      const workerAbsent = !worker.paneId || !worker.agentName || !liveAgent || liveAgent.name !== worker.agentName;
      if (worker.lifecycle === "reserved" && worker.launchOwner) {
        if (this.store.reclaimDeadLaunch({ sessionId: worker.id, generation: worker.generation, observedAbsent: workerAbsent })) {
          const currentRoot = this.store.currentSession(taskId, "root");
          const instruction = this.store.pendingTurns(worker.id)[0]?.promptText;
          const retryWorker = worker;
          if (this.workerRuntime && currentRoot && instruction && this.store.claimLaunch({ sessionId: retryWorker.id, generation: retryWorker.generation })) {
            const launched = await this.workerRuntime.launch({ taskId, root: { taskId, sessionId: currentRoot.id, generation: currentRoot.generation }, session: retryWorker, instruction, persistAttempt: (attempt) => this.store.bindLaunchAttempt({ sessionId: retryWorker.id, generation: retryWorker.generation, ...attempt }) });
            this.store.bindLive({ sessionId: retryWorker.id, generation: retryWorker.generation, ...launched });
          }
        } else this.store.scheduleWake(taskId, new Date().toISOString());
        return;
      }
      if (!worker.nativeSessionId && worker.paneId && worker.agentName && liveAgent?.name === worker.agentName && liveAgent.agentSession)
        worker = this.store.bindNativeSession({ sessionId: worker.id, generation: worker.generation, paneId: worker.paneId, agentName: worker.agentName, nativeSessionId: liveAgent.agentSession });
      const workerLifecycle = observe(worker);
      const control = this.store.get(taskId);
      const native = worker.nativeSessionId && worker.assignmentHash && control.worktree
        ? await this.observeWorkerTurn({ cwd: control.worktree.path, nativeSessionId: worker.nativeSessionId, assignmentMarker: `forge-worker-assignment:${worker.id}:${worker.generation}:${worker.assignmentHash}` })
        : { kind: "unknown" } as const;
      if (native.kind === "completed") {
        this.store.observeSession({ sessionId: worker.id, generation: worker.generation, lifecycle: "stopped" });
        await this.recordWorkerResult({ taskId, sessionId: worker.id, generation: worker.generation, receiptId: native.receiptId, observation: native.evidence, nativeTurnId: native.nativeTurnId });
      } else {
        if (native.kind === "unknown") this.store.scheduleWake(taskId, new Date().toISOString());
        if (native.kind === "accepted") this.store.markWorkerPromptAccepted({ sessionId: worker.id, generation: worker.generation });
        this.store.observeSession({ sessionId: worker.id, generation: worker.generation, lifecycle: workerLifecycle });
        if (workerLifecycle === "stopped" && native.kind === "missing") {
          const retry = this.store.scheduleWorkerPromptRetry({ sessionId: worker.id, generation: worker.generation });
          const currentRoot = this.store.currentSession(taskId, "root");
          if (this.workerRuntime && currentRoot && this.store.claimLaunch({ sessionId: retry.id, generation: retry.generation })) {
            const launched = await this.workerRuntime.launch({ taskId, root: { taskId, sessionId: currentRoot.id, generation: currentRoot.generation }, session: retry, instruction: this.store.pendingTurns(retry.id)[0]?.promptText ?? "", persistAttempt: (attempt) => this.store.bindLaunchAttempt({ sessionId: retry.id, generation: retry.generation, ...attempt }) });
            this.store.bindLive({ sessionId: retry.id, generation: retry.generation, ...launched });
          }
        }
        if (workerLifecycle === "stopped" && native.kind === "accepted") {
          const interrupted = this.store.recordWorkerInterruptionAndWake({ taskId, sessionId: worker.id, generation: worker.generation, observation: "The native Worker turn started but did not complete. Its worktree is preserved for one continuation." });
          if (interrupted.kind === "recorded") {
            const currentRoot = this.store.currentSession(taskId, "root");
            if (currentRoot?.lifecycle === "live") await this.deliverTurn({ taskId, sessionId: currentRoot.id, generation: currentRoot.generation }, interrupted.wake);
          }
        }
      }
    }
    if (rootLifecycle === "stopped") {
      const replacement = await this.store.ensureRoot({ taskId, observe: async (session) => session.id === root.id ? "stopped" : "unknown" });
      if (replacement.id !== root.id && this.rootRuntime && this.store.claimLaunch({ sessionId: replacement.id, generation: replacement.generation })) {
        const control = this.store.get(taskId);
        const launched = await this.rootRuntime.launch({ taskId, session: replacement, objective: control.objective, persistAttempt: (attempt) => this.store.bindLaunchAttempt({ sessionId: replacement.id, generation: replacement.generation, ...attempt }) });
        this.store.bindLive({ sessionId: replacement.id, generation: replacement.generation, ...launched });
        for (const turn of this.store.pendingTurns(replacement.id)) if (turn.status === "pending_prompt") await this.deliverTurn({ taskId, sessionId: replacement.id, generation: replacement.generation }, turn);
      }
      return;
    }
    for (const turn of this.store.pendingTurns(root.id)) {
      if (turn.status === "pending_prompt") { await this.deliverTurn({ taskId, sessionId: root.id, generation: root.generation }, turn); continue; }
      const control = this.store.get(taskId);
      if (turn.status === "unknown" && control.rootProfile.provider === "codex" && root.nativeSessionId && control.worktree) {
        const prompt = await observeNativePromptMarker({ cwd: control.worktree.path, nativeSessionId: root.nativeSessionId, marker: `forge-turn:${turn.promptHash}` });
        if (prompt === "accepted") this.store.markPrompted({ turnId: turn.id, generation: root.generation });
        else this.store.scheduleWake(taskId, new Date().toISOString());
      } else if (turn.status === "unknown") this.store.scheduleWake(taskId, new Date().toISOString());
    }
  }
}

export function productionRootRuntime(databasePath: string, store: TaskControlStore, herdr: Pick<HerdrClient, "createWorkspace" | "startAgent" | "prompt">): RootRuntime {
  return {
    async launch(input) {
      const control = store.get(input.taskId);
      if (!control.worktree || control.rootProfile.model === "unconfigured") throw new Error("root_profile_unconfigured");
      const currentFile = fileURLToPath(import.meta.url); const extension = currentFile.endsWith(".ts") ? ".ts" : ".js";
      const bindingDirectory = join(dirname(databasePath), "runtime", "root-bridges");
      await mkdir(bindingDirectory, { recursive: true, mode: 0o700 });
      const bindingPath = join(bindingDirectory, `${input.session.id}.binding.json`);
      const bridgeEntry = join(dirname(currentFile), `root-bridge${extension}`);
      const command = extension === ".ts" ? join(process.cwd(), "node_modules", ".bin", "tsx") : process.execPath;
      const bridge = { version: 1 as const, root: { taskId: input.taskId, sessionId: input.session.id, generation: input.session.generation }, databasePath, server: { command, args: [bridgeEntry, "--binding", bindingPath] } };
      await writeFile(bindingPath, `${JSON.stringify(bridge)}\n`, { mode: 0o600 }); await chmod(bindingPath, 0o600);
      await writeFile(join(bindingDirectory, `${input.session.id}.mcp.json`), `${JSON.stringify(rootBridgeMcpConfig(bridge))}\n`, { mode: 0o600 });
      const workspace = await herdr.createWorkspace({ label: `forge-${input.taskId.slice(-12)}`, cwd: control.worktree.path, focus: false });
      const name = `forge-${input.taskId.slice(-8)}-root-${input.session.generation}-${input.session.id.slice(-8)}`.slice(0, 32);
      const runtime = herdrRuntime(control.rootProfile.provider);
      const nativeSessionId = runtime.presetSessionId ? randomUUID() : undefined;
      input.persistAttempt({ paneId: workspace.rootPane.paneId, agentName: name, ...(nativeSessionId ? { nativeSessionId } : {}) });
      const live = await herdr.startAgent({ name, paneId: workspace.rootPane.paneId, kind: control.rootProfile.provider === "claude" ? "claude" : "codex", args: runtime.launchArgs(control.rootProfile, nativeSessionId ?? null, false, undefined, { kind: "root", bridgeConfig: bridge, bridgeConfigPath: join(bindingDirectory, `${input.session.id}.mcp.json`) }) });
      const prompted = await herdr.prompt(live.name, `You are the continuing Root for this task. Objective: ${input.objective}. Use only forge_root to observe, delegate, deliver, or ask one human question.`, { waitForWorking: false });
      return { paneId: live.paneId, agentName: live.name, ...(prompted.agentSession ? { nativeSessionId: prompted.agentSession } : live.agentSession ? { nativeSessionId: live.agentSession } : nativeSessionId ? { nativeSessionId } : {}) };
    },
  };
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

export function productionWorkerRuntime(store: TaskControlStore, herdr: Pick<HerdrClient, "splitPane" | "startAgent" | "prompt">): WorkerRuntime {
  return {
    async launch(input) {
      const root = store.currentSession(input.taskId, "root");
      const control = store.get(input.taskId);
      if (!root?.paneId || !control.worktree) throw new Error("worker_launch_context_missing");
      if (control.workerProfile.provider !== "codex" || control.workerProfile.model === "unconfigured") throw new Error("worker_profile_unconfigured");
      const pane = await herdr.splitPane({ paneId: root.paneId, direction: "right", cwd: control.worktree.path, focus: false });
      const name = `forge-${input.taskId.slice(-8)}-w-${input.session.generation}-${input.session.id.slice(-10)}`.slice(0, 32);
      input.persistAttempt({ paneId: pane.paneId, agentName: name });
      const live = await herdr.startAgent({
        name,
        paneId: pane.paneId,
        kind: "codex",
        args: herdrRuntime("codex").launchArgs(control.workerProfile, null, false, undefined, { kind: "worker" }),
      });
      const marker = `forge-worker-assignment:${input.session.id}:${input.session.generation}:${input.session.assignmentHash}`;
      const prompted = await herdr.prompt(live.name, `${input.instruction}\n\n[${marker}]`, { waitForWorking: false });
      return { paneId: live.paneId, agentName: live.name, ...(prompted.agentSession ? { nativeSessionId: prompted.agentSession } : live.agentSession ? { nativeSessionId: live.agentSession } : {}) };
    },
  };
}

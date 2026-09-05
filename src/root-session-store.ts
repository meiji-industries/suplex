import { createHash, randomUUID } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import { PullRequestReferenceSchema, TaskControlStatusSchema, TaskProfileSchema, TaskSessionKindSchema, TaskSessionLifecycleSchema, TaskTurnStatusSchema, WorktreeReferenceSchema, type TaskControl, type TaskProfile, type TaskSession, type TaskSessionKind, type TaskTurn, type WorktreeReference } from "./task-control.js";

const now = (): string => new Date().toISOString();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown>;

function text(row: Row, key: string): string | null { const value = row[key]; return typeof value === "string" ? value : null; }
function integer(row: Row, key: string): number { const value = row[key]; if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Invalid persisted ${key}`); return value; }
function parseJson<T>(value: string | null, schema: { parse(input: unknown): T }): T | null { return value === null ? null : schema.parse(JSON.parse(value)); }
function control(row: Row): TaskControl {
  const status = TaskControlStatusSchema.parse(text(row, "status"));
  const taskId = text(row, "task_id"); const objective = text(row, "objective"); const deliveryTarget = text(row, "delivery_target");
  if (!taskId || !objective || !deliveryTarget) throw new Error("Invalid persisted task control");
  const rootProfile = parseJson(text(row, "root_profile_json"), TaskProfileSchema); const workerProfile = parseJson(text(row, "worker_profile_json"), TaskProfileSchema);
  if (!rootProfile || !workerProfile) throw new Error("Task profiles are missing");
  return { taskId, objective, deliveryTarget, status, wakeAt: text(row, "wake_at"), humanQuestion: text(row, "human_question"), worktree: parseJson(text(row, "worktree_json"), WorktreeReferenceSchema), pullRequest: parseJson(text(row, "pull_request_json"), PullRequestReferenceSchema), rootSessionId: text(row, "root_session_id"), workerSessionId: text(row, "worker_session_id"), rootProfile, workerProfile };
}
function session(row: Row): TaskSession {
  const id = text(row, "id"); const taskId = text(row, "task_id");
  if (!id || !taskId) throw new Error("Invalid persisted task session");
  const launchOwnerPid = row.launch_owner_pid === null || row.launch_owner_pid === undefined ? null : integer(row, "launch_owner_pid");
  return { id, taskId, kind: TaskSessionKindSchema.parse(text(row, "kind")), generation: integer(row, "generation"), current: integer(row, "is_current") === 1, paneId: text(row, "pane_id"), agentName: text(row, "agent_name"), nativeSessionId: text(row, "native_session_id"), lifecycle: TaskSessionLifecycleSchema.parse(text(row, "lifecycle")), assignmentHash: text(row, "assignment_hash"), promptHash: text(row, "prompt_hash"), resultReceiptId: text(row, "result_receipt_id"), launchOwner: text(row, "launch_owner"), launchOwnerPid };
}
function turn(row: Row): TaskTurn {
  const id = text(row, "id"); const taskId = text(row, "task_id"); const sessionId = text(row, "session_id"); const promptHash = text(row, "prompt_hash"); const promptText = text(row, "prompt_text");
  if (!id || !taskId || !sessionId || !promptHash || promptText === null) throw new Error("Invalid persisted task turn");
  return { id, taskId, sessionId, generation: integer(row, "generation"), assignmentHash: text(row, "assignment_hash"), promptHash, promptText, status: TaskTurnStatusSchema.parse(text(row, "status")), resultReceiptId: text(row, "result_receipt_id"), terminalObservation: text(row, "terminal_observation"), nativeTurnId: text(row, "native_turn_id") };
}

export class TaskControlStore {
  constructor(private readonly database: ForgeDatabase, private readonly processAlive: (pid: number) => boolean = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }) {}
  create(input: { taskId: string; objective: string; deliveryTarget: string; rootProfile: TaskProfile; workerProfile: TaskProfile; worktree?: WorktreeReference }): TaskControl {
    const time = now();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_controls (task_id, objective, delivery_target, status, wake_at, human_question, worktree_json, pull_request_json, root_session_id, worker_session_id, root_profile_json, worker_profile_json, created_at, updated_at) VALUES (?, ?, ?, 'active', NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?)").run(input.taskId, input.objective, input.deliveryTarget, input.worktree ? JSON.stringify(input.worktree) : null, JSON.stringify(TaskProfileSchema.parse(input.rootProfile)), JSON.stringify(TaskProfileSchema.parse(input.workerProfile)), time, time));
    return this.get(input.taskId);
  }
  get(taskId: string): TaskControl {
    return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_controls WHERE task_id = ?").get(taskId) as Row | undefined; if (!row) throw new Error(`Task control ${taskId} does not exist`); return control(row); });
  }
  currentSession(taskId: string, kind: TaskSessionKind): TaskSession | null {
    return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = ? AND is_current = 1").get(taskId, kind) as Row | undefined; return row ? session(row) : null; });
  }
  claimRoot(input: { taskId: string; expectedGeneration?: number }): TaskSession {
    return this.claim(input.taskId, "root", input.expectedGeneration, undefined);
  }
  async ensureRoot(input: { taskId: string; observe: (session: TaskSession) => Promise<"live" | "stopped" | "unknown"> }): Promise<TaskSession> {
    const current = this.currentSession(input.taskId, "root");
    if (!current) return this.claimRoot({ taskId: input.taskId });
    const lifecycle = await input.observe(current);
    this.observeSession({ sessionId: current.id, generation: current.generation, lifecycle });
    if (lifecycle !== "stopped") return this.currentSession(input.taskId, "root")!;
    try {
      return this.claimRoot({ taskId: input.taskId, expectedGeneration: current.generation });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "stale_generation") throw error;
      const replacement = this.currentSession(input.taskId, "root");
      if (!replacement) throw error;
      return replacement;
    }
  }
  launchWorker(input: { taskId: string; rootSessionId: string; rootGeneration: number; instruction: string }): TaskSession {
    const assignmentHash = hash(input.instruction); const time = now(); const id = randomUUID();
    return this.database.authTransaction((db) => {
      const task = db.prepare("SELECT status FROM forge_task_controls WHERE task_id = ?").get(input.taskId) as Row | undefined;
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ? AND task_id = ? AND kind = 'root' AND is_current = 1 AND generation = ?").get(input.rootSessionId, input.taskId, input.rootGeneration) as Row | undefined;
      if (!task || TaskControlStatusSchema.parse(text(task, "status")) !== "active" || !root || TaskSessionLifecycleSchema.parse(text(root, "lifecycle")) === "cancelled") throw new Error("root_identity_mismatch");
      const current = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker' AND is_current = 1").get(input.taskId) as Row | undefined;
      if (current && ["reserved", "live", "unknown"].includes(TaskSessionLifecycleSchema.parse(text(current, "lifecycle")))) throw new Error("worker_already_assigned");
      if (current) db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'stopped', updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1").run(time, text(current, "id"), integer(current, "generation"));
      const generation = (current ? integer(current, "generation") : 0) + 1;
      db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, pane_id, agent_name, native_session_id, lifecycle, assignment_hash, prompt_hash, result_receipt_id, created_at, updated_at) VALUES (?, ?, 'worker', ?, 1, NULL, NULL, NULL, 'reserved', ?, NULL, NULL, ?, ?)").run(id, input.taskId, generation, assignmentHash, time, time);
      db.prepare("UPDATE forge_task_controls SET worker_session_id = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(id, time, input.taskId);
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, ?, NULL, NULL, ?)").run(randomUUID(), input.taskId, id, generation, assignmentHash, assignmentHash, input.instruction, time, time);
      return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
    });
  }
  private claim(taskId: string, kind: TaskSessionKind, expectedGeneration: number | undefined, assignmentHash: string | undefined): TaskSession {
    const time = now(); const id = randomUUID();
    return this.database.authTransaction((db) => {
      const task = db.prepare("SELECT status FROM forge_task_controls WHERE task_id = ?").get(taskId) as Row | undefined;
      if (!task || TaskControlStatusSchema.parse(text(task, "status")) !== "active") throw new Error("task_not_active");
      const existing = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = ? AND is_current = 1").get(taskId, kind) as Row | undefined;
      if (existing && expectedGeneration === undefined) return session(existing);
      if (existing && expectedGeneration !== undefined && integer(existing, "generation") !== expectedGeneration) throw new Error("stale_generation");
      if (existing) db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = CASE WHEN lifecycle = 'live' THEN 'live' ELSE 'stopped' END, updated_at = ? WHERE id = ? AND generation = ?").run(time, text(existing, "id"), integer(existing, "generation"));
      const generation = (existing ? integer(existing, "generation") : 0) + 1;
      db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, pane_id, agent_name, native_session_id, lifecycle, assignment_hash, prompt_hash, result_receipt_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, NULL, NULL, NULL, 'reserved', ?, NULL, NULL, ?, ?)").run(id, taskId, kind, generation, assignmentHash ?? null, time, time);
      if (kind === "root" && existing) db.prepare("UPDATE forge_task_turns SET session_id = ?, generation = ?, updated_at = ? WHERE task_id = ? AND session_id = ? AND status IN ('pending_prompt', 'unknown')").run(id, generation, time, taskId, text(existing, "id"));
      db.prepare(kind === "root" ? "UPDATE forge_task_controls SET root_session_id = ?, updated_at = ? WHERE task_id = ?" : "UPDATE forge_task_controls SET worker_session_id = ?, updated_at = ? WHERE task_id = ?").run(id, time, taskId);
      return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
    });
  }
  bindLive(input: { sessionId: string; generation: number; paneId: string; agentName: string; nativeSessionId?: string }): TaskSession {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET pane_id = ?, agent_name = ?, native_session_id = ?, lifecycle = 'live', launch_owner = NULL, launch_owner_pid = NULL, launch_claimed_at = NULL, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle = 'reserved'").run(input.paneId, input.agentName, input.nativeSessionId ?? null, now(), input.sessionId, input.generation).changes);
    if (changed !== 1) throw new Error("stale_generation"); return this.byId(input.sessionId);
  }
  bindLaunchAttempt(input: { sessionId: string; generation: number; paneId: string; agentName: string }): void {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET pane_id = ?, agent_name = ?, lifecycle = 'reserved', updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle = 'reserved'").run(input.paneId, input.agentName, now(), input.sessionId, input.generation).changes);
    if (changed !== 1) throw new Error("stale_generation");
  }
  bindNativeSession(input: { sessionId: string; generation: number; paneId: string; agentName: string; nativeSessionId: string }): TaskSession {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET native_session_id = ?, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND pane_id = ? AND agent_name = ? AND native_session_id IS NULL").run(input.nativeSessionId, now(), input.sessionId, input.generation, input.paneId, input.agentName).changes);
    if (changed !== 1) throw new Error("stale_generation");
    return this.byId(input.sessionId);
  }
  claimLaunch(input: { sessionId: string; generation: number }): string | null {
    const owner = randomUUID();
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET launch_owner = ?, launch_owner_pid = ?, launch_claimed_at = ?, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle = 'reserved' AND launch_owner IS NULL").run(owner, process.pid, now(), now(), input.sessionId, input.generation).changes);
    return changed === 1 ? owner : null;
  }
  reclaimDeadLaunch(input: { sessionId: string; generation: number; observedAbsent: boolean }): boolean {
    if (!input.observedAbsent) return false;
    const owner = this.byId(input.sessionId);
    if (!owner.launchOwnerPid || this.processAlive(owner.launchOwnerPid)) return false;
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET launch_owner = NULL, launch_owner_pid = NULL, launch_claimed_at = NULL, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle = 'reserved' AND launch_owner IS NOT NULL AND launch_owner_pid = ?").run(now(), input.sessionId, input.generation, owner.launchOwnerPid).changes);
    return changed === 1;
  }
  markWorkerPromptAccepted(input: { sessionId: string; generation: number }): void {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_turns SET status = 'prompted', prompt_observed_at = ?, prompted_at = COALESCE(prompted_at, ?), updated_at = ? WHERE session_id = ? AND generation = ? AND status IN ('unknown', 'pending_prompt')").run(now(), now(), now(), input.sessionId, input.generation).changes);
    if (changed === 1) return;
    const current = this.database.authQuery((db) => db.prepare("SELECT status FROM forge_task_turns WHERE session_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(input.sessionId, input.generation) as Row | undefined);
    if (!current || TaskTurnStatusSchema.parse(text(current, "status")) !== "prompted") throw new Error("stale_turn");
  }
  scheduleWorkerPromptRetry(input: { sessionId: string; generation: number }): TaskSession {
    const changed = this.database.authTransaction((db) => {
      const sessionChanged = db.prepare("UPDATE forge_task_sessions SET pane_id = NULL, agent_name = NULL, native_session_id = NULL, lifecycle = 'reserved', launch_owner = NULL, launch_owner_pid = NULL, launch_claimed_at = NULL, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle = 'stopped'").run(now(), input.sessionId, input.generation).changes;
      if (sessionChanged !== 1) return 0;
      return db.prepare("UPDATE forge_task_turns SET status = 'pending_prompt', terminal_observation = NULL, prompt_observed_at = NULL, updated_at = ? WHERE session_id = ? AND generation = ? AND status = 'unknown'").run(now(), input.sessionId, input.generation).changes;
    });
    if (changed !== 1) throw new Error("stale_turn");
    return this.byId(input.sessionId);
  }
  observeSession(input: { sessionId: string; generation: number; lifecycle: "live" | "stopped" | "unknown"; terminalObservation?: string }): TaskSession {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET lifecycle = ?, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1").run(input.lifecycle, now(), input.sessionId, input.generation).changes);
    if (changed !== 1) throw new Error("stale_generation");
    if (input.terminalObservation) this.database.authTransaction((db) => db.prepare("UPDATE forge_task_turns SET terminal_observation = ?, updated_at = ? WHERE session_id = ? AND generation = ? AND status IN ('pending_prompt', 'prompted', 'unknown')").run(input.terminalObservation, now(), input.sessionId, input.generation));
    return this.byId(input.sessionId);
  }
  wakeRoot(input: { taskId: string; rootSessionId: string; generation: number; prompt: string }): TaskTurn {
    this.assertCurrentRoot({ taskId: input.taskId, sessionId: input.rootSessionId, generation: input.generation });
    const time = now(); const id = randomUUID(); const promptHash = hash(input.prompt);
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(id, input.taskId, input.rootSessionId, input.generation, promptHash, input.prompt, time, time));
    return this.turnById(id);
  }
  markPrompted(input: { turnId: string; generation: number }): void { if (this.database.authTransaction((db) => db.prepare("UPDATE forge_task_turns SET status = 'prompted', prompted_at = ?, updated_at = ? WHERE id = ? AND generation = ? AND status IN ('pending_prompt', 'unknown') AND EXISTS (SELECT 1 FROM forge_task_sessions session WHERE session.id = forge_task_turns.session_id AND session.is_current = 1 AND session.generation = forge_task_turns.generation)").run(now(), now(), input.turnId, input.generation).changes) !== 1) throw new Error("stale_turn"); }
  markPromptUnknown(turnId: string): void { this.database.authTransaction((db) => db.prepare("UPDATE forge_task_turns SET status = 'unknown', updated_at = ? WHERE id = ? AND status = 'pending_prompt'").run(now(), turnId)); }
  pendingTurns(sessionId: string): TaskTurn[] { return this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_task_turns WHERE session_id = ? AND status IN ('pending_prompt', 'unknown') ORDER BY created_at").all(sessionId) as Row[]).map(turn)); }
  workerReceiptState(input: { taskId: string; sessionId: string; generation: number; receiptId: string }): "new" | "duplicate" {
    return this.database.authQuery((db) => { const row = db.prepare("SELECT status, result_receipt_id FROM forge_task_turns WHERE task_id = ? AND session_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.sessionId, input.generation) as Row | undefined; if (!row || TaskTurnStatusSchema.parse(text(row, "status")) === "cancelled") throw new Error("stale_generation"); return TaskTurnStatusSchema.parse(text(row, "status")) === "completed" && text(row, "result_receipt_id") === input.receiptId ? "duplicate" : "new"; });
  }
  recordWorkerResultAndWake(input: { taskId: string; sessionId: string; generation: number; receiptId: string; observation: string; nativeTurnId?: string }): { kind: "recorded"; wake: TaskTurn } | { kind: "duplicate" } {
    return this.database.authTransaction((db) => {
      const workerTurn = db.prepare("SELECT * FROM forge_task_turns WHERE task_id = ? AND session_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.sessionId, input.generation) as Row | undefined;
      const worker = db.prepare("SELECT id FROM forge_task_sessions WHERE id = ? AND kind = 'worker' AND is_current = 1 AND generation = ? AND lifecycle <> 'cancelled'").get(input.sessionId, input.generation);
      if (!workerTurn || !worker || TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "cancelled") throw new Error("stale_generation");
      if (TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "completed") { if (text(workerTurn, "result_receipt_id") === input.receiptId) return { kind: "duplicate" }; throw new Error("stale_receipt"); }
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND is_current = 1").get(input.taskId) as Row | undefined;
      if (!root) throw new Error("root_notification_unavailable");
      const time = now(); const wakeId = randomUUID(); const promptText = `Worker result receipt ${input.receiptId}. Observe the task and continue the objective.\n\n${input.observation}`; const promptHash = hash(promptText);
      db.prepare("UPDATE forge_task_turns SET status = 'completed', result_receipt_id = ?, terminal_observation = ?, native_turn_id = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(input.receiptId, input.observation, input.nativeTurnId ?? null, time, time, text(workerTurn, "id"));
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(wakeId, input.taskId, text(root, "id"), integer(root, "generation"), promptHash, promptText, time, time);
      db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(time, time, input.taskId);
      return { kind: "recorded", wake: turn(db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(wakeId) as Row) };
    });
  }
  recordWorkerInterruptionAndWake(input: { taskId: string; sessionId: string; generation: number; observation: string }): { kind: "recorded"; wake: TaskTurn } | { kind: "duplicate" } {
    return this.database.authTransaction((db) => {
      const workerTurn = db.prepare("SELECT * FROM forge_task_turns WHERE task_id = ? AND session_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.sessionId, input.generation) as Row | undefined;
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND is_current = 1").get(input.taskId) as Row | undefined;
      if (!workerTurn || !root || TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "cancelled") throw new Error("stale_generation");
      if (text(workerTurn, "terminal_observation")) return { kind: "duplicate" };
      const time = now(); const wakeId = randomUUID(); const promptText = `Worker interruption. Preserve the existing worktree diff, observe the task, and delegate one continuation if needed.\n\n${input.observation}`; const promptHash = hash(promptText);
      db.prepare("UPDATE forge_task_turns SET terminal_observation = ?, updated_at = ? WHERE id = ? AND terminal_observation IS NULL").run(input.observation, time, text(workerTurn, "id"));
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(wakeId, input.taskId, text(root, "id"), integer(root, "generation"), promptHash, promptText, time, time);
      return { kind: "recorded", wake: turn(db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(wakeId) as Row) };
    });
  }
  recordWorkerTurn(input: { taskId: string; sessionId: string; generation: number; receiptId: string; terminalObservation: string }): "recorded" | "duplicate" { return this.database.authTransaction((db) => { const existing = db.prepare("SELECT * FROM forge_task_turns WHERE session_id = ? AND task_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(input.sessionId, input.taskId, input.generation) as Row | undefined; const current = db.prepare("SELECT id FROM forge_task_sessions WHERE id = ? AND is_current = 1 AND generation = ? AND lifecycle <> 'cancelled'").get(input.sessionId, input.generation); if (!existing || !current || TaskTurnStatusSchema.parse(text(existing, "status")) === "cancelled") throw new Error("stale_generation"); if (TaskTurnStatusSchema.parse(text(existing, "status")) === "completed") { if (text(existing, "result_receipt_id") === input.receiptId) return "duplicate"; throw new Error("stale_receipt"); } const changed = db.prepare("UPDATE forge_task_turns SET status = 'completed', result_receipt_id = ?, terminal_observation = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(input.receiptId, input.terminalObservation, now(), now(), text(existing, "id")).changes; if (changed !== 1) throw new Error("stale_generation"); return "recorded"; }); }
  scheduleWake(taskId: string, wakeAt: string | null): void { this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(wakeAt, now(), taskId)); }
  askHuman(taskId: string, question: string): void { this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET status = 'waiting_human', human_question = ?, wake_at = NULL, updated_at = ? WHERE task_id = ?").run(question, now(), taskId)); }
  cancel(taskId: string): void { this.database.authTransaction((db) => { db.prepare("UPDATE forge_task_controls SET status = 'cancelled', wake_at = NULL, updated_at = ? WHERE task_id = ?").run(now(), taskId); db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'cancelled', updated_at = ? WHERE task_id = ? AND is_current = 1").run(now(), taskId); db.prepare("UPDATE forge_task_turns SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status IN ('pending_prompt', 'prompted', 'unknown')").run(now(), taskId); }); }
  assertCurrentRoot(input: { taskId: string; sessionId: string; generation: number }): void { const current = this.currentSession(input.taskId, "root"); const task = this.get(input.taskId); if (!current || task.status !== "active" || current.id !== input.sessionId || current.generation !== input.generation || !current.current || current.lifecycle === "cancelled") throw new Error("root_identity_mismatch"); }
  private byId(id: string): TaskSession { return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row | undefined; if (!row) throw new Error(`Task session ${id} does not exist`); return session(row); }); }
  private turnById(id: string): TaskTurn { return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(id) as Row | undefined; if (!row) throw new Error(`Task turn ${id} does not exist`); return turn(row); }); }
}

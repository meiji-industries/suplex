import { createHash, randomUUID } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import { createOpenCodeMessageID } from "./opencode-session.js";
import type { PullRequestReference } from "./task-control.js";
import { DeliveryIntentSchema, PullRequestReferenceSchema, TaskControlStatusSchema, TaskProfileSchema, TaskSessionKindSchema, TaskSessionLifecycleSchema, TaskTurnStatusSchema, WorktreeReferenceSchema, type DeliveryIntent, type TaskControl, type TaskProfile, type TaskSession, type TaskSessionKind, type TaskTurn, type WorktreeReference } from "./task-control.js";

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
  const rootProfile = parseJson(text(row, "root_profile_json"), TaskProfileSchema); const workerProfile = parseJson(text(row, "worker_profile_json"), TaskProfileSchema); const deliveryIntent = parseJson(text(row, "delivery_intent_json"), DeliveryIntentSchema);
  if (!rootProfile || !workerProfile || !deliveryIntent) throw new Error("Task control configuration is missing");
  return { taskId, objective, deliveryTarget, deliveryIntent, status, wakeAt: text(row, "wake_at"), humanQuestion: text(row, "human_question"), humanQuestionId: text(row, "human_question_id"), worktree: parseJson(text(row, "worktree_json"), WorktreeReferenceSchema), pullRequest: parseJson(text(row, "pull_request_json"), PullRequestReferenceSchema), rootSessionId: text(row, "root_session_id"), workerSessionId: text(row, "worker_session_id"), rootProfile, workerProfile };
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
  constructor(private readonly database: ForgeDatabase, private readonly processAlive: (pid: number) => boolean = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); } }) {}
  create(input: { taskId: string; startImmediately: boolean; objective: string; deliveryTarget: string; deliveryIntent: DeliveryIntent; rootProfile: TaskProfile; workerProfile: TaskProfile; worktree?: WorktreeReference }): TaskControl {
    const time = now();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_controls (task_id, objective, delivery_target, delivery_intent_json, status, wake_at, human_question, worktree_json, pull_request_json, root_session_id, worker_session_id, root_profile_json, worker_profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?)").run(input.taskId, input.objective, input.deliveryTarget, JSON.stringify(DeliveryIntentSchema.parse(input.deliveryIntent)), input.startImmediately ? "active" : "backlog", input.worktree ? JSON.stringify(input.worktree) : null, JSON.stringify(TaskProfileSchema.parse(input.rootProfile)), JSON.stringify(TaskProfileSchema.parse(input.workerProfile)), time, time));
    return this.get(input.taskId);
  }
  start(taskId: string): TaskControl {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET status = 'active', wake_at = ?, updated_at = ? WHERE task_id = ? AND status IN ('backlog', 'active')").run(now(), now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_startable");
    return this.get(taskId);
  }
  answerHuman(taskId: string, questionId: string, answer: string): TaskControl {
    if (!answer.trim()) throw new Error("answer_is_empty");
    this.database.authTransaction((db) => {
      const row = db.prepare("SELECT * FROM forge_task_controls WHERE task_id = ? AND status = 'waiting_human' AND human_question_id = ?").get(taskId, questionId) as Row | undefined;
      if (!row) throw new Error("question_identity_mismatch");
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND is_current = 1 AND lifecycle <> 'cancelled'").get(taskId) as Row | undefined;
      if (!root) throw new Error("root_notification_unavailable");
      const time = now();
      const prompt = JSON.stringify({ question: text(row, "human_question"), answer: answer.trim() });
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?)").run(createOpenCodeMessageID(), taskId, text(root, "id"), integer(root, "generation"), hash(prompt), prompt, time, time);
      db.prepare("UPDATE forge_task_controls SET status = 'active', human_question = NULL, human_question_id = NULL, wake_at = ?, updated_at = ? WHERE task_id = ?").run(time, time, taskId);
    });
    return this.get(taskId);
  }
  setWorktree(taskId: string, worktree: WorktreeReference): TaskControl {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET worktree_json = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(JSON.stringify(WorktreeReferenceSchema.parse(worktree)), now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_active");
    return this.get(taskId);
  }
  setPullRequest(taskId: string, pullRequest: PullRequestReference): TaskControl {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET pull_request_json = ?, updated_at = ? WHERE task_id = ? AND status IN ('active', 'waiting_human', 'delivered')").run(JSON.stringify(PullRequestReferenceSchema.parse(pullRequest)), now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_active");
    return this.get(taskId);
  }
  markDelivered(taskId: string): TaskControl {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET status = 'delivered', wake_at = NULL, human_question = NULL, human_question_id = NULL, updated_at = ? WHERE task_id = ? AND status IN ('active', 'waiting_human', 'delivered')").run(now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_active");
    return this.get(taskId);
  }
  get(taskId: string): TaskControl {
    return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_controls WHERE task_id = ?").get(taskId) as Row | undefined; if (!row) throw new Error(`Task control ${taskId} does not exist`); return control(row); });
  }
  currentSession(taskId: string, kind: TaskSessionKind): TaskSession | null {
    return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = ? AND is_current = 1").get(taskId, kind) as Row | undefined; return row ? session(row) : null; });
  }
  claimSessionOperation(input: { sessionId: string; generation: number }): string | null {
    const current = this.byId(input.sessionId);
    if (current.launchOwnerPid && this.processAlive(current.launchOwnerPid)) return null;
    const owner = randomUUID();
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET launch_owner = ?, launch_owner_pid = ?, launch_claimed_at = ?, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle <> 'cancelled' AND launch_owner IS ?").run(owner, process.pid, now(), now(), input.sessionId, input.generation, current.launchOwner).changes);
    return changed === 1 ? owner : null;
  }
  releaseSessionOperation(sessionId: string, owner: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET launch_owner = NULL, launch_owner_pid = NULL, launch_claimed_at = NULL WHERE id = ? AND launch_owner = ?").run(sessionId, owner));
  }
  bindHarnessSession(input: { sessionId: string; generation: number; nativeSessionId: string }): TaskSession {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET native_session_id = ?, lifecycle = 'live', updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle <> 'cancelled' AND (native_session_id IS NULL OR native_session_id = ?)").run(input.nativeSessionId, now(), input.sessionId, input.generation, input.nativeSessionId).changes);
    if (changed !== 1) throw new Error("stale_generation");
    return this.byId(input.sessionId);
  }
  bindPane(input: { sessionId: string; generation: number; paneId: string }): void {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET pane_id = ?, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle <> 'cancelled'").run(input.paneId, now(), input.sessionId, input.generation).changes);
    if (changed !== 1) throw new Error("stale_generation");
  }
  hasTurns(sessionId: string): boolean {
    return this.database.authQuery((db) => Boolean(db.prepare("SELECT 1 FROM forge_task_turns WHERE session_id = ? LIMIT 1").get(sessionId)));
  }
  pendingStops(taskId: string): TaskSession[] {
    const sessions = this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND lifecycle = 'cancelled'").all(taskId) as Row[]).map(session));
    return sessions.filter((session) => !session.launchOwnerPid || !this.processAlive(session.launchOwnerPid));
  }
  completeStop(sessionId: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET lifecycle = 'stopped', updated_at = ? WHERE id = ? AND lifecycle = 'cancelled' AND is_current = 0").run(now(), sessionId));
  }
  wakeIdleRoot(taskId: string): void {
    const time = now();
    const prompt = "Observe the current task, worktree, and GitHub state and continue toward the delivery target. Adopt out-of-band progress. If checks or another external operation are pending, report what you are waiting for. Ask a specific human question only if a necessary decision or external failure requires it.";
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) SELECT ?, c.task_id, s.id, s.generation, ?, ?, 'pending_prompt', ?, ? FROM forge_task_controls c JOIN forge_task_sessions s ON s.id = c.root_session_id WHERE c.task_id = ? AND c.status = 'active' AND s.is_current = 1 AND s.lifecycle = 'live' AND s.native_session_id IS NOT NULL AND s.launch_owner IS NULL AND NOT EXISTS (SELECT 1 FROM forge_task_turns t WHERE t.session_id = s.id AND t.status IN ('pending_prompt', 'prompted', 'unknown')) AND NOT EXISTS (SELECT 1 FROM forge_task_sessions w WHERE w.task_id = c.task_id AND w.kind = 'worker' AND w.is_current = 1 AND w.lifecycle IN ('reserved', 'live', 'unknown'))").run(createOpenCodeMessageID(), hash(prompt), prompt, time, time, taskId));
  }
  claimPrompt(turnId: string): boolean {
    return this.database.authTransaction((db) => db.prepare("UPDATE forge_task_turns SET status = 'unknown', updated_at = ? WHERE id = ? AND status = 'pending_prompt' AND EXISTS (SELECT 1 FROM forge_task_sessions s JOIN forge_task_controls c ON c.task_id = s.task_id WHERE s.id = forge_task_turns.session_id AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')").run(now(), turnId).changes === 1);
  }
  completeRootTurn(turnId: string, observation: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_task_turns SET status = 'completed', terminal_observation = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending_prompt', 'unknown', 'prompted')").run(observation, now(), now(), turnId));
  }
  claimRoot(input: { taskId: string }): TaskSession {
    return this.claim(input.taskId);
  }
  launchWorker(input: { taskId: string; rootSessionId: string; rootGeneration: number; instruction: string }): TaskSession {
    const assignmentHash = hash(input.instruction); const time = now(); const id = randomUUID();
    const promptText = `You are the scoped Worker for this Forge task. Execute the edits and verification yourself. Do not delegate or launch subagents. Do not push, create or merge pull requests, or run GitHub mutations. Preserve existing work. Report the files changed, verification results, and any blocker to Root.\n\nAssignment:\n${input.instruction}`;
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
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(createOpenCodeMessageID(), input.taskId, id, generation, assignmentHash, hash(promptText), promptText, time, time);
      return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
    });
  }
  private claim(taskId: string): TaskSession {
    const time = now(); const id = randomUUID();
    return this.database.authTransaction((db) => {
      const task = db.prepare("SELECT status FROM forge_task_controls WHERE task_id = ?").get(taskId) as Row | undefined;
      if (!task || TaskControlStatusSchema.parse(text(task, "status")) !== "active") throw new Error("task_not_active");
      const existing = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND is_current = 1").get(taskId) as Row | undefined;
      if (existing) return session(existing);
      const latest = db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM forge_task_sessions WHERE task_id = ? AND kind = 'root'").get(taskId) as Row;
      const generation = integer(latest, "generation") + 1;
      db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, pane_id, agent_name, native_session_id, lifecycle, assignment_hash, prompt_hash, result_receipt_id, created_at, updated_at) VALUES (?, ?, 'root', ?, 1, NULL, NULL, NULL, 'reserved', NULL, NULL, NULL, ?, ?)").run(id, taskId, generation, time, time);
      db.prepare("UPDATE forge_task_controls SET root_session_id = ?, updated_at = ? WHERE task_id = ?").run(id, time, taskId);
      return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
    });
  }
  wakeRoot(input: { taskId: string; rootSessionId: string; generation: number; prompt: string }): TaskTurn {
    this.assertCurrentRoot({ taskId: input.taskId, sessionId: input.rootSessionId, generation: input.generation });
    const time = now(); const id = createOpenCodeMessageID(); const promptHash = hash(input.prompt);
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(id, input.taskId, input.rootSessionId, input.generation, promptHash, input.prompt, time, time));
    return this.turnById(id);
  }
  markPrompted(input: { turnId: string; generation: number }): void { if (this.database.authTransaction((db) => db.prepare("UPDATE forge_task_turns SET status = 'prompted', prompted_at = ?, updated_at = ? WHERE id = ? AND generation = ? AND status IN ('pending_prompt', 'unknown') AND EXISTS (SELECT 1 FROM forge_task_sessions session WHERE session.id = forge_task_turns.session_id AND session.is_current = 1 AND session.generation = forge_task_turns.generation)").run(now(), now(), input.turnId, input.generation).changes) !== 1) throw new Error("stale_turn"); }
  pendingTurns(sessionId: string): TaskTurn[] { return this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_task_turns WHERE session_id = ? AND status IN ('pending_prompt', 'unknown', 'prompted') ORDER BY created_at, id").all(sessionId) as Row[]).map(turn)); }
  recordWorkerResultAndWake(input: { taskId: string; sessionId: string; generation: number; receiptId: string; observation: string; nativeTurnId?: string }): { kind: "recorded"; wake: TaskTurn } | { kind: "duplicate" } {
    return this.database.authTransaction((db) => {
      const workerTurn = db.prepare("SELECT * FROM forge_task_turns WHERE task_id = ? AND session_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.sessionId, input.generation) as Row | undefined;
      const worker = db.prepare("SELECT id FROM forge_task_sessions WHERE id = ? AND kind = 'worker' AND is_current = 1 AND generation = ? AND lifecycle <> 'cancelled'").get(input.sessionId, input.generation);
      if (!workerTurn || !worker || TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "cancelled") throw new Error("stale_generation");
      if (TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "completed") { if (text(workerTurn, "result_receipt_id") === input.receiptId) return { kind: "duplicate" }; throw new Error("stale_receipt"); }
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND is_current = 1").get(input.taskId) as Row | undefined;
      if (!root) throw new Error("root_notification_unavailable");
      const time = now(); const wakeId = createOpenCodeMessageID(); const promptText = `Worker result receipt ${input.receiptId}. Observe the task and continue the objective.\n\n${input.observation}`; const promptHash = hash(promptText);
      db.prepare("UPDATE forge_task_turns SET status = 'completed', result_receipt_id = ?, terminal_observation = ?, native_turn_id = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(input.receiptId, input.observation, input.nativeTurnId ?? null, time, time, text(workerTurn, "id"));
      db.prepare("UPDATE forge_task_sessions SET lifecycle = 'stopped', updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1").run(time, input.sessionId, input.generation);
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(wakeId, input.taskId, text(root, "id"), integer(root, "generation"), promptHash, promptText, time, time);
      db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(time, time, input.taskId);
      return { kind: "recorded", wake: turn(db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(wakeId) as Row) };
    });
  }
  scheduleWake(taskId: string, wakeAt: string | null): void { this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(wakeAt, now(), taskId)); }
  askHuman(taskId: string, question: string): void {
    if (!question.trim()) throw new Error("question_is_empty");
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET status = 'waiting_human', human_question = ?, human_question_id = ?, wake_at = NULL, updated_at = ? WHERE task_id = ? AND status = 'active'").run(question.trim(), randomUUID(), now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_active");
  }
  cancel(taskId: string): void {
    this.database.authTransaction((db) => {
      const changed = db.prepare("UPDATE forge_task_controls SET status = 'cancelled', wake_at = NULL, human_question = NULL, human_question_id = NULL, updated_at = ? WHERE task_id = ? AND status <> 'delivered'").run(now(), taskId).changes;
      if (changed !== 1) throw new Error("task_not_cancellable");
      db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'cancelled', updated_at = ? WHERE task_id = ? AND is_current = 1").run(now(), taskId);
      db.prepare("UPDATE forge_task_turns SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status IN ('pending_prompt', 'prompted', 'unknown')").run(now(), taskId);
    });
  }
  assertCurrentRoot(input: { taskId: string; sessionId: string; generation: number }): void { const current = this.currentSession(input.taskId, "root"); const task = this.get(input.taskId); if (!current || task.status !== "active" || current.id !== input.sessionId || current.generation !== input.generation || !current.current || current.lifecycle === "cancelled") throw new Error("root_identity_mismatch"); }
  private byId(id: string): TaskSession { return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row | undefined; if (!row) throw new Error(`Task session ${id} does not exist`); return session(row); }); }
  private turnById(id: string): TaskTurn { return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(id) as Row | undefined; if (!row) throw new Error(`Task turn ${id} does not exist`); return turn(row); }); }
}

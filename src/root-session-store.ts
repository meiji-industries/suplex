import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { HumanQuestionOptionsSchema, type HumanQuestionOptions } from "./human-question.js";
import { inspectProcessOnce } from "./process-manager.js";
import { TaskAnalyticsStore } from "./task-analytics-store.js";
import { StructuredLogger } from "./logging.js";

import type Database from "better-sqlite3";
import type { ForgeDatabase } from "./database.js";
import { createOpenCodeMessageID } from "./opencode-session.js";
import { TaskConfigurationSchema } from "./task-contracts.js";
import { PromptDispatchAttemptSchema, type PromptDispatchAttempt, type PullRequestReference } from "./task-control.js";
import { DeliveryIntentSchema, PullRequestReferenceSchema, TaskControlStatusSchema, TaskProfileSchema, TaskSessionKindSchema, TaskSessionLifecycleSchema, TaskTurnStatusSchema, WorktreeReferenceSchema, type DeliveryIntent, type TaskControl, type TaskProfile, type TaskSession, type TaskSessionKind, type TaskTurn, type WorktreeReference } from "./task-control.js";
import { AdvisorRoleSchema, WorkflowIdSchema, WorkflowInputSchema, WorkflowStateSchema, deliveryDecision, emptyWorkflowState, sameRange, type AdvisorRole, type DeliveryFailureCode, type DeliveryWait, type RaterResult, type ReviewRange, type ReviewerResult, type WorkflowCompletion, type WorkflowId, type WorkflowInput, type WorkflowState } from "./workflows.js";
import { STANDARD_WORKER_RESULT_WAKE, workerAssignmentPreamble } from "./workflow-prompts.js";

const now = (): string => new Date().toISOString();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown>;

export type ProcessOwnerObservation = { kind: "running"; startTime: string } | { kind: "absent" } | { kind: "unknown" };
export type WorkflowCompletionResult = { kind: "completed" } | { kind: "already" } | { kind: "cancelled" } | { kind: "declined"; code: DeliveryFailureCode; reason: string };

async function observeProcessOwner(pid: number): Promise<ProcessOwnerObservation> {
  const inspection = await inspectProcessOnce(pid);
  if (inspection) return { kind: "running", startTime: inspection.startTime };
  try { process.kill(pid, 0); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return { kind: "absent" };
  }
  return { kind: "unknown" };
}

function text(row: Row, key: string): string | null { const value = row[key]; return typeof value === "string" ? value : null; }
function integer(row: Row, key: string): number { const value = row[key]; if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Invalid persisted ${key}`); return value; }
function parseJson<T>(value: string | null, schema: { parse(input: unknown): T }): T | null { return value === null ? null : schema.parse(JSON.parse(value)); }
function control(row: Row): TaskControl {
  const status = TaskControlStatusSchema.parse(text(row, "status"));
  const taskId = text(row, "task_id"); const objective = text(row, "objective"); const deliveryTarget = text(row, "delivery_target");
  if (!taskId || !objective || !deliveryTarget) throw new Error("Invalid persisted task control");
  const rootProfile = parseJson(text(row, "root_profile_json"), TaskProfileSchema); const workerProfile = parseJson(text(row, "worker_profile_json"), TaskProfileSchema); const deliveryIntent = parseJson(text(row, "delivery_intent_json"), DeliveryIntentSchema);
  if (!rootProfile || !workerProfile || !deliveryIntent) throw new Error("Task control configuration is missing");
  const workflow = WorkflowIdSchema.parse(text(row, "workflow") ?? "standard");
  const advisorProfiles = z.partialRecord(AdvisorRoleSchema, TaskProfileSchema).parse(JSON.parse(text(row, "advisor_profiles_json") ?? "{}"));
  const workflowState = parseJson(text(row, "workflow_state_json"), WorkflowStateSchema) ?? emptyWorkflowState();
  return { workflow, advisorProfiles, workflowState, humanQuestionOptions: HumanQuestionOptionsSchema.parse(JSON.parse(text(row, "human_question_options_json") ?? "[]")), taskId, objective, deliveryTarget, deliveryIntent, status, wakeAt: text(row, "wake_at"), humanQuestion: text(row, "human_question"), humanQuestionId: text(row, "human_question_id"), recoveryTurnId: text(row, "recovery_turn_id"), worktree: parseJson(text(row, "worktree_json"), WorktreeReferenceSchema), pullRequest: parseJson(text(row, "pull_request_json"), PullRequestReferenceSchema), rootSessionId: text(row, "root_session_id"), workerSessionId: text(row, "worker_session_id"), rootProfile, workerProfile };
}
function session(row: Row): TaskSession {
  const id = text(row, "id"); const taskId = text(row, "task_id");
  if (!id || !taskId) throw new Error("Invalid persisted task session");
  const launchOwnerPid = row.launch_owner_pid === null || row.launch_owner_pid === undefined ? null : integer(row, "launch_owner_pid");
  return { id, taskId, kind: TaskSessionKindSchema.parse(text(row, "kind")), generation: integer(row, "generation"), current: integer(row, "is_current") === 1, paneId: text(row, "pane_id"), nativeSessionId: text(row, "native_session_id"), lifecycle: TaskSessionLifecycleSchema.parse(text(row, "lifecycle")), assignmentHash: text(row, "assignment_hash"), launchOwner: text(row, "launch_owner"), launchOwnerPid, launchOwnerStartTime: text(row, "launch_owner_start_time"), stopRequestedAt: text(row, "stop_requested_at"), stoppedAt: text(row, "stopped_at"), advisorRole: text(row, "advisor_role") === null ? null : AdvisorRoleSchema.parse(text(row, "advisor_role")), workflowInput: parseJson(text(row, "workflow_input_json"), WorkflowInputSchema) };
}
function turn(row: Row): TaskTurn {
  const id = text(row, "id"); const taskId = text(row, "task_id"); const sessionId = text(row, "session_id"); const promptHash = text(row, "prompt_hash"); const promptText = text(row, "prompt_text");
  if (!id || !taskId || !sessionId || !promptHash || promptText === null) throw new Error("Invalid persisted task turn");
  return { id, taskId, sessionId, generation: integer(row, "generation"), assignmentHash: text(row, "assignment_hash"), promptHash, promptText, status: TaskTurnStatusSchema.parse(text(row, "status")), resultReceiptId: text(row, "result_receipt_id"), terminalObservation: text(row, "terminal_observation"), nativeTurnId: text(row, "native_turn_id"), dispatchAttempt: parseJson(text(row, "dispatch_attempt_json"), PromptDispatchAttemptSchema), workflowInput: parseJson(text(row, "workflow_input_json"), WorkflowInputSchema) };
}

export class TaskControlStore {
  constructor(private readonly database: ForgeDatabase, private readonly inspectOwner: (pid: number) => Promise<ProcessOwnerObservation> = observeProcessOwner) {}
  create(input: { taskId: string; startImmediately: boolean; objective: string; deliveryTarget: string; deliveryIntent: DeliveryIntent; rootProfile: TaskProfile; workerProfile: TaskProfile; worktree?: WorktreeReference; workflow?: WorkflowId; advisorProfiles?: Partial<Record<AdvisorRole, TaskProfile>> }): TaskControl {
    const time = now();
    const advisorProfiles = Object.fromEntries(Object.entries(input.advisorProfiles ?? {}).map(([role, profile]) => [AdvisorRoleSchema.parse(role), TaskProfileSchema.parse(profile)]));
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_controls (task_id, objective, delivery_target, delivery_intent_json, status, wake_at, human_question, worktree_json, pull_request_json, root_session_id, worker_session_id, root_profile_json, worker_profile_json, workflow, advisor_profiles_json, workflow_state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)").run(input.taskId, input.objective, input.deliveryTarget, JSON.stringify(DeliveryIntentSchema.parse(input.deliveryIntent)), input.startImmediately ? "active" : "backlog", input.worktree ? JSON.stringify(input.worktree) : null, JSON.stringify(TaskProfileSchema.parse(input.rootProfile)), JSON.stringify(TaskProfileSchema.parse(input.workerProfile)), WorkflowIdSchema.parse(input.workflow ?? "standard"), JSON.stringify(advisorProfiles), JSON.stringify(emptyWorkflowState()), time, time));
    return this.observeLifecycle(input.taskId);
  }
  start(taskId: string): TaskControl {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET status = 'active', wake_at = ?, updated_at = ? WHERE task_id = ? AND status IN ('backlog', 'active')").run(now(), now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_startable");
    return this.observeLifecycle(taskId);
  }
  answerHuman(taskId: string, questionId: string, answer: string, confirmCommandsStopped = false): TaskControl {
    if (!answer.trim()) throw new Error("answer_is_empty");
    this.database.authTransaction((db) => {
      const row = db.prepare("SELECT * FROM forge_task_controls WHERE task_id = ? AND status = 'waiting_human' AND human_question_id = ?").get(taskId, questionId) as Row | undefined;
      if (!row) throw new Error("question_identity_mismatch");
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND is_current = 1 AND lifecycle <> 'cancelled'").get(taskId) as Row | undefined;
      if (!root) throw new Error("root_notification_unavailable");
      const recoveryTurnId = text(row, "recovery_turn_id");
      if (recoveryTurnId && !confirmCommandsStopped) throw new Error("command_cleanup_confirmation_required");
      const time = now();
      if (recoveryTurnId) {
        const recovered = this.turnById(recoveryTurnId);
        const evidence = JSON.stringify({ state: "interrupted", reason: "operator_confirmed_commands_stopped", questionId, answer: answer.trim(), turnId: recovered.id });
        const recoveringSession = this.byId(recovered.sessionId);
        if (recoveringSession.kind === "worker") this.recordWorkerResultAndWake({ taskId, sessionId: recovered.sessionId, generation: recovered.generation, receiptId: `cleanup:${questionId}`, observation: evidence });
        else this.completeRootTurn(recovered.id, evidence);
      }
      const prompt = JSON.stringify({ question: text(row, "human_question"), answer: answer.trim() });
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?)").run(createOpenCodeMessageID(), taskId, text(root, "id"), integer(root, "generation"), hash(prompt), prompt, time, time);
      db.prepare("UPDATE forge_task_controls SET status = 'active', human_question = NULL, human_question_id = NULL, recovery_turn_id = NULL, wake_at = ?, updated_at = ? WHERE task_id = ?").run(time, time, taskId);
    });
    return this.observeLifecycle(taskId);
  }
  setWorktree(taskId: string, worktree: WorktreeReference): TaskControl {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET worktree_json = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(JSON.stringify(WorktreeReferenceSchema.parse(worktree)), now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_active");
    return this.get(taskId);
  }
  setPullRequest(taskId: string, pullRequest: PullRequestReference | null): TaskControl {
    // A cancelled task still records what GitHub reports; it never resumes because of it.
    const value = pullRequest === null ? null : JSON.stringify(PullRequestReferenceSchema.parse(pullRequest));
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET pull_request_json = ?, updated_at = ? WHERE task_id = ? AND status IN ('active', 'waiting_human', 'delivered', 'cancelled')").run(value, now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_active");
    return this.get(taskId);
  }
  markDelivered(taskId: string): TaskControl {
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET status = 'delivered', wake_at = NULL, human_question = NULL, human_question_id = NULL, updated_at = ? WHERE task_id = ? AND status IN ('active', 'waiting_human', 'delivered')").run(now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_active");
    return this.observeLifecycle(taskId);
  }
  get(taskId: string): TaskControl {
    return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_controls WHERE task_id = ?").get(taskId) as Row | undefined; if (!row) throw new Error(`Task control ${taskId} does not exist`); return control(row); });
  }
  context(taskId: string) {
    return this.database.authQuery(db => {
      const row = db.prepare("SELECT configuration_json FROM forge_tasks WHERE id = ?").get(taskId) as Row | undefined;
      const configuration = row ? text(row, "configuration_json") : null;
      if (!configuration) throw new Error("Task configuration is missing");
      const images = db.prepare("SELECT id AS artifactId, filename FROM forge_artifacts WHERE task_id = ? AND kind = 'task-image' ORDER BY created_at, id").all(taskId);
      return { configuration: TaskConfigurationSchema.parse(JSON.parse(configuration)), images };
    });
  }
  image(taskId: string, artifactId: string) {
    return this.database.authQuery(db => {
      const row = db.prepare("SELECT a.filename, a.mime_type AS mimeType, a.company_id AS companyId, a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a JOIN forge_tasks t ON t.id = a.task_id AND t.company_id = a.company_id WHERE t.id = ? AND a.id = ? AND a.kind = 'task-image'").get(taskId, artifactId);
      return z.object({ filename: z.string(), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), companyId: z.string(), storagePath: z.string(), sha256: z.string() }).parse(row);
    });
  }
  currentSession(taskId: string, kind: TaskSessionKind): TaskSession | null {
    return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = ? AND is_current = 1").get(taskId, kind) as Row | undefined; return row ? session(row) : null; });
  }
  sessions(taskId: string): TaskSession[] {
    return this.database.authQuery(db => (db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? ORDER BY created_at, id").all(taskId) as Row[]).map(session));
  }
  turns(taskId: string): TaskTurn[] {
    return this.database.authQuery(db => (db.prepare("SELECT * FROM forge_task_turns WHERE task_id = ? ORDER BY created_at, id").all(taskId) as Row[]).map(turn));
  }
  async claimSessionOperation(input: { sessionId: string; generation: number }): Promise<string | null> {
    const current = this.byId(input.sessionId);
    if (current.launchOwnerPid !== null) {
      const previous = await this.inspectOwner(current.launchOwnerPid);
      if (previous.kind === "unknown") return null;
      if (previous.kind === "running" && (current.launchOwnerStartTime === null || previous.startTime === current.launchOwnerStartTime)) return null;
    }
    const self = await this.inspectOwner(process.pid);
    if (self.kind !== "running") return null;
    const owner = randomUUID();
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET launch_owner = ?, launch_owner_pid = ?, launch_owner_start_time = ?, launch_claimed_at = ?, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1 AND lifecycle <> 'cancelled' AND launch_owner IS ?").run(owner, process.pid, self.startTime, now(), now(), input.sessionId, input.generation, current.launchOwner).changes);
    return changed === 1 ? owner : null;
  }
  releaseSessionOperation(sessionId: string, owner: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL WHERE id = ? AND launch_owner = ?").run(sessionId, owner));
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
  ensureInitialPrompt(root: TaskSession, prompt: string): void {
    this.database.authTransaction(() => {
      if (!this.hasTurns(root.id)) this.wakeRoot({ taskId: root.taskId, rootSessionId: root.id, generation: root.generation, prompt });
    });
  }
  retireDeliveredSessions(taskId: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'stopped', stop_requested_at = COALESCE(stop_requested_at, ?), updated_at = ? WHERE task_id = ? AND stopped_at IS NULL AND EXISTS (SELECT 1 FROM forge_task_controls c WHERE c.task_id = forge_task_sessions.task_id AND c.status = 'delivered')").run(now(), now(), taskId));
  }
  async pendingStops(taskId: string): Promise<TaskSession[]> {
    const sessions = this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND stop_requested_at IS NOT NULL AND stopped_at IS NULL").all(taskId) as Row[]).map(session));
    const stoppedOwners = await Promise.all(sessions.map(async session => {
      if (session.launchOwnerPid === null) return true;
      const owner = await this.inspectOwner(session.launchOwnerPid);
      return owner.kind === "absent" || owner.kind === "running" && session.launchOwnerStartTime !== null && owner.startTime !== session.launchOwnerStartTime;
    }));
    return sessions.filter((_, index) => stoppedOwners[index]);
  }
  completeStop(sessionId: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET stopped_at = ?, launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL, updated_at = ? WHERE id = ? AND stop_requested_at IS NOT NULL AND stopped_at IS NULL").run(now(), now(), sessionId));
  }
  wakeIdleRoot(taskId: string): void {
    const time = now();
    const prompt = "Observe the current task, worktree, and GitHub state and continue toward the delivery target. Adopt out-of-band progress. If checks or another external operation are pending, report what you are waiting for. Ask a specific human question only if a necessary decision or external failure requires it.";
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) SELECT ?, c.task_id, s.id, s.generation, ?, ?, 'pending_prompt', ?, ? FROM forge_task_controls c JOIN forge_task_sessions s ON s.id = c.root_session_id WHERE c.task_id = ? AND c.status = 'active' AND json_extract(c.workflow_state_json, '$.deliveryWait') IS NULL AND s.is_current = 1 AND s.lifecycle = 'live' AND s.native_session_id IS NOT NULL AND s.launch_owner IS NULL AND NOT EXISTS (SELECT 1 FROM forge_task_turns t WHERE t.session_id = s.id AND t.status IN ('pending_prompt', 'prompted', 'unknown')) AND NOT EXISTS (SELECT 1 FROM forge_task_sessions w JOIN forge_task_turns wt ON wt.session_id = w.id AND wt.generation = w.generation WHERE w.task_id = c.task_id AND w.kind = 'worker' AND w.is_current = 1 AND wt.status IN ('pending_prompt', 'prompted', 'unknown'))").run(createOpenCodeMessageID(), hash(prompt), prompt, time, time, taskId));
  }
  claimPrompt(turnId: string, serverGeneration: string, owner: string): boolean {
    const attempt = PromptDispatchAttemptSchema.parse({ serverGeneration, claimedAt: now() });
    return this.database.authTransaction((db) => db.prepare("UPDATE forge_task_turns SET status = 'unknown', dispatch_attempt_json = ?, updated_at = ? WHERE id = ? AND status = 'pending_prompt' AND EXISTS (SELECT 1 FROM forge_task_sessions s JOIN forge_task_controls c ON c.task_id = s.task_id WHERE s.id = forge_task_turns.session_id AND s.generation = forge_task_turns.generation AND s.launch_owner = ? AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')").run(JSON.stringify(attempt), attempt.claimedAt, turnId, owner).changes === 1);
  }
  requeueFencedPrompt(input: { turnId: string; attempt: PromptDispatchAttempt; owner: string }): boolean {
    return this.database.authTransaction(db => db.prepare("UPDATE forge_task_turns SET status = 'pending_prompt', dispatch_attempt_json = NULL, updated_at = ? WHERE id = ? AND status = 'unknown' AND dispatch_attempt_json = ? AND EXISTS (SELECT 1 FROM forge_task_sessions s JOIN forge_task_controls c ON c.task_id = s.task_id WHERE s.id = forge_task_turns.session_id AND s.generation = forge_task_turns.generation AND s.launch_owner = ? AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')").run(now(), input.turnId, JSON.stringify(input.attempt), input.owner).changes === 1);
  }
  completeRootTurn(turnId: string, observation: string, continuation?: string): void {
    this.database.authTransaction(db => {
      const completed = db.prepare("UPDATE forge_task_turns SET status = 'completed', terminal_observation = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending_prompt', 'unknown', 'prompted') RETURNING *").get(observation, now(), now(), turnId) as Row | undefined;
      if (!completed || !continuation) return;
      const previous = turn(completed);
      if (this.get(previous.taskId).status !== "active") return;
      this.wakeRoot({ taskId: previous.taskId, rootSessionId: previous.sessionId, generation: previous.generation, prompt: continuation });
    });
  }
  claimRoot(input: { taskId: string }): TaskSession {
    return this.claim(input.taskId);
  }
  /** Claims the delegated slot for a role conversation and appends its immutable assignment turn. */
  launchWorker(input: { taskId: string; rootSessionId: string; rootGeneration: number } & ({ instruction: string; workflowInput?: Extract<WorkflowInput, { kind: "worker" }> } | { advisor: { role: AdvisorRole; prompt: string; input: Extract<WorkflowInput, { kind: "advisor" }> } })): TaskSession {
    const time = now();
    const advisor = "advisor" in input ? input.advisor : null;
    const worker = "advisor" in input ? null : input;
    const workflowInput: WorkflowInput | null = advisor ? advisor.input : worker?.workflowInput ?? null;
    const promptText = advisor ? advisor.prompt : `${workerAssignmentPreamble(worker?.workflowInput?.mode ?? "planned", worker?.workflowInput?.purpose ?? "implementation")}\n\nAssignment:\n${worker?.instruction ?? ""}`;
    const assignmentHash = hash(advisor ? advisor.prompt : worker?.instruction ?? "");
    if (workflowInput) WorkflowInputSchema.parse(workflowInput);
    return this.database.authTransaction((db) => {
      const task = db.prepare("SELECT status FROM forge_task_controls WHERE task_id = ?").get(input.taskId) as Row | undefined;
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ? AND task_id = ? AND kind = 'root' AND is_current = 1 AND generation = ?").get(input.rootSessionId, input.taskId, input.rootGeneration) as Row | undefined;
      if (!task || TaskControlStatusSchema.parse(text(task, "status")) !== "active" || !root || TaskSessionLifecycleSchema.parse(text(root, "lifecycle")) === "cancelled") throw new Error("root_identity_mismatch");
      const current = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker' AND is_current = 1").get(input.taskId) as Row | undefined;
      if (current) {
        const activeTurn = db.prepare("SELECT 1 FROM forge_task_turns WHERE session_id = ? AND generation = ? AND status IN ('pending_prompt', 'prompted', 'unknown') LIMIT 1").get(text(current, "id"), integer(current, "generation"));
        const stopInProgress = text(current, "stop_requested_at") !== null && text(current, "stopped_at") === null;
        const launchInProgress = text(current, "launch_owner") !== null && text(current, "stopped_at") === null;
        if (activeTurn || stopInProgress || launchInProgress) throw new Error("worker_already_assigned");
      }
      const latest = db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker'").get(input.taskId) as Row;
      const generation = integer(latest, "generation") + 1;
      const role = advisor?.role ?? null;
      const compatible = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker' AND advisor_role IS ? AND lifecycle <> 'cancelled' ORDER BY generation DESC, created_at DESC, id DESC LIMIT 1").get(input.taskId, role) as Row | undefined;
      if (compatible && text(compatible, "stop_requested_at") !== null && text(compatible, "stopped_at") === null) throw new Error("worker_already_assigned");
      const reuse = Boolean(compatible);
      const id = reuse ? text(compatible!, "id") : randomUUID();
      if (!id) throw new Error("Invalid persisted task session");
      if (reuse) {
        if (current && text(current, "id") !== id) db.prepare("UPDATE forge_task_sessions SET is_current = 0, updated_at = ? WHERE id = ? AND is_current = 1").run(time, text(current, "id"));
        const changed = db.prepare("UPDATE forge_task_sessions SET generation = ?, is_current = 1, lifecycle = CASE WHEN lifecycle = 'stopped' THEN 'reserved' ELSE lifecycle END, assignment_hash = ?, launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL, stop_requested_at = NULL, stopped_at = NULL, updated_at = ? WHERE id = ? AND lifecycle IN ('reserved', 'live', 'stopped') AND (launch_owner IS NULL OR stopped_at IS NOT NULL) AND (stop_requested_at IS NULL OR stopped_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM forge_task_turns t WHERE t.session_id = forge_task_sessions.id AND t.generation = forge_task_sessions.generation AND t.status IN ('pending_prompt', 'prompted', 'unknown'))").run(generation, assignmentHash, time, id).changes;
        if (changed !== 1) throw new Error("worker_already_assigned");
      } else {
        if (current) db.prepare("UPDATE forge_task_sessions SET is_current = 0, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1").run(time, text(current, "id"), integer(current, "generation"));
        db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, pane_id, native_session_id, lifecycle, assignment_hash, advisor_role, workflow_input_json, created_at, updated_at) VALUES (?, ?, 'worker', ?, 1, NULL, NULL, 'reserved', ?, ?, ?, ?, ?)").run(id, input.taskId, generation, assignmentHash, advisor?.role ?? null, workflowInput ? JSON.stringify(workflowInput) : null, time, time);
      }
      db.prepare("UPDATE forge_task_controls SET worker_session_id = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(id, time, input.taskId);
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, workflow_input_json, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_prompt', NULL, NULL, ?, ?, NULL, NULL, ?)").run(createOpenCodeMessageID(), input.taskId, id, generation, assignmentHash, hash(promptText), promptText, workflowInput ? JSON.stringify(workflowInput) : null, time, time);
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
      db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, pane_id, native_session_id, lifecycle, assignment_hash, created_at, updated_at) VALUES (?, ?, 'root', ?, 1, NULL, NULL, 'reserved', NULL, ?, ?)").run(id, taskId, generation, time, time);
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
  /** Completes the delegate turn, appends a Reviewer/Rater record from its immutable turn input, and wakes Coordinator once. */
  recordWorkerResultAndWake(input: { taskId: string; sessionId: string; generation: number; receiptId: string; observation: string; nativeTurnId?: string; review?: { result: ReviewerResult | RaterResult | null; invalidReason: string | null }; wakePrompt?: string }): { kind: "recorded"; wake: TaskTurn } | { kind: "duplicate" } {
    return this.database.authTransaction((db) => {
      const workerTurn = db.prepare("SELECT * FROM forge_task_turns WHERE task_id = ? AND session_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.sessionId, input.generation) as Row | undefined;
      const workerRow = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ? AND kind = 'worker' AND is_current = 1 AND generation = ? AND lifecycle <> 'cancelled'").get(input.sessionId, input.generation) as Row | undefined;
      if (!workerTurn || !workerRow || TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "cancelled") throw new Error("stale_generation");
      if (TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "completed") { if (text(workerTurn, "result_receipt_id") === input.receiptId) return { kind: "duplicate" }; throw new Error("stale_receipt"); }
      const worker = session(workerRow);
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND is_current = 1").get(input.taskId) as Row | undefined;
      if (!root) throw new Error("root_notification_unavailable");
      const time = now(); const wakeId = createOpenCodeMessageID(); const promptText = input.wakePrompt ?? `Worker result receipt ${input.receiptId}. ${STANDARD_WORKER_RESULT_WAKE}\n\n${input.observation}`; const promptHash = hash(promptText);
      db.prepare("UPDATE forge_task_turns SET status = 'completed', result_receipt_id = ?, terminal_observation = ?, native_turn_id = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(input.receiptId, input.observation, input.nativeTurnId ?? null, time, time, text(workerTurn, "id"));
      const workflowInput = parseJson(text(workerTurn, "workflow_input_json"), WorkflowInputSchema) ?? worker.workflowInput;
      if ((worker.advisorRole === "reviewer" || worker.advisorRole === "rater") && workflowInput?.kind === "advisor") {
        const role = worker.advisorRole;
        const review = input.review ?? { result: null, invalidReason: "The Advisor turn did not complete" };
        const result = review.result && review.result.role === role ? review.result : null;
        const state = this.workflowStateRow(db, input.taskId);
        state.reviews.push({ sessionId: worker.id, turnId: text(workerTurn, "id")!, role, range: workflowInput.range, result, invalidReason: result ? null : review.invalidReason ?? "The Advisor result does not match its role", recordedAt: time } as WorkflowState["reviews"][number]);
        this.writeWorkflowState(db, input.taskId, state);
      }
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(wakeId, input.taskId, text(root, "id"), integer(root, "generation"), promptHash, promptText, time, time);
      db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(time, time, input.taskId);
      return { kind: "recorded", wake: turn(db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(wakeId) as Row) };
    });
  }
  private workflowStateRow(db: Database.Database, taskId: string): WorkflowState {
    const row = db.prepare("SELECT workflow_state_json FROM forge_task_controls WHERE task_id = ?").get(taskId) as Row | undefined;
    return parseJson(row ? text(row, "workflow_state_json") : null, WorkflowStateSchema) ?? emptyWorkflowState();
  }
  private writeWorkflowState(db: Database.Database, taskId: string, state: WorkflowState): void {
    db.prepare("UPDATE forge_task_controls SET workflow_state_json = ?, updated_at = ? WHERE task_id = ?").run(JSON.stringify(WorkflowStateSchema.parse(state)), now(), taskId);
  }
  /**
   * The completion commit boundary for non-Standard workflows. One short transaction reloads the task, its reviews, and its delegate sessions,
   * applies the delivery policy to the validated range against the caller's freshly observed local facts, rechecks ownership, and records the
   * workflow completion and the delivered status together. No filesystem or network I/O runs inside it, so nothing can change between the decision and the write.
   */
  completeWorkflowDelivery(input: { taskId: string; range: ReviewRange; local: { branch: string; headSha: string; clean: boolean }; pullRequestNumber: number | null; requireAccepted: boolean; recheck?: (() => void) | undefined }): WorkflowCompletionResult {
    return this.database.authTransaction((db) => {
      const control = this.get(input.taskId);
      if (control.status === "cancelled") return { kind: "cancelled" };
      if (control.workflowState.completion || control.status === "delivered") {
        if (control.status !== "delivered" && control.workflowState.completion) this.markDelivered(input.taskId);
        return { kind: "already" };
      }
      const accepted = control.workflowState.acceptedDelivery;
      if (input.requireAccepted && (!accepted || !sameRange(accepted, input.range))) return { kind: "declined", code: "workflow_review_required", reason: "No accepted delivery decision matches this range. Complete the workflow's review and request delivery." };
      const decision = deliveryDecision(control, this.sessions(input.taskId), this.turns(input.taskId), input.range, input.local);
      if (!decision.ok) return { kind: "declined", code: decision.code, reason: decision.reason };
      input.recheck?.();
      this.writeWorkflowState(db, input.taskId, { ...control.workflowState, acceptedDelivery: input.range, deliveryWait: null, completion: { kind: "workflow", reviewedHead: input.range.headSha, pullRequestNumber: input.pullRequestNumber, observedAt: now() } });
      this.markDelivered(input.taskId);
      return { kind: "completed" };
    });
  }
  /** Records a terminal outcome that carries no workflow proof: an external merge, or what GitHub reports after cancellation. An existing completion is preserved; an unfinished task becomes delivered, a cancelled one stays cancelled. */
  recordWorkflowOutcome(taskId: string, completion: WorkflowCompletion): boolean {
    return this.database.authTransaction((db) => {
      const control = this.get(taskId);
      if (control.workflowState.completion) return false;
      this.writeWorkflowState(db, taskId, { ...control.workflowState, deliveryWait: null, completion });
      if (control.status === "active" || control.status === "waiting_human") this.markDelivered(taskId);
      return true;
    });
  }
  /** Applies one change to the task's workflow state inside its own short transaction. */
  updateWorkflowState(taskId: string, mutate: (state: WorkflowState) => WorkflowState | void): WorkflowState {
    return this.database.authTransaction((db) => {
      const state = this.workflowStateRow(db, taskId);
      const next = mutate(state) ?? state;
      this.writeWorkflowState(db, taskId, next);
      return next;
    });
  }
  private sameWait(current: DeliveryWait | null, expected: DeliveryWait): boolean {
    return current !== null && current.headSha === expected.headSha && current.fingerprint === expected.fingerprint && current.since === expected.since && current.reason === expected.reason;
  }
  /** Consumes one persisted delivery wait: clears exactly the expected wait and inserts one Coordinator continuation in the same short transaction. */
  resumeDeliveryWait(taskId: string, expectedWait: DeliveryWait, prompt: string): boolean {
    return this.database.authTransaction((db) => {
      const control = this.get(taskId);
      const root = this.currentSession(taskId, "root");
      if (control.status !== "active" || !root || root.lifecycle === "cancelled" || !this.sameWait(control.workflowState.deliveryWait, expectedWait)) return false;
      this.writeWorkflowState(db, taskId, { ...this.workflowStateRow(db, taskId), deliveryWait: null });
      this.wakeRoot({ taskId, rootSessionId: root.id, generation: root.generation, prompt });
      db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(now(), now(), taskId);
      return true;
    });
  }
  /** Clears exactly the expected wait without a continuation (a terminal observation finished it). */
  clearDeliveryWait(taskId: string, expectedWait: DeliveryWait): boolean {
    return this.database.authTransaction((db) => {
      const state = this.workflowStateRow(db, taskId);
      if (!this.sameWait(state.deliveryWait, expectedWait)) return false;
      this.writeWorkflowState(db, taskId, { ...state, deliveryWait: null });
      return true;
    });
  }
  /** Turns exactly the expected wait into one human question; overlapping failures cannot ask twice. */
  failDeliveryWait(taskId: string, expectedWait: DeliveryWait, question: string, options: HumanQuestionOptions = []): boolean {
    return this.database.authTransaction(() => {
      const control = this.get(taskId);
      if (control.status !== "active" || !this.sameWait(control.workflowState.deliveryWait, expectedWait)) return false;
      this.askHuman(taskId, question, options);
      return true;
    });
  }
  /** Serializes Coordinator tool calls per task. A live owner returns null; a dead or reused PID is replaced; an unknown owner is retained. */
  async claimToolOwner(taskId: string): Promise<string | null> {
    const current = this.get(taskId).workflowState.toolOwner;
    if (current) {
      const previous = await this.inspectOwner(current.pid);
      if (previous.kind === "unknown") return null;
      if (previous.kind === "running" && previous.startTime === current.processStartTime) return null;
    }
    const self = await this.inspectOwner(process.pid);
    if (self.kind !== "running") return null;
    const token = randomUUID();
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.toolOwner', json(?)), updated_at = ? WHERE task_id = ? AND json_extract(workflow_state_json, '$.toolOwner.token') IS ?").run(JSON.stringify({ token, pid: process.pid, processStartTime: self.startTime }), now(), taskId, current?.token ?? null).changes);
    return changed === 1 ? token : null;
  }
  releaseToolOwner(taskId: string, token: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.toolOwner', json('null')) WHERE task_id = ? AND json_extract(workflow_state_json, '$.toolOwner.token') = ?").run(taskId, token));
  }
  assertToolOwner(taskId: string, token: string): void {
    if (this.get(taskId).workflowState.toolOwner?.token !== token) throw new Error("task_tool_owner_lost");
  }
  scheduleWake(taskId: string, wakeAt: string | null): void { this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(wakeAt, now(), taskId)); }
  askHuman(taskId: string, question: string, options: HumanQuestionOptions = []): void {
    if (!question.trim()) throw new Error("question_is_empty");
    const changed = this.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET status = 'waiting_human', human_question = ?, human_question_options_json = ?, human_question_id = ?, wake_at = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ? WHERE task_id = ? AND status = 'active'").run(question.trim(), JSON.stringify(HumanQuestionOptionsSchema.parse(options)), randomUUID(), now(), taskId).changes);
    if (changed !== 1) throw new Error("task_not_active");
    this.observeLifecycle(taskId);
  }
  requireExecutionCleanup(turn: TaskTurn): void {
    this.database.authTransaction(db => {
      this.askHuman(turn.taskId, "The agent stopped during a tool call. A command can still be active in the worktree. Stop those commands before you continue. Describe what you checked, then confirm that all commands from this session have stopped.");
      db.prepare("UPDATE forge_task_controls SET recovery_turn_id = ? WHERE task_id = ?").run(turn.id, turn.taskId);
    });
  }
  cancel(taskId: string): void {
    this.database.authTransaction((db) => {
      const changed = db.prepare("UPDATE forge_task_controls SET status = 'cancelled', wake_at = NULL, human_question = NULL, human_question_id = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ? WHERE task_id = ? AND status <> 'delivered'").run(now(), taskId).changes;
      if (changed !== 1) throw new Error("task_not_cancellable");
      db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = COALESCE(stop_requested_at, ?), updated_at = ? WHERE task_id = ? AND stopped_at IS NULL").run(now(), now(), taskId);
      db.prepare("UPDATE forge_task_turns SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status IN ('pending_prompt', 'prompted', 'unknown')").run(now(), taskId);
    });
    this.observeLifecycle(taskId);
  }
  private observeLifecycle(taskId: string): TaskControl {
    const value = this.get(taskId);
    try { new TaskAnalyticsStore(this.database).observe({ id: taskId, status: value.status, humanQuestion: value.humanQuestionId ? { id: value.humanQuestionId } : null }); }
    catch (error) { new StructuredLogger().warn("Analytics lifecycle observation failed", { taskId }, { error: error instanceof Error ? error.message : "unknown error" }); }
    return value;
  }
  assertCurrentRoot(input: { taskId: string; sessionId: string; generation: number }): void { const current = this.currentSession(input.taskId, "root"); const task = this.get(input.taskId); if (!current || task.status !== "active" || current.id !== input.sessionId || current.generation !== input.generation || !current.current || current.lifecycle === "cancelled") throw new Error("root_identity_mismatch"); }
  private byId(id: string): TaskSession { return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row | undefined; if (!row) throw new Error(`Task session ${id} does not exist`); return session(row); }); }
  private turnById(id: string): TaskTurn { return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(id) as Row | undefined; if (!row) throw new Error(`Task turn ${id} does not exist`); return turn(row); }); }
}

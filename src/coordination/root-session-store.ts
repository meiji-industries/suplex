import { replaceWorker, workerReplacementReady } from "./worker-replacement.js";
import { selectDelegate } from "./task-agent-selection.js";
import { TaskAgentSelectionRequestSchema, type TaskAgentSelectionRequest } from "./task-agent-selection-contracts.js";
import { replaceCoordinator } from "./coordinator-replacement.js";
import { CoordinatorReplacementRequestSchema, type CoordinatorReplacementRequest } from "./coordinator-replacement-contracts.js";
import { WorkerReplacementRequestSchema, type WorkerReplacementRequest } from "./worker-replacement-contracts.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { IssueContextSchema } from "../tasks/issue-association.js";
import { HumanQuestionOptionsSchema, type HumanQuestionOptions } from "./human-question.js";
import { inspectProcessOnce } from "../platform/process-manager.js";
import { TaskAnalyticsStore } from "../tasks/analytics/store.js";
import { StructuredLogger } from "../platform/logging.js";
import { TaskLimitStore } from "../tasks/limits/limit-store.js";
import { assertProfileAllowed } from "../projects/provider-policy.js";
import { TaskLimitPauseSchema, type TaskLimitDecision, type TaskLimitPause, type TaskLimits, type TaskLimitUsage } from "../tasks/limits/limits.js";
import type { TaskUsage } from "../tasks/usage.js";

import type Database from "better-sqlite3";
import type { ForgeDatabase } from "../platform/database.js";
import { createOpenCodeMessageID } from "../runtimes/opencode/session.js";
import { DeliveryTargetSchema, TaskConfigurationSchema, type DeliveryTarget } from "../tasks/contracts.js";
import { taskDependencyBlockersInTransaction, taskDependencySummaries, taskDependencySummariesInTransaction, type TaskDependencySummary } from "../tasks/dependencies.js";
import { admitQueuedTask, admitQueuedTasks, readyQueuedTaskIds } from "../tasks/queue.js";
import type { PromptDispatchAttempt, PullRequestReference } from "../tasks/control.js";
import { DeliveryIntentSchema, PullRequestReferenceSchema, TaskControlStatusSchema, TaskProfileSchema, TaskSessionLifecycleSchema, TaskTurnStatusSchema, WorktreeReferenceSchema, type DeliveryIntent, type TaskControl, type TaskProfile, type TaskSession, type TaskSessionKind, type TaskTurn, type WorktreeReference } from "../tasks/control.js";
import { AdvisorRoleSchema, AgentSelectionIntentSchema, RaterResultSchema, ReviewerResultSchema, WorkflowIdSchema, WorkflowInputSchema, WorkflowStateSchema, deliveryDecision, emptyWorkflowState, sameRange, turnOutcome, type AdvisorResult, type AdvisorRole, type DeliveryFailureCode, type DeliveryWait, type RaterResult, type ReviewRange, type ReviewerResult, type WorkflowCompletion, type WorkflowId, type WorkflowInput, type WorkflowState } from "./workflows.js";
import { IDLE_ROOT_PROMPT, STANDARD_WORKER_RESULT_WAKE, initialCoordinatorPrompt, isIdleRootPrompt, withCurrentDependencyStatus, workerAssignmentPreamble } from "./workflow-prompts.js";
import { assertPullRequestAvailable, assertTaskPullRequestsAvailable } from "../delivery/pull-request-ownership.js";
import { recordTriggerPush, triggerDeliveryPolicy, type GithubTriggerDeliveryPolicy } from "../integrations/github/trigger-delivery-policy.js";
import { integer, parseJson, text, type Row } from "./persistence/row-values.js";
import { bindHarnessSession, bindPane, currentDelegates, currentSession, currentSessionByIdentity, hasTurns, markPrompted, pendingTurns, requeueFencedPrompt, releaseSessionOperation, session, sessions, turn, turns } from "./persistence/session-operations.js";

const now = (): string => new Date().toISOString();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

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

function control(row: Row): TaskControl {
  const status = TaskControlStatusSchema.parse(text(row, "status"));
  const taskId = text(row, "task_id"); const objective = text(row, "objective"); const deliveryTarget = text(row, "delivery_target");
  if (!taskId || !objective || !deliveryTarget) throw new Error("Invalid persisted task control");
  const rootProfile = parseJson(text(row, "root_profile_json"), TaskProfileSchema); const workerProfile = parseJson(text(row, "worker_profile_json"), TaskProfileSchema); const deliveryIntent = parseJson(text(row, "delivery_intent_json"), DeliveryIntentSchema);
  if (!rootProfile || !workerProfile || !deliveryIntent) throw new Error("Task control configuration is missing");
  const workflow = WorkflowIdSchema.parse(text(row, "workflow") ?? "standard");
  const advisorProfiles = z.partialRecord(AdvisorRoleSchema, TaskProfileSchema).parse(JSON.parse(text(row, "advisor_profiles_json") ?? "{}"));
  const workflowState = parseJson(text(row, "workflow_state_json"), WorkflowStateSchema) ?? emptyWorkflowState();
  return { workflow, advisorProfiles, workflowState, humanQuestionOptions: HumanQuestionOptionsSchema.parse(JSON.parse(text(row, "human_question_options_json") ?? "[]")), taskId, objective, deliveryTarget, deliveryIntent, status, wakeAt: text(row, "wake_at"), humanQuestion: text(row, "human_question"), humanQuestionId: text(row, "human_question_id"), recoveryTurnId: text(row, "recovery_turn_id"), limitPause: parseJson(text(row, "limit_pause_json"), TaskLimitPauseSchema), worktree: parseJson(text(row, "worktree_json"), WorktreeReferenceSchema), pullRequest: parseJson(text(row, "pull_request_json"), PullRequestReferenceSchema), rootSessionId: text(row, "root_session_id"), workerSessionId: text(row, "worker_session_id"), shellPaneId: text(row, "shell_pane_id"), rootProfile, workerProfile };
}

export class TaskControlStore {
  private readonly limitStore: TaskLimitStore;
  constructor(readonly database: ForgeDatabase, private readonly inspectOwner: (pid: number) => Promise<ProcessOwnerObservation> = observeProcessOwner) { this.limitStore = new TaskLimitStore(database); }
  readTriggerDeliveryPolicy(taskId: string): GithubTriggerDeliveryPolicy | null { return this.database.authQuery(db => triggerDeliveryPolicy(db, taskId)); }
  recordTriggerPush(input: { taskId: string; dispatchId: string; fromHeadSha: string; toHeadSha: string; review: unknown }): void { this.database.authImmediateTransaction(db => recordTriggerPush(db, input)); }
  taskSpend(taskId: string): { costUsd: number; turns: number } {
    return this.database.authQuery((db) => ({
      costUsd: (db.prepare("SELECT COALESCE(SUM(json_extract(snapshot, '$.cost')), 0) AS cost FROM forge_task_usage WHERE task_id = ?").get(taskId) as { cost: number }).cost,
      turns: (db.prepare("SELECT COUNT(*) AS turns FROM forge_task_turns WHERE task_id = ? AND prompted_at IS NOT NULL").get(taskId) as { turns: number }).turns,
    }));
  }
  taskLimits(taskId: string): { budgetUsd: number; maxTurns: number } {
    return this.limitStore.read(taskId);
  }
  taskLimitState(taskId: string): { limits: TaskLimits; admittedTurns: number; pause: TaskLimitPause | null } {
    const limits = this.taskLimits(taskId);
    const current = this.get(taskId);
    return { limits, admittedTurns: this.taskSpend(taskId).turns, pause: current.limitPause };
  }
  sessionsWithNativeWork(taskId: string): TaskSession[] {
    return this.database.authQuery(db => (db.prepare("SELECT DISTINCT s.* FROM forge_task_sessions s JOIN forge_task_turns t ON t.session_id = s.id WHERE s.task_id = ? AND s.native_session_id IS NOT NULL AND (t.prompted_at IS NOT NULL OR t.status = 'unknown') ORDER BY s.created_at, s.id").all(taskId) as Row[]).map(session));
  }
  replaceNativeUsage(taskId: string, usage: TaskUsage[]): void {
    this.limitStore.replaceUsage(taskId, usage);
  }
  pauseAtTaskLimit(taskId: string, usage: TaskLimitUsage): boolean { return this.limitStore.pauseIfReached(taskId, usage); }
  reconcileTaskLimitPause(taskId: string, questionId: string, usage: TaskLimitUsage): boolean { return this.limitStore.reconcilePause(taskId, questionId, usage); }
  create(input: { taskId: string; startImmediately: boolean; objective: string; deliveryTarget: string; deliveryIntent: DeliveryIntent; rootProfile: TaskProfile; workerProfile: TaskProfile; worktree?: WorktreeReference; workflow?: WorkflowId; advisorProfiles?: Partial<Record<AdvisorRole, TaskProfile>> }): TaskControl {
    const time = now();
    const advisorProfiles = Object.fromEntries(Object.entries(input.advisorProfiles ?? {}).map(([role, profile]) => [AdvisorRoleSchema.parse(role), TaskProfileSchema.parse(profile)]));
    this.database.authImmediateTransaction((db) => { const intent = DeliveryIntentSchema.parse(input.deliveryIntent); if (intent.pullRequestNumber) assertPullRequestAvailable(db, { taskId: input.taskId, repository: intent.repository, number: intent.pullRequestNumber }); db.prepare("INSERT INTO forge_task_controls (task_id, objective, delivery_target, delivery_intent_json, status, wake_at, human_question, worktree_json, pull_request_json, root_session_id, worker_session_id, root_profile_json, worker_profile_json, workflow, advisor_profiles_json, workflow_state_json, status_changed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.taskId, input.objective, input.deliveryTarget, JSON.stringify(intent), input.startImmediately ? "queued" : "backlog", input.worktree ? JSON.stringify(input.worktree) : null, JSON.stringify(TaskProfileSchema.parse(input.rootProfile)), JSON.stringify(TaskProfileSchema.parse(input.workerProfile)), WorkflowIdSchema.parse(input.workflow ?? "standard"), JSON.stringify(advisorProfiles), JSON.stringify(emptyWorkflowState()), time, time, time); });
    return this.observeLifecycle(input.taskId);
  }
  /**
   * Start means queue: the task records its start intent and starts now only when every prerequisite is complete. It never
   * bypasses a prerequisite. An active task only receives an earlier wake.
   */
  start(taskId: string): TaskControl {
    const changed = this.database.authImmediateTransaction(db => {
      const time = now();
      if (db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(time, time, taskId).changes === 1) return true;
      if (db.prepare("UPDATE forge_task_controls SET status = 'queued', updated_at = ? WHERE task_id = ? AND status = 'backlog' AND EXISTS (SELECT 1 FROM forge_tasks WHERE id = task_id AND archived_at IS NULL)").run(time, taskId).changes !== 1) {
        const row = db.prepare("SELECT c.status, t.archived_at AS archivedAt FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id WHERE c.task_id = ?").get(taskId) as { status: string; archivedAt: string | null } | undefined;
        if (row?.status !== "queued" || row.archivedAt) return false;
      }
      admitQueuedTask(db, taskId);
      return true;
    });
    if (!changed) throw new Error("task_not_startable");
    return this.observeLifecycle(taskId);
  }
  /** Returns a queued task to the manual backlog. A manual backlog task is a no-op. */
  disarm(taskId: string): boolean {
    const changed = this.database.authImmediateTransaction(db => {
      const status = (db.prepare("SELECT status FROM forge_task_controls WHERE task_id = ?").get(taskId) as { status: string } | undefined)?.status;
      if (status === "backlog") return false;
      if (status !== "queued") return null;
      db.prepare("UPDATE forge_task_controls SET status = 'backlog', updated_at = ? WHERE task_id = ? AND status = 'queued'").run(now(), taskId);
      return true;
    });
    if (changed === true) this.observeLifecycle(taskId);
    return changed !== null;
  }
  /** Re-evaluates the given queued tasks after their prerequisites changed. Without ids, it is the sweep over every queued task that runs from startup on. */
  admitQueued(taskIds?: string[]): string[] {
    if (!taskIds && !this.database.authQuery(db => readyQueuedTaskIds(db)).length) return [];
    const admitted = this.database.authImmediateTransaction(db => admitQueuedTasks(db, taskIds ?? readyQueuedTaskIds(db)));
    for (const taskId of admitted) this.observeLifecycle(taskId);
    return admitted;
  }
  sendNote(taskId: string, note: string, label = "Human note"): TaskControl {
    this.database.authImmediateTransaction(db => {
      const control = this.get(taskId);
      const time = now();
      const resuming = control.status === "delivered";
      if (resuming) {
        assertTaskPullRequestsAvailable(db, taskId);
        const state = control.workflowState;
        this.writeWorkflowState(db, taskId, { ...state, acceptedDelivery: null, completion: null, deliveryWait: null, followUp: true, deliveryHistory: [...state.deliveryHistory ?? [], { resumedAt: time, acceptedDelivery: state.acceptedDelivery, completion: state.completion }] });
        db.prepare("UPDATE forge_task_controls SET status = 'active', wake_at = ?, updated_at = ? WHERE task_id = ?").run(time, time, taskId);
        db.prepare("UPDATE forge_task_sessions SET is_current = 1, lifecycle = 'reserved', stop_requested_at = NULL, stopped_at = NULL, updated_at = ? WHERE id = ? AND kind = 'root'").run(time, control.rootSessionId);
      }
      const existing = this.currentSession(taskId, "root");
      const root = existing ?? this.claimRoot({ taskId });
      if (!existing) this.ensureInitialPrompt(root, initialCoordinatorPrompt(this.get(taskId), this.context(taskId)));
      const prompt = resuming ? JSON.stringify({ question: "The user has resumed this delivered task. Handle the follow-up below before completing delivery again. Preserve existing work and inspect current GitHub state. Earlier delivery is history, not completion of this request. For failing checks, read the logs, reproduce and repair the failure, verify locally, push, and observe checks on the current head. Keep the delivery target unchanged. Request delivery explicitly only when the follow-up is satisfied.", answer: note }) : `${label}:\n${note}`;
      this.wakeRoot({ taskId, rootSessionId: root.id, generation: root.generation, prompt });
    });
    return this.observeLifecycle(taskId);
  }
  continueDelivery(taskId: string, deliveryTarget: Extract<DeliveryTarget, "pull_request_ready" | "merged">): TaskControl {
    this.database.authImmediateTransaction(db => {
      const current = this.get(taskId);
      const archived = db.prepare("SELECT archived_at FROM forge_tasks WHERE id = ?").get(taskId) as { archived_at: string | null } | undefined;
      if (!archived || archived.archived_at) throw new Error("Open the archived task before you continue delivery.");
      const order: Record<DeliveryTarget, number> = { local_worktree: 0, remote_branch: 1, pull_request_draft: 2, pull_request_ready: 3, merged: 4 };
      const previousTarget = DeliveryTargetSchema.parse(current.deliveryTarget);
      if (order[deliveryTarget] < order[previousTarget]) throw new Error("The delivery target cannot move backward.");
      if (order[deliveryTarget] === order[previousTarget] && ["active", "delivered"].includes(current.status)) return;
      if (current.status !== "delivered" || order[previousTarget] < order.pull_request_draft) throw new Error("Only delivered pull request tasks can continue delivery.");
      assertTaskPullRequestsAvailable(db, taskId);
      const time = now();
      const state = current.workflowState;
      this.writeWorkflowState(db, taskId, { ...state, acceptedDelivery: null, completion: null, deliveryWait: null, followUp: true, deliveryHistory: [...state.deliveryHistory ?? [], { resumedAt: time, acceptedDelivery: state.acceptedDelivery, completion: state.completion }] });
      db.prepare("UPDATE forge_task_controls SET delivery_target = ?, status = 'active', wake_at = ?, updated_at = ? WHERE task_id = ? AND status = 'delivered'").run(deliveryTarget, time, time, taskId);
      if (current.rootSessionId) db.prepare("UPDATE forge_task_sessions SET is_current = 1, lifecycle = 'reserved', stop_requested_at = NULL, stopped_at = NULL, updated_at = ? WHERE id = ? AND task_id = ? AND kind = 'root'").run(time, current.rootSessionId, taskId);
      const existing = this.currentSession(taskId, "root");
      const root = existing ?? this.claimRoot({ taskId });
      if (!existing) this.ensureInitialPrompt(root, initialCoordinatorPrompt(this.get(taskId), this.context(taskId)));
      const prompt = JSON.stringify({ question: `The user changed the delivery target from ${previousTarget} to ${deliveryTarget}. Continue this task toward the NEW target ${deliveryTarget}. Preserve the existing branch, pull request, sessions, and useful review evidence. Inspect current Git and GitHub facts, repair conflicts and failing checks, and request delivery explicitly when the new target is satisfied. Earlier completion is history.`, answer: `Continue delivery to ${deliveryTarget}.` });
      this.wakeRoot({ taskId, rootSessionId: root.id, generation: root.generation, prompt });
    });
    return this.observeLifecycle(taskId);
  }
  answerHuman(taskId: string, questionId: string, answer: string, confirmCommandsStopped = false): TaskControl {
    if (!answer.trim()) throw new Error("answer_is_empty");
    this.database.authTransaction((db) => {
      const row = db.prepare("SELECT * FROM forge_task_controls WHERE task_id = ? AND status = 'waiting_human' AND human_question_id = ?").get(taskId, questionId) as Row | undefined;
      if (!row) throw new Error("question_identity_mismatch");
      if (text(row, "limit_pause_json") !== null) throw new Error("task_limit_decision_required");
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
  answerTaskLimit(taskId: string, questionId: string, rawDecision: TaskLimitDecision): TaskControl {
    this.limitStore.answer(taskId, questionId, rawDecision);
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
    const changed = this.database.authImmediateTransaction((db) => { const current = db.prepare("SELECT status FROM forge_task_controls WHERE task_id = ?").get(taskId) as { status: string } | undefined; if (pullRequest && current && ["active", "waiting_human"].includes(current.status)) assertPullRequestAvailable(db, { taskId, repository: pullRequest.repository, number: pullRequest.number }); return db.prepare("UPDATE forge_task_controls SET pull_request_json = ?, updated_at = ? WHERE task_id = ? AND status IN ('active', 'waiting_human', 'delivered', 'cancelled')").run(value, now(), taskId).changes; });
    if (changed !== 1) throw new Error("task_not_active");
    return this.get(taskId);
  }
  markDelivered(taskId: string): TaskControl {
    const changed = this.database.authTransaction((db) => {
      const previous = db.prepare("SELECT status FROM forge_task_controls WHERE task_id = ?").get(taskId) as { status: string } | undefined;
      const delivered = db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.followUp', json('false')), status = 'delivered', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, updated_at = ? WHERE task_id = ? AND status IN ('active', 'waiting_human', 'delivered')").run(now(), taskId).changes;
      if (delivered !== 1) return delivered;
      // A queued dependent starts in the same transaction when this delivery completes its last prerequisite.
      admitQueuedTasks(db, readyQueuedTaskIds(db, taskId));
      if (previous?.status !== "delivered") {
        const dependents = db.prepare("SELECT task_id AS id FROM forge_task_dependencies WHERE depends_on_task_id = ? ORDER BY task_id").all(taskId) as Array<{ id: string }>;
        for (const dependent of dependents) this.reconcileDependencyReleaseInTransaction(db, dependent.id);
      }
      return delivered;
    });
    if (changed !== 1) throw new Error("task_not_active");
    return this.observeLifecycle(taskId);
  }
  /** Call when a task may have lost its last blocker. A queued task is admitted; an active task receives an earlier wake. */
  reconcileDependencyReleaseInTransaction(db: Database.Database, taskId: string): void {
    if (taskDependencyBlockersInTransaction(db, taskId).length) return;
    if (admitQueuedTasks(db, [taskId]).length) return;
    db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(now(), now(), taskId);
  }
  get(taskId: string): TaskControl {
    return this.database.authQuery((db) => { const row = db.prepare("SELECT * FROM forge_task_controls WHERE task_id = ?").get(taskId) as Row | undefined; if (!row) throw new Error(`Task control ${taskId} does not exist`); return control(row); });
  }
  context(taskId: string) {
    return this.database.authQuery(db => {
      const row = db.prepare("SELECT configuration_json, issue_context_json FROM forge_tasks WHERE id = ?").get(taskId) as Row | undefined;
      const configuration = row ? text(row, "configuration_json") : null;
      if (!configuration) throw new Error("Task configuration is missing");
      const images = db.prepare("SELECT id AS artifactId, filename FROM forge_artifacts WHERE task_id = ? AND kind IN ('task-image', 'delivery-image') ORDER BY created_at, id").all(taskId);
      const issueContext = row ? text(row, "issue_context_json") : null;
      return { configuration: TaskConfigurationSchema.parse(JSON.parse(configuration)), images, issueContext: issueContext ? IssueContextSchema.parse(JSON.parse(issueContext)) : null };
    });
  }
  dependencySummaries(taskId: string): TaskDependencySummary[] { return taskDependencySummaries(this.database, taskId); }
  dependencyBlockers(taskId: string): TaskDependencySummary[] { return this.database.authQuery(db => taskDependencyBlockersInTransaction(db, taskId)); }
  image(taskId: string, artifactId: string) {
    return this.database.authQuery(db => {
      const row = db.prepare("SELECT a.filename, a.mime_type AS mimeType, a.company_id AS companyId, a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a JOIN forge_tasks t ON t.id = a.task_id AND t.company_id = a.company_id WHERE t.id = ? AND a.id = ? AND a.kind IN ('task-image', 'delivery-image')").get(taskId, artifactId);
      return z.object({ filename: z.string(), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), companyId: z.string(), storagePath: z.string(), sha256: z.string() }).parse(row);
    });
  }
  currentSession(taskId: string, kind: TaskSessionKind): TaskSession | null { return currentSession(this.database, taskId, kind); }
  currentDelegates(taskId: string): TaskSession[] { return currentDelegates(this.database, taskId); }
  currentSessionByIdentity(sessionId: string, generation: number): TaskSession | null { return currentSessionByIdentity(this.database, sessionId, generation); }
  sessions(taskId: string): TaskSession[] { return sessions(this.database, taskId); }
  turns(taskId: string): TaskTurn[] { return turns(this.database, taskId); }
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
  releaseSessionOperation(sessionId: string, owner: string): void { releaseSessionOperation(this.database, sessionId, owner); }
  bindHarnessSession(input: { sessionId: string; generation: number; nativeSessionId: string }): TaskSession {
    bindHarnessSession(this.database, input, now);
    return this.byId(input.sessionId);
  }
  bindPane(input: { sessionId: string; generation: number; paneId: string }): void {
    bindPane(this.database, input, now);
  }
  bindShellPane(taskId: string, paneId: string): void {
    this.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET shell_pane_id = ?, updated_at = ? WHERE task_id = ?").run(paneId, now(), taskId));
  }
  hasTurns(sessionId: string): boolean {
    return hasTurns(this.database, sessionId);
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
      return owner.kind === "absent" || owner.kind === "running" && (session.launchOwnerStartTime === null || owner.startTime !== session.launchOwnerStartTime);
    }));
    return sessions.filter((_, index) => stoppedOwners[index]);
  }
  completeStop(sessionId: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_task_sessions SET stopped_at = ?, launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL, updated_at = ? WHERE id = ? AND stop_requested_at IS NOT NULL AND stopped_at IS NULL").run(now(), now(), sessionId));
  }
  wakeIdleRoot(taskId: string): void {
    const time = now();
    this.database.authTransaction((db) => {
      if (taskDependencyBlockersInTransaction(db, taskId).length) return;
      const prompt = withCurrentDependencyStatus(IDLE_ROOT_PROMPT, taskDependencySummariesInTransaction(db, taskId));
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) SELECT ?, c.task_id, s.id, s.generation, ?, ?, 'pending_prompt', ?, ? FROM forge_task_controls c JOIN forge_task_sessions s ON s.id = c.root_session_id WHERE c.task_id = ? AND c.status = 'active' AND json_extract(c.workflow_state_json, '$.deliveryWait') IS NULL AND s.is_current = 1 AND s.lifecycle = 'live' AND s.native_session_id IS NOT NULL AND s.launch_owner IS NULL AND NOT EXISTS (SELECT 1 FROM forge_task_turns t WHERE t.session_id = s.id AND t.status IN ('pending_prompt', 'prompted', 'unknown')) AND NOT EXISTS (SELECT 1 FROM forge_task_sessions w JOIN forge_task_turns wt ON wt.session_id = w.id AND wt.generation = w.generation WHERE w.task_id = c.task_id AND w.kind = 'worker' AND w.is_current = 1 AND wt.status IN ('pending_prompt', 'prompted', 'unknown'))").run(createOpenCodeMessageID(), hash(prompt), prompt, time, time, taskId);
    });
  }
  coalesceUnadmittedIdleRootTurn(turnId: string): boolean {
    return this.database.authTransaction(db => {
      const candidate = db.prepare("SELECT t.task_id AS taskId, t.session_id AS sessionId, t.prompt_text AS promptText FROM forge_task_turns t JOIN forge_task_sessions s ON s.id = t.session_id WHERE t.id = ? AND t.status = 'pending_prompt' AND s.kind = 'root'").get(turnId) as { taskId: string; sessionId: string; promptText: string } | undefined;
      if (!candidate || !isIdleRootPrompt(candidate.promptText)) return false;
      const others = db.prepare("SELECT prompt_text AS promptText FROM forge_task_turns WHERE task_id = ? AND session_id = ? AND id <> ? AND status = 'pending_prompt'").all(candidate.taskId, candidate.sessionId, turnId) as Array<{ promptText: string }>;
      if (!others.some(other => !isIdleRootPrompt(other.promptText))) return false;
      return db.prepare("UPDATE forge_task_turns SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending_prompt'").run(now(), turnId).changes === 1;
    });
  }
  refreshPendingRootDependencyContext(turnId: string): TaskTurn {
    return this.database.authTransaction(db => {
      const row = db.prepare("SELECT t.* FROM forge_task_turns t JOIN forge_task_sessions s ON s.id = t.session_id WHERE t.id = ? AND t.status = 'pending_prompt' AND s.kind = 'root'").get(turnId) as Row | undefined;
      if (!row) return this.turnById(turnId);
      const current = turn(row);
      const prompt = withCurrentDependencyStatus(current.promptText, taskDependencySummariesInTransaction(db, current.taskId));
      if (prompt !== current.promptText) db.prepare("UPDATE forge_task_turns SET prompt_text = ?, prompt_hash = ?, updated_at = ? WHERE id = ? AND status = 'pending_prompt'").run(prompt, hash(prompt), now(), turnId);
      const refreshed = db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(turnId) as Row;
      return turn(refreshed);
    });
  }
  claimPrompt(input: { taskId: string; turnId: string; serverGeneration: string; owner: string; usage: TaskLimitUsage }): boolean {
    return this.limitStore.claimPrompt(input, db => taskDependencyBlockersInTransaction(db, input.taskId).length === 0);
  }
  requeueFencedPrompt(input: { turnId: string; attempt: PromptDispatchAttempt; owner: string }): boolean {
    return requeueFencedPrompt(this.database, input, now);
  }
  completeRootTurn(turnId: string, observation: string, continuation?: string): boolean {
    return this.database.authTransaction(db => {
      const completed = db.prepare("UPDATE forge_task_turns SET status = 'completed', terminal_observation = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending_prompt', 'unknown', 'prompted') RETURNING *").get(observation, now(), now(), turnId) as Row | undefined;
      if (!completed) return false;
      if (!continuation) return true;
      const previous = turn(completed);
      if (this.get(previous.taskId).status !== "active") return true;
      this.wakeRoot({ taskId: previous.taskId, rootSessionId: previous.sessionId, generation: previous.generation, prompt: continuation });
      return true;
    });
  }
  claimRoot(input: { taskId: string }): TaskSession {
    return this.claim(input.taskId);
  }
  /** Launches one serial delegate. Combined planning uses launchPlannerPair to reserve both roles atomically. */
  launchWorker(input: { taskId: string; rootSessionId: string; rootGeneration: number } & ({ instruction: string; workflowInput?: Extract<WorkflowInput, { kind: "worker" }> } | { advisor: { role: AdvisorRole; prompt: string; input: Extract<WorkflowInput, { kind: "advisor" }> } })): TaskSession {
    const time = now();
      const advisor = "advisor" in input ? input.advisor : null;
    const worker = "advisor" in input ? null : input;
      const workflowInput: WorkflowInput | null = advisor ? advisor.input : worker?.workflowInput ?? null;
      const delegateSlot = advisor?.role === "planner_a" || advisor?.role === "planner_b" ? advisor.role : "delegate";
    const promptText = advisor ? advisor.prompt : `${workerAssignmentPreamble(worker?.workflowInput?.mode ?? "planned", worker?.workflowInput?.purpose ?? "implementation")}\n\nAssignment:\n${worker?.instruction ?? ""}`;
    const assignmentHash = hash(advisor ? advisor.prompt : worker?.instruction ?? "");
    if (workflowInput) WorkflowInputSchema.parse(workflowInput);
    return this.database.authTransaction((db) => {
      const task = db.prepare("SELECT status, workflow, root_profile_json, worker_profile_json, advisor_profiles_json FROM forge_task_controls WHERE task_id = ?").get(input.taskId) as Row | undefined;
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ? AND task_id = ? AND kind = 'root' AND is_current = 1 AND generation = ?").get(input.rootSessionId, input.taskId, input.rootGeneration) as Row | undefined;
      if (!task || TaskControlStatusSchema.parse(text(task, "status")) !== "active" || !root || TaskSessionLifecycleSchema.parse(text(root, "lifecycle")) === "cancelled") throw new Error("root_identity_mismatch");
      if (db.prepare("SELECT 1 FROM forge_task_sessions s JOIN forge_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ? AND s.kind = 'worker' AND s.is_current = 1 AND t.status IN ('pending_prompt', 'prompted', 'unknown')").get(input.taskId)) throw new Error("worker_already_assigned");
      const current = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker' AND delegate_slot = ? AND is_current = 1").get(input.taskId, delegateSlot) as Row | undefined;
      if (current) {
        const activeTurn = db.prepare("SELECT 1 FROM forge_task_turns WHERE session_id = ? AND generation = ? AND status IN ('pending_prompt', 'prompted', 'unknown') LIMIT 1").get(text(current, "id"), integer(current, "generation"));
        const stopInProgress = text(current, "stop_requested_at") !== null && text(current, "stopped_at") === null;
        const launchInProgress = text(current, "launch_owner") !== null && text(current, "stopped_at") === null;
        if (activeTurn || stopInProgress || launchInProgress) throw new Error("worker_already_assigned");
      }
      const latest = db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker'").get(input.taskId) as Row;
      const generation = integer(latest, "generation") + 1;
      const role = advisor?.role ?? null;
      const advisorProfiles = z.partialRecord(AdvisorRoleSchema, TaskProfileSchema).parse(JSON.parse(text(task, "advisor_profiles_json") ?? "{}"));
      const profile = role ? advisorProfiles[role] ?? TaskProfileSchema.parse(JSON.parse(text(task, "root_profile_json")!)) : TaskProfileSchema.parse(JSON.parse(text(task, "worker_profile_json")!));
      const compatible = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker' AND advisor_role IS ? AND lifecycle <> 'cancelled' AND (profile_json IS NULL OR json(profile_json) = json(?)) ORDER BY generation DESC, created_at DESC, id DESC LIMIT 1").get(input.taskId, role, JSON.stringify(profile)) as Row | undefined;
      if (compatible && text(compatible, "stop_requested_at") !== null && text(compatible, "stopped_at") === null) throw new Error("worker_already_assigned");
      const reuse = Boolean(compatible);
      const id = reuse ? text(compatible!, "id") : randomUUID();
      if (!id) throw new Error("Invalid persisted task session");
      if (reuse) {
        if (current && text(current, "id") !== id) db.prepare("UPDATE forge_task_sessions SET is_current = 0, updated_at = ? WHERE id = ? AND is_current = 1").run(time, text(current, "id"));
        const changed = db.prepare("UPDATE forge_task_sessions SET generation = ?, is_current = 1, lifecycle = CASE WHEN lifecycle = 'stopped' THEN 'reserved' ELSE lifecycle END, assignment_hash = ?, profile_json = COALESCE(profile_json, ?), launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL, stop_requested_at = NULL, stopped_at = NULL, updated_at = ? WHERE id = ? AND lifecycle IN ('reserved', 'live', 'stopped') AND (launch_owner IS NULL OR stopped_at IS NOT NULL) AND (stop_requested_at IS NULL OR stopped_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM forge_task_turns t WHERE t.session_id = forge_task_sessions.id AND t.generation = forge_task_sessions.generation AND t.status IN ('pending_prompt', 'prompted', 'unknown'))").run(generation, assignmentHash, JSON.stringify(profile), time, id).changes;
        if (changed !== 1) throw new Error("worker_already_assigned");
      } else {
        if (current) db.prepare("UPDATE forge_task_sessions SET is_current = 0, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1").run(time, text(current, "id"), integer(current, "generation"));
        db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, pane_id, native_session_id, lifecycle, assignment_hash, advisor_role, delegate_slot, workflow_input_json, profile_json, created_at, updated_at) VALUES (?, ?, 'worker', ?, 1, NULL, NULL, 'reserved', ?, ?, ?, ?, ?, ?, ?)").run(id, input.taskId, generation, assignmentHash, advisor?.role ?? null, delegateSlot, workflowInput ? JSON.stringify(workflowInput) : null, JSON.stringify(profile), time, time);
      }
      db.prepare("UPDATE forge_task_controls SET worker_session_id = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(id, time, input.taskId);
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, workflow_input_json, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_prompt', NULL, NULL, ?, ?, NULL, NULL, ?)").run(createOpenCodeMessageID(), input.taskId, id, generation, assignmentHash, hash(promptText), promptText, workflowInput ? JSON.stringify(workflowInput) : null, time, time);
      return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
    });
  }
  launchPlannerPair(input: { taskId: string; rootSessionId: string; rootGeneration: number; pairId: string; planners: readonly [{ role: "planner_a"; prompt: string; input: Extract<WorkflowInput, { kind: "advisor" }> }, { role: "planner_b"; prompt: string; input: Extract<WorkflowInput, { kind: "advisor" }> }] }): [TaskSession, TaskSession] {
    const time = now();
    for (const planner of input.planners) WorkflowInputSchema.parse(planner.input);
    return this.database.authTransaction(db => {
      const task = db.prepare("SELECT status, workflow, root_profile_json, advisor_profiles_json FROM forge_task_controls WHERE task_id = ?").get(input.taskId) as Row | undefined;
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ? AND task_id = ? AND kind = 'root' AND is_current = 1 AND generation = ?").get(input.rootSessionId, input.taskId, input.rootGeneration) as Row | undefined;
      if (!task || TaskControlStatusSchema.parse(text(task, "status")) !== "active" || !root || TaskSessionLifecycleSchema.parse(text(root, "lifecycle")) === "cancelled") throw new Error("root_identity_mismatch");
      if (WorkflowIdSchema.parse(text(task, "workflow") ?? "standard") !== "competing_plans") throw new Error("planner_pair_requires_combined_workflow");
      const [a, b] = input.planners;
      if (a.role !== "planner_a" || b.role !== "planner_b" || a.input.role !== a.role || b.input.role !== b.role || a.input.plannerPairId !== input.pairId || b.input.plannerPairId !== input.pairId || !sameRange(a.input.range, b.input.range) || a.input.evidenceDirectory !== b.input.evidenceDirectory || a.input.evidenceSha256 !== b.input.evidenceSha256) throw new Error("invalid_planner_pair");
      if (db.prepare("SELECT 1 FROM forge_task_sessions s WHERE s.task_id = ? AND s.kind = 'worker' AND s.is_current = 1 AND (s.launch_owner IS NOT NULL AND s.stopped_at IS NULL OR s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL OR EXISTS (SELECT 1 FROM forge_task_turns t WHERE t.session_id = s.id AND t.generation = s.generation AND t.status IN ('pending_prompt', 'prompted', 'unknown')))").get(input.taskId)) throw new Error("worker_already_assigned");
      db.prepare("UPDATE forge_task_sessions SET is_current = 0, updated_at = ? WHERE task_id = ? AND kind = 'worker' AND is_current = 1 AND delegate_slot IN ('planner_a', 'planner_b')").run(time, input.taskId);
      const latest = db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker'").get(input.taskId) as Row;
      const advisorProfiles = z.partialRecord(AdvisorRoleSchema, TaskProfileSchema).parse(JSON.parse(text(task, "advisor_profiles_json") ?? "{}"));
      const sessions = input.planners.map((planner, index) => {
        const id = randomUUID(); const generation = integer(latest, "generation") + index + 1;
        const profile = advisorProfiles[planner.role] ?? TaskProfileSchema.parse(JSON.parse(text(task, "root_profile_json")!));
        db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, pane_id, native_session_id, lifecycle, assignment_hash, advisor_role, delegate_slot, workflow_input_json, profile_json, created_at, updated_at) VALUES (?, ?, 'worker', ?, 1, NULL, NULL, 'reserved', ?, ?, ?, ?, ?, ?, ?)").run(id, input.taskId, generation, hash(planner.prompt), planner.role, planner.role, JSON.stringify(planner.input), JSON.stringify(profile), time, time);
        db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(createOpenCodeMessageID(), input.taskId, id, generation, hash(planner.prompt), hash(planner.prompt), planner.prompt, time, time);
        return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
      }) as [TaskSession, TaskSession];
      db.prepare("UPDATE forge_task_controls SET worker_session_id = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(sessions[0].id, time, input.taskId);
      return sessions;
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
  markPrompted(input: { turnId: string; generation: number }): void { markPrompted(this.database, input, now); }
  pendingTurns(sessionId: string): TaskTurn[] { return pendingTurns(this.database, sessionId); }
  /** Completes the delegate turn, appends a Reviewer/Rater record from its immutable turn input, and wakes Coordinator once. */
  recordWorkerResultAndWake(input: { taskId: string; sessionId: string; generation: number; receiptId: string; observation: string; nativeTurnId?: string; review?: { result: ReviewerResult | RaterResult | null; invalidReason: string | null }; wakePrompt?: string }): { kind: "recorded"; wake: TaskTurn | null } | { kind: "duplicate" } {
    return this.database.authTransaction((db) => {
      const workerTurn = db.prepare("SELECT * FROM forge_task_turns WHERE task_id = ? AND session_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.sessionId, input.generation) as Row | undefined;
      const workerRow = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ? AND kind = 'worker' AND is_current = 1 AND generation = ? AND lifecycle <> 'cancelled'").get(input.sessionId, input.generation) as Row | undefined;
      if (!workerTurn || !workerRow || TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "cancelled") throw new Error("stale_generation");
      if (TaskTurnStatusSchema.parse(text(workerTurn, "status")) === "completed") { if (text(workerTurn, "result_receipt_id") === input.receiptId) return { kind: "duplicate" }; throw new Error("stale_receipt"); }
      const worker = session(workerRow);
      const root = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND is_current = 1").get(input.taskId) as Row | undefined;
      if (!root) throw new Error("root_notification_unavailable");
      const time = now();
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
      const pairId = workflowInput?.kind === "advisor" ? workflowInput.plannerPairId : undefined;
      if (pairId) {
        db.prepare("UPDATE forge_task_sessions SET lifecycle = 'stopped', stop_requested_at = ?, updated_at = ? WHERE id = ? AND generation = ? AND is_current = 1").run(time, time, input.sessionId, input.generation);
        const pair = (db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker' AND is_current = 1 AND json_extract(workflow_input_json, '$.plannerPairId') = ? ORDER BY CASE advisor_role WHEN 'planner_a' THEN 0 ELSE 1 END").all(input.taskId, pairId) as Row[]).map(session);
        const complete = pair.length === 2 && pair.every(member => db.prepare("SELECT 1 FROM forge_task_turns WHERE session_id = ? AND generation = ? AND status = 'completed'").get(member.id, member.generation));
        if (!complete) return { kind: "recorded", wake: null };
        const reports = pair.map(member => ({ id: member.id, role: member.advisorRole, observation: db.prepare("SELECT terminal_observation FROM forge_task_turns WHERE session_id = ? AND generation = ? AND status = 'completed'").get(member.id, member.generation) as Row })).map(({ id, role, observation }) => ({ id, role, observation: text(observation, "terminal_observation") }));
        const valid = reports.every(report => turnOutcome(report.observation).advisor?.result !== null && turnOutcome(report.observation).advisor?.result !== undefined);
        const next = valid ? "Both reports are valid. Reconcile them into one plan, then delegate Worker with those IDs." : "One or both reports are invalid. Retry only each invalid planner role with delegate_advisor, then reconcile a valid Plan A and Plan B. Do not delegate Worker until both reports are valid.";
        const promptText = `Combined planning pair ${pairId} completed. Plan A session ${reports[0]!.id} and Plan B session ${reports[1]!.id} are ordered candidateSessionIds. Read both full observations and their validation outcomes. ${next}\n\nPlan A:\n${reports[0]!.observation}\n\nPlan B:\n${reports[1]!.observation}`;
        const wakeId = createOpenCodeMessageID();
        db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(wakeId, input.taskId, text(root, "id"), integer(root, "generation"), hash(promptText), promptText, time, time);
        db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(time, time, input.taskId);
        return { kind: "recorded", wake: turn(db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(wakeId) as Row) };
      }
      const wakeId = createOpenCodeMessageID(); const promptText = input.wakePrompt ?? `Worker result receipt ${input.receiptId}. ${STANDARD_WORKER_RESULT_WAKE}\n\n${input.observation}`; const promptHash = hash(promptText);
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, result_receipt_id, terminal_observation, created_at, prompted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending_prompt', NULL, NULL, ?, NULL, NULL, ?)").run(wakeId, input.taskId, text(root, "id"), integer(root, "generation"), promptHash, promptText, time, time);
      db.prepare("UPDATE forge_task_controls SET wake_at = ?, updated_at = ? WHERE task_id = ?").run(time, time, input.taskId);
      return { kind: "recorded", wake: turn(db.prepare("SELECT * FROM forge_task_turns WHERE id = ?").get(wakeId) as Row) };
    });
  }
  /** Replaces one invalid retained Advisor outcome after native evidence, task evidence, and source range have been revalidated. */
  reconcileAdvisorResult(input: { taskId: string; sessionId: string; turnId: string; result: AdvisorResult }): void {
    this.database.authTransaction((db) => {
      const sessionRow = db.prepare("SELECT * FROM forge_task_sessions WHERE id = ? AND task_id = ? AND kind = 'worker'").get(input.sessionId, input.taskId) as Row | undefined;
      const turnRow = db.prepare("SELECT * FROM forge_task_turns WHERE id = ? AND task_id = ? AND session_id = ? AND status = 'completed'").get(input.turnId, input.taskId, input.sessionId) as Row | undefined;
      if (!sessionRow || !turnRow) throw new Error("advisor_turn_not_found");
      const advisor = session(sessionRow);
      const workflowInput = parseJson(text(turnRow, "workflow_input_json"), WorkflowInputSchema) ?? advisor.workflowInput;
      if (!advisor.advisorRole || workflowInput?.kind !== "advisor" || workflowInput.role !== advisor.advisorRole || input.result.role !== advisor.advisorRole) throw new Error("advisor_role_mismatch");
      const previous = turnOutcome(text(turnRow, "terminal_observation"));
      if (previous.advisor?.result) throw new Error("advisor_result_already_valid");
      const observation: unknown = JSON.parse(text(turnRow, "terminal_observation") ?? "null");
      const base = z.record(z.string(), z.unknown()).parse(observation);
      db.prepare("UPDATE forge_task_turns SET terminal_observation = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...base, advisor: { role: advisor.advisorRole, result: input.result, invalidReason: null } }), now(), input.turnId);
      if (advisor.advisorRole === "reviewer" || advisor.advisorRole === "rater") {
        const state = this.workflowStateRow(db, input.taskId);
        const index = state.reviews.findIndex(review => review.sessionId === input.sessionId && review.turnId === input.turnId && review.role === advisor.advisorRole);
        if (index < 0 || state.reviews[index]!.result) throw new Error("advisor_review_not_reconcilable");
        const review = state.reviews[index]!;
        state.reviews[index] = advisor.advisorRole === "reviewer"
          ? { ...review, role: "reviewer", result: ReviewerResultSchema.parse(input.result), invalidReason: null }
          : { ...review, role: "rater", result: RaterResultSchema.parse(input.result), invalidReason: null };
        this.writeWorkflowState(db, input.taskId, state);
      }
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
    if (!this.setHumanQuestion(taskId, question, options)) throw new Error("task_not_active");
  }
  askHumanForRoot(root: { taskId: string; sessionId: string; generation: number }, question: string, options: HumanQuestionOptions = []): boolean {
    return this.setHumanQuestion(root.taskId, question, options, root);
  }
  private setHumanQuestion(taskId: string, question: string, options: HumanQuestionOptions, root?: { sessionId: string; generation: number }): boolean {
    if (!question.trim()) throw new Error("question_is_empty");
    const owner = root ? " AND root_session_id = ? AND EXISTS (SELECT 1 FROM forge_task_sessions s WHERE s.id = ? AND s.task_id = forge_task_controls.task_id AND s.kind = 'root' AND s.generation = ? AND s.is_current = 1 AND s.lifecycle <> 'cancelled')" : "";
    const changed = this.database.authTransaction((db) => db.prepare(`UPDATE forge_task_controls SET status = 'waiting_human', human_question = ?, human_question_options_json = ?, human_question_id = ?, limit_pause_json = NULL, wake_at = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ? WHERE task_id = ? AND status = 'active'${owner}`).run(question.trim(), JSON.stringify(HumanQuestionOptionsSchema.parse(options)), randomUUID(), now(), taskId, ...(root ? [root.sessionId, root.sessionId, root.generation] : [])).changes);
    if (changed === 1) this.observeLifecycle(taskId);
    return changed === 1;
  }
  requireExecutionCleanup(turn: TaskTurn): void {
    this.database.authTransaction(db => {
      const current = db.prepare("SELECT 1 FROM forge_task_sessions s JOIN forge_task_controls c ON c.task_id = s.task_id WHERE s.id = ? AND s.generation = ? AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active' AND (s.kind = 'worker' OR c.root_session_id = s.id)").get(turn.sessionId, turn.generation);
      if (!current) return;
      this.askHuman(turn.taskId, "The agent stopped during a tool call. A command can still be active in the worktree. Stop those commands before you continue. Describe what you checked, then confirm that all commands from this session have stopped.");
      db.prepare("UPDATE forge_task_controls SET recovery_turn_id = ? WHERE task_id = ?").run(turn.id, turn.taskId);
    });
  }
  replaceWorker(taskId: string, request: WorkerReplacementRequest): TaskSession { return replaceWorker(this.database, taskId, WorkerReplacementRequestSchema.parse(request)); }
  selectTaskAgent(taskId: string, raw: TaskAgentSelectionRequest): TaskSession | null {
    const request = TaskAgentSelectionRequestSchema.parse(raw);
    if (request.role !== "root") {
      return selectDelegate(this.database, taskId, request, initialCoordinatorPrompt(this.get(taskId), this.context(taskId), this.dependencySummaries(taskId)));
    }
    if (!request.expectedSessionId) {
      const initialPrompt = initialCoordinatorPrompt(this.get(taskId), this.context(taskId), this.dependencySummaries(taskId));
      return this.database.authImmediateTransaction(db => {
        const row = db.prepare("SELECT c.*, t.archived_at, t.configuration_json FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id WHERE c.task_id = ?").get(taskId) as Row | undefined;
        if (!row || row.archived_at !== null || !["active", "waiting_human"].includes(String(row.status))) throw new Error("The Coordinator changed. Read the current Coordinator before selecting another.");
        const state = WorkflowStateSchema.parse(JSON.parse(String(row.workflow_state_json)));
        const intent = AgentSelectionIntentSchema.parse({ role: "root", expectedProfileId: request.expectedProfileId, expectedSessionId: null, profileId: request.profileId, direction: request.direction, resume: request.resume, questionId: request.resume ? request.questionId : null });
        if (state.agentSelections?.root && JSON.stringify(state.agentSelections.root) === JSON.stringify(intent) && row.root_session_id === state.initialRootSelectionSessionId) return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ? AND is_current = 1").get(row.root_session_id) as Row);
        if (row.root_session_id !== null || TaskProfileSchema.parse(JSON.parse(String(row.root_profile_json))).profileId !== request.expectedProfileId) throw new Error("The Coordinator changed. Read the current Coordinator before selecting another.");
        if (request.resume && (row.status !== "waiting_human" || row.human_question_id !== request.questionId || row.limit_pause_json !== null || row.recovery_turn_id !== null)) throw new Error("Answer the current task decision before resuming.");
        const selected = db.prepare("SELECT p.id AS profileId, p.provider, p.model, p.reasoning_level AS reasoningLevel, p.service_tier AS serviceTier, p.provider_instance_id AS providerInstanceId, i.home_directory AS instanceHomeDirectory FROM forge_profiles p LEFT JOIN forge_provider_instances i ON i.id = p.provider_instance_id WHERE p.id = ? AND p.role = 'root' AND p.archived_at IS NULL").get(request.profileId);
        if (!selected) throw new Error("The selected Coordinator profile does not exist.");
        const profile = TaskProfileSchema.parse(selected);
        assertProfileAllowed(TaskConfigurationSchema.pick({ providerPolicy: true }).strip().parse(JSON.parse(String(row.configuration_json))).providerPolicy, profile);
        const time = now(); const id = randomUUID();
        const generation = Number((db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM forge_task_sessions WHERE task_id = ? AND kind = 'root'").get(taskId) as Row).generation) + 1;
        db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, lifecycle, profile_json, created_at, updated_at) VALUES (?, ?, 'root', ?, 1, 'reserved', ?, ?, ?)").run(id, taskId, generation, JSON.stringify(profile), time, time);
        db.prepare("UPDATE forge_task_controls SET root_session_id = ?, root_profile_json = ?, workflow_state_json = ?, status = CASE WHEN ? THEN 'active' ELSE status END, status_changed_at = CASE WHEN ? THEN ? ELSE status_changed_at END, human_question = CASE WHEN ? THEN NULL ELSE human_question END, human_question_id = CASE WHEN ? THEN NULL ELSE human_question_id END, human_question_options_json = CASE WHEN ? THEN '[]' ELSE human_question_options_json END, wake_at = CASE WHEN ? OR status = 'active' THEN ? ELSE wake_at END, updated_at = ? WHERE task_id = ?").run(id, JSON.stringify(profile), JSON.stringify({ ...state, agentSelections: { ...state.agentSelections, root: intent }, initialRootSelectionSessionId: id }), request.resume ? 1 : 0, request.resume ? 1 : 0, time, request.resume ? 1 : 0, request.resume ? 1 : 0, request.resume ? 1 : 0, request.resume ? 1 : 0, time, time, taskId);
        const prompt = `${initialPrompt}${request.direction ? `\n\nAdditional direction from the user:\n${request.direction}` : ""}`;
        db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?)").run(createOpenCodeMessageID(), taskId, id, generation, hash(prompt), prompt, time, time);
        if (request.direction || row.human_question) {
          const note = `Human note:\n${[request.direction ? `Additional direction from the user:\n${request.direction}` : "", row.human_question ? `Question ${row.human_question_id} remains unanswered: ${row.human_question}\nOptions: ${row.human_question_options_json ?? '[]'}` : ""].filter(Boolean).join("\n\n")}`;
          db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?)").run(createOpenCodeMessageID(), taskId, id, generation, hash(note), note, time, time);
        }
        return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
      });
    }
    if (this.get(taskId).rootSessionId === request.expectedSessionId && this.get(taskId).rootProfile.profileId !== request.expectedProfileId) throw new Error("The Coordinator changed. Read the current Coordinator before selecting another.");
    return this.replaceCoordinator(taskId, request.resume
      ? { sessionId: request.expectedSessionId, rootProfileId: request.profileId, handoff: request.direction, resume: true, questionId: request.questionId }
      : { sessionId: request.expectedSessionId, rootProfileId: request.profileId, handoff: request.direction, resume: false });
  }
  replaceCoordinator(taskId: string, request: CoordinatorReplacementRequest): TaskSession {
    const prompt = initialCoordinatorPrompt(this.get(taskId), this.context(taskId), this.dependencySummaries(taskId));
    return replaceCoordinator(this.database, taskId, CoordinatorReplacementRequestSchema.parse(request), prompt);
  }
  workerReplacementReady(sessionId: string): boolean { return workerReplacementReady(this.database, sessionId); }

  cancel(taskId: string): void {
    this.database.authTransaction((db) => {
      const changed = db.prepare("UPDATE forge_task_controls SET status = 'cancelled', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ? WHERE task_id = ? AND status <> 'delivered'").run(now(), taskId).changes;
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

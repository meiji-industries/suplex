import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ForgeDatabase } from "../../platform/database.js";
import { readEnvironmentSettings } from "../../platform/environment-settings.js";
import { createOpenCodeMessageID } from "../../runtimes/opencode/session.js";
import { PromptDispatchAttemptSchema } from "../control.js";
import { evaluateTaskLimits, TaskLimitDecisionSchema, TaskLimitPauseSchema, taskLimitQuestion, type TaskLimitDecision, type TaskLimits, type TaskLimitUsage } from "./limits.js";
import { TaskUsageSchema, type TaskUsage } from "../usage.js";

const PersistedLimitsSchema = z.object({ status: z.string(), budgetUsd: z.number().finite().nonnegative().nullable(), maxTurns: z.number().int().nonnegative().nullable() });

export class TaskLimitStore {
  constructor(private readonly database: ForgeDatabase) {}

  read(taskId: string): TaskLimits {
    const row = this.database.authQuery(db => db.prepare("SELECT status, budget_usd AS budgetUsd, max_turns AS maxTurns FROM forge_task_controls WHERE task_id = ?").get(taskId));
    if (!row) throw new Error(`Task ${taskId} does not exist`);
    const persisted = PersistedLimitsSchema.parse(row);
    const defaults = readEnvironmentSettings(this.database);
    return { budgetUsd: persisted.budgetUsd ?? defaults.defaultBudgetUsd, maxTurns: persisted.maxTurns ?? defaults.defaultMaxTurns };
  }

  replaceUsage(taskId: string, usage: TaskUsage[]): void {
    const parsed = usage.map(entry => TaskUsageSchema.parse(entry));
    this.database.authTransaction(db => {
      const rows = z.array(z.object({ nativeSessionId: z.string() })).parse(db.prepare("SELECT native_session_id AS nativeSessionId FROM forge_task_sessions WHERE task_id = ? AND native_session_id IS NOT NULL").all(taskId));
      const nativeSessionIds = new Set(rows.map(row => row.nativeSessionId));
      if (parsed.some(entry => !nativeSessionIds.has(entry.sessionId))) throw new Error("Native usage does not match a task session");
      db.prepare("DELETE FROM forge_task_usage WHERE task_id = ?").run(taskId);
      const insert = db.prepare("INSERT INTO forge_task_usage (task_id, session_id, message_id, snapshot, observed_at) VALUES (?, ?, ?, ?, ?)");
      const observedAt = new Date().toISOString();
      for (const entry of parsed) insert.run(taskId, entry.sessionId, entry.messageId, JSON.stringify(entry), observedAt);
    });
  }

  pauseIfReached(taskId: string, usage: TaskLimitUsage): boolean {
    return this.database.authImmediateTransaction(db => {
      const raw = db.prepare("SELECT status, budget_usd AS budgetUsd, max_turns AS maxTurns FROM forge_task_controls WHERE task_id = ?").get(taskId);
      if (!raw) return false;
      const row = PersistedLimitsSchema.parse(raw);
      if (row.status !== "active") return false;
      const defaults = readEnvironmentSettings(this.database);
      const limits = { budgetUsd: row.budgetUsd ?? defaults.defaultBudgetUsd, maxTurns: row.maxTurns ?? defaults.defaultMaxTurns };
      const admittedTurns = z.object({ turns: z.number().int().nonnegative() }).parse(db.prepare("SELECT COUNT(*) AS turns FROM forge_task_turns WHERE task_id = ? AND prompted_at IS NOT NULL").get(taskId)).turns;
      const evaluation = evaluateTaskLimits({ limits, usage: { ...usage, admittedTurns }, allowance: { budgetUsd: defaults.defaultBudgetUsd, maxTurns: defaults.defaultMaxTurns } });
      if (evaluation.kind === "within_limits") return false;
      const pause = evaluation.pause;
      db.prepare("UPDATE forge_task_controls SET status = 'waiting_human', limit_pause_json = ?, human_question = ?, human_question_options_json = '[]', human_question_id = ?, wake_at = NULL, updated_at = ? WHERE task_id = ? AND status = 'active'").run(JSON.stringify(pause), taskLimitQuestion(pause), randomUUID(), new Date().toISOString(), taskId);
      return true;
    });
  }

  answer(taskId: string, questionId: string, rawDecision: TaskLimitDecision): void {
    const decision = TaskLimitDecisionSchema.parse(rawDecision);
    this.database.authImmediateTransaction(db => {
      const raw = db.prepare("SELECT human_question AS humanQuestion, limit_pause_json AS pause, root_session_id AS rootSessionId FROM forge_task_controls WHERE task_id = ? AND status = 'waiting_human' AND human_question_id = ?").get(taskId, questionId);
      if (!raw) throw new Error("question_identity_mismatch");
      const row = z.object({ humanQuestion: z.string(), pause: z.string(), rootSessionId: z.string().nullable() }).parse(raw);
      const pause = TaskLimitPauseSchema.parse(JSON.parse(row.pause));
      const time = new Date().toISOString();
      if (decision.kind === "cancel_task") {
        db.prepare("UPDATE forge_task_controls SET status = 'cancelled', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ? WHERE task_id = ?").run(time, taskId);
        db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = COALESCE(stop_requested_at, ?), updated_at = ? WHERE task_id = ? AND stopped_at IS NULL").run(time, time, taskId);
        db.prepare("UPDATE forge_task_turns SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status IN ('pending_prompt', 'prompted', 'unknown')").run(time, taskId);
        return;
      }
      const root = z.object({ id: z.string(), generation: z.number().int() }).parse(db.prepare("SELECT id, generation FROM forge_task_sessions WHERE id = ? AND task_id = ? AND kind = 'root' AND is_current = 1 AND lifecycle <> 'cancelled'").get(row.rootSessionId, taskId));
      const limits = decision.kind === "add_allowance" ? pause.proposedLimits : decision.limits;
      const prompt = JSON.stringify({ question: row.humanQuestion, decision });
      const promptHash = createHash("sha256").update(prompt).digest("hex");
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?)").run(createOpenCodeMessageID(), taskId, root.id, root.generation, promptHash, prompt, time, time);
      db.prepare("UPDATE forge_task_controls SET status = 'active', budget_usd = ?, max_turns = ?, limit_pause_json = NULL, human_question = NULL, human_question_id = NULL, human_question_options_json = '[]', wake_at = ?, updated_at = ? WHERE task_id = ?").run(limits.budgetUsd, limits.maxTurns, time, time, taskId);
    });
  }

  claimPrompt(input: { taskId: string; turnId: string; serverGeneration: string; owner: string; usage: TaskLimitUsage }): boolean {
    const attempt = PromptDispatchAttemptSchema.parse({ serverGeneration: input.serverGeneration, claimedAt: new Date().toISOString() });
    return this.database.authImmediateTransaction(db => {
      const raw = db.prepare("SELECT status, budget_usd AS budgetUsd, max_turns AS maxTurns FROM forge_task_controls WHERE task_id = ?").get(input.taskId);
      if (!raw) return false;
      const row = PersistedLimitsSchema.parse(raw);
      if (row.status !== "active") return false;
      const defaults = readEnvironmentSettings(this.database);
      const allowance = { budgetUsd: defaults.defaultBudgetUsd, maxTurns: defaults.defaultMaxTurns };
      const limits = { budgetUsd: row.budgetUsd ?? allowance.budgetUsd, maxTurns: row.maxTurns ?? allowance.maxTurns };
      const admittedTurns = z.object({ turns: z.number().int().nonnegative() }).parse(db.prepare("SELECT COUNT(*) AS turns FROM forge_task_turns WHERE task_id = ? AND prompted_at IS NOT NULL").get(input.taskId)).turns;
      const reservations = z.object({ turns: z.number().int().nonnegative() }).parse(db.prepare("SELECT COUNT(*) AS turns FROM forge_task_turns WHERE task_id = ? AND status = 'unknown' AND prompted_at IS NULL").get(input.taskId)).turns;
      const evaluation = evaluateTaskLimits({ limits, usage: { ...input.usage, admittedTurns }, allowance });
      if (evaluation.kind === "limit_reached") {
        const pause = evaluation.pause;
        db.prepare("UPDATE forge_task_controls SET status = 'waiting_human', limit_pause_json = ?, human_question = ?, human_question_options_json = '[]', human_question_id = ?, wake_at = NULL, updated_at = ? WHERE task_id = ? AND status = 'active'").run(JSON.stringify(pause), taskLimitQuestion(pause), randomUUID(), new Date().toISOString(), input.taskId);
        return false;
      }
      if (limits.maxTurns > 0 && admittedTurns + reservations >= limits.maxTurns) return false;
      return db.prepare("UPDATE forge_task_turns SET status = 'unknown', dispatch_attempt_json = ?, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'pending_prompt' AND EXISTS (SELECT 1 FROM forge_task_sessions s JOIN forge_task_controls c ON c.task_id = s.task_id WHERE s.id = forge_task_turns.session_id AND s.generation = forge_task_turns.generation AND s.launch_owner = ? AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')").run(JSON.stringify(attempt), attempt.claimedAt, input.turnId, input.taskId, input.owner).changes === 1;
    });
  }
}

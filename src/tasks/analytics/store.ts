import { z } from "zod";
import type { ForgeDatabase } from "../../platform/database.js";
import type { Task } from "../contracts.js";
import { TaskUsageSchema, type TaskUsage } from "../usage.js";

export const AnalyticsEventSchema = z.object({ status: z.string(), questionId: z.string().nullable(), observedAt: z.string() });
export const AnalyticsSessionSchema = z.object({ sessionId: z.string(), observedAt: z.string().nullable(), errorAt: z.string().nullable() });

export class TaskAnalyticsStore {
  constructor(private readonly database: ForgeDatabase) {}

  record(taskId: string, sessionId: string, usage: TaskUsage[], at = new Date().toISOString()): void {
    this.database.authTransaction(() => this.database.authQuery(db => {
      const row = db.prepare("SELECT native_session_id AS nativeSessionId FROM forge_task_sessions WHERE id = ? AND task_id = ?").get(sessionId, taskId);
      const nativeSessionId = usage[0]?.sessionId ?? z.object({ nativeSessionId: z.string().nullable() }).safeParse(row).data?.nativeSessionId;
      if (!usage.length && nativeSessionId && db.prepare("SELECT 1 FROM forge_task_usage WHERE task_id = ? AND session_id = ? LIMIT 1").get(taskId, nativeSessionId)) throw new Error("Native usage has no completed observations");
      if (nativeSessionId) db.prepare("DELETE FROM forge_task_usage WHERE task_id = ? AND session_id = ?").run(taskId, nativeSessionId);
      const statement = db.prepare(`INSERT INTO forge_task_usage (task_id, session_id, message_id, snapshot, observed_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, message_id) DO UPDATE SET snapshot = excluded.snapshot, observed_at = excluded.observed_at`);
      for (const entry of usage) statement.run(taskId, entry.sessionId, entry.messageId, JSON.stringify(entry), at);
      db.prepare(`INSERT INTO forge_task_analytics_sessions (session_id, task_id, observed_at, error_at) VALUES (?, ?, ?, NULL)
        ON CONFLICT(session_id) DO UPDATE SET observed_at = excluded.observed_at, error_at = NULL`).run(sessionId, taskId, at);
    }));
  }

  failed(taskId: string, sessionId: string, at = new Date().toISOString()): void {
    this.database.authQuery(db => db.prepare(`INSERT INTO forge_task_analytics_sessions (session_id, task_id, error_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET error_at = excluded.error_at`).run(sessionId, taskId, at));
  }

  observe(task: Pick<Task, "id" | "status"> & { humanQuestion: { id: string } | null }, at = new Date().toISOString()): void {
    this.database.authQuery(db => {
      const prior = db.prepare("SELECT status, question_id AS questionId, observed_at AS observedAt FROM forge_task_analytics_events WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(task.id);
      const last = prior ? AnalyticsEventSchema.parse(prior) : null;
      const questionId = task.humanQuestion?.id ?? null;
      if (last?.status === task.status && last.questionId === questionId) return;
      db.prepare("INSERT INTO forge_task_analytics_events (task_id, status, question_id, observed_at) VALUES (?, ?, ?, ?)").run(task.id, task.status, questionId, at);
    });
  }

  read(taskId: string) {
    return this.database.authQuery(db => ({
      usage: db.prepare("SELECT snapshot FROM forge_task_usage WHERE task_id = ?").all(taskId).map(row => TaskUsageSchema.parse(JSON.parse(z.object({ snapshot: z.string() }).parse(row).snapshot))),
      sessions: z.array(AnalyticsSessionSchema).parse(db.prepare("SELECT session_id AS sessionId, observed_at AS observedAt, error_at AS errorAt FROM forge_task_analytics_sessions WHERE task_id = ?").all(taskId)),
      events: z.array(AnalyticsEventSchema).parse(db.prepare("SELECT status, question_id AS questionId, observed_at AS observedAt FROM forge_task_analytics_events WHERE task_id = ? ORDER BY id").all(taskId)),
    }));
  }

  sessionObservations(taskId: string) {
    return this.database.authQuery(db => z.array(AnalyticsSessionSchema).parse(db.prepare("SELECT session_id AS sessionId, observed_at AS observedAt, error_at AS errorAt FROM forge_task_analytics_sessions WHERE task_id = ?").all(taskId)));
  }
}

import type { TaskAnalytics } from "./task-analytics-contracts.js";
import type { TaskAnalyticsStore } from "./task-analytics-store.js";
import type { Task } from "./task-contracts.js";
import type { TaskSession } from "./task-control.js";

export function taskAnalytics(task: Task, sessions: TaskSession[], data: ReturnType<TaskAnalyticsStore["read"]>, now = Date.now()): TaskAnalytics {
  const events = data.events;
  const observedAt = data.sessions.flatMap(session => session.observedAt ? [session.observedAt] : []).sort().at(-1) ?? null;
  let observedWaitMs = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event?.status !== "waiting_human") continue;
    const next = events[i + 1];
    const end = next ? Date.parse(next.observedAt) : Math.min(now, Date.parse(observedAt ?? event.observedAt));
    observedWaitMs += Math.max(0, end - Date.parse(event.observedAt));
  }
  const historyStartsAtCreation = events[0] && Math.abs(Date.parse(events[0].observedAt) - Date.parse(task.createdAt)) < 1000;
  const start = historyStartsAtCreation || events[0]?.status === "backlog" ? events.find(event => event.status === "active") : undefined;
  const delivered = start ? events.find(event => event.status === "delivered" && event.observedAt >= start.observedAt) : null;
  return {
    id: task.id, title: task.title, issueKey: task.issueKey ?? null, projectId: task.projectId,
    status: task.status, deliveryTarget: task.deliveryTarget, archived: task.archivedAt !== null, createdAt: task.createdAt,
    usage: data.usage, sessions: new Set([...sessions.filter(session => session.nativeSessionId !== null).map(session => session.id), ...data.sessions.map(session => session.sessionId)]).size,
    observedSessions: data.sessions.filter(session => session.observedAt !== null).length,
    staleSessions: data.sessions.filter(session => session.errorAt !== null).length,
    observedAt, observationStartedAt: events[0]?.observedAt ?? null,
    questions: new Set(events.flatMap(event => event.questionId ? [event.questionId] : [])).size,
    observedWaitMs,
    deliveryMs: start && delivered ? Math.max(0, Date.parse(delivered.observedAt) - Date.parse(start.observedAt)) : null,
  };
}

import { dirname, join } from "node:path";
import type { Task } from "./task-contracts.js";
import type { TaskSession } from "./task-control.js";
import { OpenCodeClient } from "./opencode-client.js";
import { readOpenCodeServer } from "./opencode-server.js";
import type { TaskTimeline, TimelineTask } from "./task-timeline-contracts.js";
import { taskUsage, type TaskUsage } from "./task-usage.js";

export function timelineActivity(task: Pick<Task, "rootProfile" | "workerProfile">, session: Pick<TaskSession, "id" | "kind" | "generation">, usage: TaskUsage[], liveMessageId: string | null): TimelineTask["activity"] {
  const profile = session.kind === "root" ? task.rootProfile : task.workerProfile;
  const turns = new Map<string, TimelineTask["activity"][number]>();
  const ordered = [...usage].sort((left, right) => left.startedAt - right.startedAt);
  for (const entry of ordered) {
    const live = !entry.failed && entry.completedAt === null && entry.messageId === liveMessageId && entry === ordered.at(-1);
    if (entry.completedAt === null && !live) {
      const previous = turns.get(entry.turnId);
      if (previous && previous.status !== "failed") previous.status = entry.failed ? "failed" : "interrupted";
      continue;
    }
    const start = new Date(entry.startedAt).toISOString();
    const end = live ? null : new Date(Math.max(entry.startedAt, entry.completedAt ?? entry.startedAt)).toISOString();
    const previous = turns.get(entry.turnId);
    turns.set(entry.turnId, {
      id: `${session.id}:${entry.turnId}`, role: session.kind, agentId: `${session.kind}:${profile.profileId}`,
      agentName: profile.model, avatarSeed: profile.profileId,
      status: entry.failed || previous?.status === "failed" ? "failed" : live ? "running" : "completed",
      attempt: session.generation,
      startedAt: previous && previous.startedAt < start ? previous.startedAt : start,
      finishedAt: previous?.finishedAt === null || end === null ? null : previous && previous.finishedAt > end ? previous.finishedAt : end,
    });
  }
  return [...turns.values()];
}

export async function observeTimelineSession(databasePath: string, session: TaskSession) {
  const server = await readOpenCodeServer(join(dirname(databasePath), "runtime", "task-sessions", session.id));
  if (!server || !session.nativeSessionId) throw new Error("Session is not available");
  const client = new OpenCodeClient({ baseUrl: server.baseUrl, password: server.password, timeoutMs: 2000 });
  const [messages, statuses] = await Promise.all([
    client.getMessages(session.nativeSessionId, { directory: server.directory, limit: 100 }),
    client.getStatus(server.directory),
  ]);
  const latest = [...messages].sort((a, b) => a.info.time.created - b.info.time.created).at(-1)?.info;
  const liveMessageId = statuses[session.nativeSessionId]?.type === "busy" && latest?.role === "assistant" && latest.time.completed === undefined ? latest.id : null;
  return { usage: taskUsage(messages, session.kind), liveMessageId };
}

export async function readTaskTimeline(databasePath: string, tasks: Task[], sessions: TaskSession[], readUsage: (taskId: string) => TaskUsage[], observe = observeTimelineSession): Promise<TaskTimeline> {
  const result: TaskTimeline = { tasks: [], unavailableSessions: 0 };
  for (const task of tasks) {
    const target: TimelineTask = { id: task.id, projectId: task.projectId, issueKey: task.issueKey ?? null, title: task.title, activity: [] };
    const stored = readUsage(task.id);
    for (const session of sessions.filter(session => session.taskId === task.id && session.nativeSessionId)) {
      const usage = new Map(stored.filter(entry => entry.sessionId === session.nativeSessionId).map(entry => [entry.messageId, entry]));
      let liveMessageId: string | null = null;
      if (!task.archivedAt && ["active", "waiting_human"].includes(task.status) && session.current && ["live", "unknown"].includes(session.lifecycle)) {
        try {
          const current = await observe(databasePath, session);
          for (const entry of current.usage) usage.set(entry.messageId, entry);
          liveMessageId = current.liveMessageId;
        } catch { result.unavailableSessions += 1; }
      }
      target.activity.push(...timelineActivity(task, session, [...usage.values()], liveMessageId));
    }
    result.tasks.push(target);
  }
  return result;
}

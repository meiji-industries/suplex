import type { Task } from "../contracts.js";
import type { TaskSession } from "../control.js";
import { nativeSessionReader } from "../../runtimes/task-harness-registry.js";
import type { TaskTimeline, TimelineTask } from "./contracts.js";
import type { TaskUsage } from "../usage.js";
import { roleLabel } from "../../coordination/workflows.js";

export function timelineActivity(task: Pick<Task, "rootProfile" | "workerProfile"> & Partial<Pick<Task, "advisorProfiles">>, session: Pick<TaskSession, "id" | "kind" | "generation"> & Partial<Pick<TaskSession, "advisorRole">>, usage: TaskUsage[], liveMessageId: string | null): TimelineTask["activity"] {
  const advisorRole = session.advisorRole ?? null;
  // Advisors keep the worker slot for usage totals but show their actual role and captured profile.
  const profile = session.kind === "root" ? task.rootProfile : advisorRole ? task.advisorProfiles?.[advisorRole] ?? task.rootProfile : task.workerProfile;
  const roleKey = advisorRole ?? session.kind;
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
      id: `${session.id}:${entry.turnId}`, role: session.kind, advisorRole, label: roleLabel({ kind: session.kind, advisorRole }), agentId: `${roleKey}:${profile.profileId}`,
      agentName: profile.model, avatarSeed: profile.profileId,
      status: entry.failed || previous?.status === "failed" ? "failed" : live ? "running" : "completed",
      attempt: session.generation,
      startedAt: previous && previous.startedAt < start ? previous.startedAt : start,
      finishedAt: previous?.finishedAt === null || end === null ? null : previous && previous.finishedAt > end ? previous.finishedAt : end,
    });
  }
  return [...turns.values()];
}

const observeTimelineSession = (databasePath: string, session: TaskSession): Promise<{ usage: TaskUsage[]; liveMessageId: string | null }> => nativeSessionReader(databasePath, session).timeline(session);

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

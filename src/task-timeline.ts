import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Task } from "./task-contracts.js";
import type { TaskSession } from "./task-control.js";
import type { OpenCodeMessageEnvelope } from "./opencode-contracts.js";
import { resolveOpenCodeExecutable } from "./opencode-executable.js";
import { ensureOpenCodeServer, openCodeServerClient, readOpenCodeServer, stopOpenCodeServer } from "./opencode-server.js";
import type { TaskTimeline, TimelineTask } from "./task-timeline-contracts.js";

export function timelineActivity(task: Pick<Task, "rootProfile" | "workerProfile">, session: Pick<TaskSession, "id" | "kind" | "generation">, messages: OpenCodeMessageEnvelope[], busy: boolean): TimelineTask["activity"] {
  const profile = session.kind === "root" ? task.rootProfile : task.workerProfile;
  const turns = new Map<string, TimelineTask["activity"][number]>();
  const ordered = [...messages].sort((left, right) => left.info.time.created - right.info.time.created);
  for (const { info } of ordered) {
    if (info.role !== "assistant") continue;
    const live = info.time.completed === undefined && busy && info.id === ordered.at(-1)?.info.id;
    if (info.time.completed === undefined && !live) {
      const previous = turns.get(info.parentID);
      if (previous) previous.status = "interrupted";
      continue;
    }
    const start = new Date(info.time.created).toISOString();
    const end = live ? null : new Date(info.time.completed ?? info.time.created).toISOString();
    const previous = turns.get(info.parentID);
    const status = info.error ? "failed" : live ? "running" : "completed";
    turns.set(info.parentID, {
      id: `${session.id}:${info.parentID}`, role: session.kind, agentId: `${session.kind}:${profile.profileId}`,
      agentName: profile.model, avatarSeed: profile.profileId, status: previous?.status === "failed" ? "failed" : status,
      attempt: session.generation,
      startedAt: previous && previous.startedAt < start ? previous.startedAt : start,
      finishedAt: previous?.finishedAt === null || end === null ? null : previous && previous.finishedAt > end ? previous.finishedAt : end,
    });
  }
  return [...turns.values()];
}

export async function readTaskTimeline(databasePath: string, tasks: Task[], sessions: Pick<TaskSession, "id" | "taskId" | "kind" | "generation" | "nativeSessionId">[]): Promise<TaskTimeline> {
  const result: TaskTimeline = { tasks: tasks.map(task => ({ id: task.id, projectId: task.projectId, issueKey: task.issueKey ?? null, title: task.title, activity: [] })), unavailableSessions: 0 };
  const nativeSessions = sessions.filter(session => session.nativeSessionId);
  if (!nativeSessions.length) return result;
  const directory = await mkdtemp(join(tmpdir(), "forge-timeline-observation-"));
  try {
    const server = await ensureOpenCodeServer({ runtimeDirectory: directory, executable: await resolveOpenCodeExecutable(), directory: process.cwd(), config: {} });
    const reader = openCodeServerClient(server);
    for (const session of nativeSessions) {
      const task = tasks.find(task => task.id === session.taskId);
      const target = result.tasks.find(task => task.id === session.taskId);
      if (!task || !target || !session.nativeSessionId) continue;
      try {
        const messages = await reader.getMessages(session.nativeSessionId);
        let busy = false;
        if (messages.some(message => message.info.role === "assistant" && message.info.time.completed === undefined)) {
          const live = await readOpenCodeServer(join(dirname(databasePath), "runtime", "task-sessions", session.id));
          if (live) {
            try { busy = (await openCodeServerClient(live).getStatus(live.directory))[session.nativeSessionId]?.type === "busy"; }
            catch { /* Stopped servers do not extend unfinished intervals. */ }
          }
        }
        target.activity.push(...timelineActivity(task, session, messages, busy));
      } catch { result.unavailableSessions += 1; }
    }
    return result;
  } finally {
    const server = await readOpenCodeServer(directory);
    if (server) await stopOpenCodeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
}

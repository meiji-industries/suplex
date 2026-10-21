import { queryOptions, replaceEqualDeep, skipToken, useQueries, useQuery, useQueryClient, type QueryClient, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { readTaskCosts } from "../analytics/lib/analytics-api.js";
import type { SyncMessage } from "../../contracts/generated/SyncMessage.js";
import type { TaskAgents } from "../../contracts/generated/TaskAgents.js";
import type { TaskCostsResponse } from "../../contracts/generated/TaskCostsResponse.js";
import type { Task } from "../../contracts/tasks.js";
import type { TaskListTask } from "../../contracts/task-responses.js";
import { TaskAgentsBatchResponseSchema } from "../../contracts/task-responses.js";
import { readJsonUnchecked } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { SyncLiveContext, SyncWatchContext, syncedPolling, useSyncLive, useSyncWatch } from "../../shell/sync.js";
import { movesKey } from "../moves/lib/move-runs.js";
import { projectsKey } from "../projects/lib/projects.js";
import { playInputSound, tasksEnteringInput } from "./lib/input-sound.js";
import { taskObservationKey } from "./lib/task-queries.js";
import { readTaskList, showRecentTasks } from "./lib/task-list.js";
import { openTaskSync } from "./lib/task-sync-api.js";
import type { TaskHealth } from "./task-health.js";

const emptyCosts = new Map<string, TaskCostsResponse["tasks"][number]>();
const TaskCostsContext = createContext<{ companyId: string | undefined; costs: typeof emptyCosts }>({ companyId: undefined, costs: emptyCosts });
export const taskCostsKey = (userId: string | undefined, companyId: string | undefined) => ["task-costs", userId, companyId] as const;
const TaskDataContext = createContext<UseQueryResult<TaskListTask[]> | null>(null);
export const taskListKey = (userId: string | undefined, companyId: string | undefined, archived = false) => ["tasks", userId, companyId, archived ? "archived" : "active"] as const;

/** Applies the tasks of one sync frame to the cached list. The list keeps the server order: newest `updatedAt` first, then id. */
export function applyTaskSync(current: TaskListTask[] | undefined, message: Extract<SyncMessage, { type: "snapshot" | "changes" }>): TaskListTask[] | undefined {
  if (message.type === "snapshot") return message.tasks;
  if (!current) return current;
  const changed = new Set(message.tasks.map(task => task.id));
  const removed = new Set(message.removedTaskIds);
  return [...current.filter(task => !changed.has(task.id) && !removed.has(task.id)), ...message.tasks]
    .sort((left, right) => left.updatedAt === right.updatedAt ? (left.id < right.id ? -1 : 1) : left.updatedAt < right.updatedAt ? 1 : -1);
}

/**
 * Keeps the object of each task that did not change. The default sharing compares rows by position,
 * so a change of order replaces every row and each memoized card renders again.
 */
function shareTaskRows(previous: unknown, next: unknown): unknown {
  if (!Array.isArray(previous) || !Array.isArray(next)) return next;
  const byId = new Map<unknown, unknown>(previous.map(task => [task.id, task]));
  const rows = next.map(task => replaceEqualDeep(byId.get(task.id), task));
  return rows.length === previous.length && rows.every((task, index) => task === previous[index]) ? previous : rows;
}

export function TaskDataProvider({ children }: { children: ReactNode }) {
  const { user, currentCompany } = useCompanyContext();
  const client = useQueryClient();
  const userId = user?.id;
  const companyId = currentCompany?.id;
  const enabled = Boolean(user && companyId && showRecentTasks(window.location.pathname));
  // The server pushes task and move changes while the sync socket is open. Without it, the lists poll.
  const [live, setLive] = useState(false);
  // Components declare the task agents and the open task they show. One watch frame follows a burst of renders.
  const watches = useRef(new Set<{ agentTaskIds: string[]; openTaskId: string | null }>());
  const socket = useRef<ReturnType<typeof openTaskSync>>(undefined);
  const timer = useRef<number>(undefined);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const all = [...watches.current];
      socket.current?.watch({ type: "watch", agentTaskIds: [...new Set(all.flatMap(entry => entry.agentTaskIds))].sort(), openTaskId: all.find(entry => entry.openTaskId)?.openTaskId ?? null });
    }, 50);
  }, []);
  const declare = useCallback((agentTaskIds: string[], openTaskId: string | null) => {
    const entry = { agentTaskIds, openTaskId };
    watches.current.add(entry); flush();
    return () => { watches.current.delete(entry); flush(); };
  }, [flush]);
  useEffect(() => {
    if (!enabled || !userId || !companyId) return;
    const queryKey = taskListKey(userId, companyId);
    // A read that started before a frame holds older data.
    const push = <T,>(key: QueryKey, value: T | undefined, keep?: (current: T, value: T) => boolean): void => {
      if (value === undefined) return;
      void client.cancelQueries({ queryKey: key, exact: true });
      const before = client.getQueryData<T>(key);
      if (before === undefined || !keep?.(before, value)) client.setQueryData<T>(key, value);
    };
    const sync = openTaskSync(companyId, message => {
      setLive(true);
      if (message.type === "agents") {
        // Each element replaces the agents of one task in every batch that shows the task.
        for (const [key, current] of client.getQueriesData<TaskAgents[]>({ queryKey: ["task-agents", userId, companyId] })) {
          const ids: unknown = key[3];
          if (!Array.isArray(ids)) continue;
          const pushed = message.tasks.filter(entry => ids.includes(entry.taskId));
          // A batch without a value waits for its first read, unless the frame has all of its tasks.
          if (pushed.length && (current || pushed.length === ids.length)) push(key, [...(current ?? []).map(row => pushed.find(entry => entry.taskId === row.taskId) ?? row), ...pushed.filter(entry => !current?.some(row => row.taskId === entry.taskId))]);
        }
        return;
      }
      if (message.type === "openTask") {
        const key = (part: string) => [...taskObservationKey(userId, companyId, message.taskId), part];
        // A command response can be newer than the pushed task.
        push<Task>(key("task"), message.task, (current, task) => current.updatedAt > task.updatedAt);
        push(key("activity"), message.activity);
        push(key("timeline"), message.timeline);
        push(key("execution"), message.execution);
        return;
      }
      const before = client.getQueryData<TaskListTask[]>(queryKey);
      if (message.type === "snapshot" || message.tasks.length || message.removedTaskIds.length) {
        void client.cancelQueries({ queryKey, exact: true });
        client.setQueryData<TaskListTask[]>(queryKey, current => applyTaskSync(current, message));
      }
      // The archived list changes when a task leaves or enters the active list.
      const ids = new Set(before?.map(task => task.id));
      const after = client.getQueryData<TaskListTask[]>(queryKey);
      if (before && after && (after.length !== ids.size || after.some(task => !ids.has(task.id)))) void client.invalidateQueries({ queryKey: taskListKey(userId, companyId, true), exact: true });
      // The sound follows each applied frame, not a render. It changes no command and no display.
      if (tasksEnteringInput(message.type, before, after).length) playInputSound();
      push(movesKey(userId, companyId), message.moves);
      push(taskCostsKey(userId, companyId), message.costs && { tasks: message.costs });
      push(projectsKey(userId, companyId), message.projects);
    }, () => setLive(false));
    socket.current = sync;
    flush();
    return () => { sync.close(); socket.current = undefined; setLive(false); };
  }, [client, enabled, userId, companyId, flush]);
  const query = useQuery({
    queryKey: taskListKey(userId, companyId),
    queryFn: companyId ? ({ signal }) => readTaskList(companyId, false, signal) : skipToken,
    enabled,
    structuralSharing: shareTaskRows,
    ...syncedPolling(live),
  });
  const costsQuery = useQuery({
    queryKey: taskCostsKey(user?.id, companyId),
    queryFn: companyId ? ({ signal }) => readTaskCosts(companyId, signal) : skipToken,
    enabled: Boolean(user && companyId && /^\/(?:(?:tasks|board)(?:\/|$)|(?:timeline|analytics|setup)$)/.test(window.location.pathname)),
    ...syncedPolling(live, 30_000),
  });
  const costs = useMemo(() => ({
    companyId,
    costs: user && !costsQuery.isError && costsQuery.data ? new Map(costsQuery.data.tasks.map(task => [task.id, task])) : emptyCosts,
  }), [companyId, user?.id, costsQuery.data, costsQuery.isError]);
  return <SyncLiveContext.Provider value={live}><SyncWatchContext.Provider value={declare}><TaskDataContext.Provider value={query}><TaskCostsContext.Provider value={costs}>{children}</TaskCostsContext.Provider></TaskDataContext.Provider></SyncWatchContext.Provider></SyncLiveContext.Provider>;
}

export function useTaskData() {
  const query = useContext(TaskDataContext);
  if (!query) throw new Error("TaskDataProvider is required");
  return query;
}

export function useTaskCosts(companyId: string | undefined) {
  const context = useContext(TaskCostsContext);
  return companyId && companyId === context.companyId ? context.costs : emptyCosts;
}

/** One batch read of task agents. The sync frame fills every batch that holds a pushed task. */
function taskAgentsQuery(userId: string | undefined, companyId: string | undefined, ids: string[], live: boolean) {
  return queryOptions({
    queryKey: ["task-agents", userId, companyId, ids],
    queryFn: companyId ? async ({ signal }) => TaskAgentsBatchResponseSchema.parse(await readJsonUnchecked(
      `/api/companies/${encodeURIComponent(companyId)}/task-agents?${new URLSearchParams(ids.map(id => ["taskId", id]))}`, { signal },
    )).tasks : skipToken,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === userId && previousQuery?.queryKey[2] === companyId ? previous : undefined,
    enabled: Boolean(userId && companyId && ids.length),
    ...syncedPolling(live),
  });
}

type TaskAgentsBatch = z.infer<typeof TaskAgentsBatchResponseSchema>["tasks"];

export function useTaskAgents(taskIds: string[]) {
  const { user, currentCompany } = useCompanyContext();
  const ids = [...new Set(taskIds)].sort();
  useSyncWatch(ids, null);
  return useQuery(taskAgentsQuery(user?.id, currentCompany?.id, ids, useSyncLive()));
}

/** The sync socket reads agents for at most this many watched tasks. */
const WATCH_LIMIT = 50;
/** `GET /api/companies/{id}/task-agents` reads at most this many tasks. */
const BATCH_LIMIT = 10;
const noHealth = new Map<string, TaskHealth>();

/**
 * The health of each task, from its pushed agents value, for the first 50 ids. Without the socket, batches of 10 poll
 * the agents route. A display observation: never gate a command on it.
 */
export function useTaskHealth(taskIds: string[]): ReadonlyMap<string, TaskHealth> {
  const { user, currentCompany } = useCompanyContext();
  const ids = [...new Set(taskIds)].sort().slice(0, WATCH_LIMIT);
  useSyncWatch(ids, null);
  const live = useSyncLive();
  const batches = [];
  for (let index = 0; index < ids.length; index += BATCH_LIMIT) batches.push(ids.slice(index, index + BATCH_LIMIT));
  return useQueries({ queries: batches.map(batch => taskAgentsQuery(user?.id, currentCompany?.id, batch, live)), combine: healthByTask });
}

/** Stable, so the map changes only when a batch changes. */
function healthByTask(results: { data?: TaskAgentsBatch | undefined }[]): ReadonlyMap<string, TaskHealth> {
  const entries = results.flatMap(result => result.data ?? []).flatMap(entry => entry.health ? [[entry.taskId, entry.health] as const] : []);
  return entries.length ? new Map(entries) : noHealth;
}

export async function updateTaskCache(client: QueryClient, userId: string, task: Task): Promise<void> {
  const queryKey = taskListKey(userId, task.companyId);
  const detail = [...taskObservationKey(userId, task.companyId, task.id), "task"];
  await Promise.all([client.cancelQueries({ queryKey, exact: true }), client.cancelQueries({ queryKey: detail, exact: true })]);
  client.setQueryData<Task>(detail, current => current && current.updatedAt > task.updatedAt ? current : task);
  const summary: TaskListTask = {
    id: task.id, companyId: task.companyId, projectId: task.projectId, issueKey: task.issueKey,
    title: task.title, status: task.status,
    configuration: { repository: task.configuration.repository, branch: task.configuration.branch },
    pullRequest: task.pullRequest, humanQuestion: task.humanQuestion && { text: task.humanQuestion.text },
    blockedBy: task.blockedBy, queue: task.queue, dependsOn: task.dependsOn,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    createdAt: task.createdAt, updatedAt: task.updatedAt, statusChangedAt: task.statusChangedAt, queuePriority: task.queuePriority, archivedAt: task.archivedAt,
  };
  client.setQueryData<TaskListTask[]>(queryKey, current => {
    if (!current) return undefined;
    // The sync socket can deliver a newer state before this command response arrives.
    if (current.some(row => row.id === task.id && row.updatedAt > task.updatedAt)) return current;
    if (task.archivedAt) return current.filter(row => row.id !== task.id);
    return current.some(row => row.id === task.id) ? current.map(row => row.id === task.id ? summary : row) : [summary, ...current];
  });
  if (!client.getQueryData(queryKey)) void client.invalidateQueries({ queryKey });
  // The list frame of this change finds the active list already current, so it does not report an archive or a restore.
  void client.invalidateQueries({ queryKey: taskListKey(userId, task.companyId, true), exact: true });
  void client.invalidateQueries({ queryKey: ["task-agents", userId, task.companyId] });
}

export function useTaskCache() {
  const client = useQueryClient();
  const { user } = useCompanyContext();
  return useCallback((task: Task) => {
    // Display synchronization must not turn a successful command into a failure.
    if (user) void updateTaskCache(client, user.id, task).catch(() => undefined);
  }, [client, user]);
}

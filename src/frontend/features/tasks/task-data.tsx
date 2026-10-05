import { replaceEqualDeep, skipToken, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { readTaskCosts } from "../analytics/lib/analytics-api.js";
import type { SyncMessage } from "../../contracts/generated/SyncMessage.js";
import type { TaskCostsResponse } from "../../contracts/generated/TaskCostsResponse.js";
import type { Task } from "../../contracts/tasks.js";
import type { TaskListTask } from "../../contracts/task-responses.js";
import { TaskAgentsBatchResponseSchema } from "../../contracts/task-responses.js";
import { readJsonUnchecked } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { SyncLiveContext, syncedPolling } from "../../shell/sync.js";
import { movesKey } from "../moves/lib/move-runs.js";
import { projectsKey } from "../projects/lib/projects.js";
import { readTaskList, showRecentTasks } from "./lib/task-list.js";
import { openTaskSync } from "./lib/task-sync-api.js";

const polling = { refetchInterval: 3000, refetchIntervalInBackground: false, staleTime: 3000 };
const emptyCosts = new Map<string, TaskCostsResponse["tasks"][number]>();
const TaskCostsContext = createContext<{ companyId: string | undefined; costs: typeof emptyCosts }>({ companyId: undefined, costs: emptyCosts });
export const taskCostsKey = (userId: string | undefined, companyId: string | undefined) => ["task-costs", userId, companyId] as const;
const TaskDataContext = createContext<UseQueryResult<TaskListTask[]> | null>(null);
export const taskListKey = (userId: string | undefined, companyId: string | undefined) => ["tasks", userId, companyId, "active"] as const;

/** Applies the tasks of one sync frame to the cached list. The list keeps the server order: newest `updatedAt` first, then id. */
export function applyTaskSync(current: TaskListTask[] | undefined, message: SyncMessage): TaskListTask[] | undefined {
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
  useEffect(() => {
    if (!enabled || !userId || !companyId) return;
    const queryKey = taskListKey(userId, companyId);
    const close = openTaskSync(companyId, message => {
      setLive(true);
      // A read that started before this frame holds older data.
      if (message.type === "snapshot" || message.tasks.length || message.removedTaskIds.length) {
        void client.cancelQueries({ queryKey, exact: true });
        client.setQueryData<TaskListTask[]>(queryKey, current => applyTaskSync(current, message));
      }
      if (message.moves) {
        const moves = movesKey(userId, companyId);
        void client.cancelQueries({ queryKey: moves, exact: true });
        client.setQueryData(moves, message.moves);
      }
      // Projects travel over HTTP. A snapshot can follow a time without the socket.
      if (message.type === "snapshot" || message.projectsChanged) void client.invalidateQueries({ queryKey: projectsKey(userId, companyId), exact: true }, { cancelRefetch: false });
    }, () => setLive(false));
    return () => { close(); setLive(false); };
  }, [client, enabled, userId, companyId]);
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
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  const costs = useMemo(() => ({
    companyId,
    costs: user && !costsQuery.isError && costsQuery.data ? new Map(costsQuery.data.tasks.map(task => [task.id, task])) : emptyCosts,
  }), [companyId, user?.id, costsQuery.data, costsQuery.isError]);
  return <SyncLiveContext.Provider value={live}><TaskDataContext.Provider value={query}><TaskCostsContext.Provider value={costs}>{children}</TaskCostsContext.Provider></TaskDataContext.Provider></SyncLiveContext.Provider>;
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

export function useTaskAgents(taskIds: string[]) {
  const { user, currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id;
  const ids = [...new Set(taskIds)].sort();
  return useQuery({
    queryKey: ["task-agents", user?.id, companyId, ids],
    queryFn: companyId ? async ({ signal }) => TaskAgentsBatchResponseSchema.parse(await readJsonUnchecked(
      `/api/companies/${encodeURIComponent(companyId)}/task-agents?${new URLSearchParams(ids.map(id => ["taskId", id]))}`, { signal },
    )).tasks : skipToken,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === user?.id && previousQuery?.queryKey[2] === companyId ? previous : undefined,
    enabled: Boolean(user && companyId && ids.length),
    ...polling,
  });
}

export async function updateTaskCache(client: QueryClient, userId: string, task: Task): Promise<void> {
  const queryKey = taskListKey(userId, task.companyId);
  await client.cancelQueries({ queryKey, exact: true });
  const summary: TaskListTask = {
    id: task.id, companyId: task.companyId, projectId: task.projectId, issueKey: task.issueKey,
    title: task.title, status: task.status,
    configuration: { repository: task.configuration.repository, branch: task.configuration.branch },
    pullRequest: task.pullRequest, humanQuestion: task.humanQuestion && { text: task.humanQuestion.text },
    blockedBy: task.blockedBy, dependsOn: task.dependsOn,
    createdAt: task.createdAt, updatedAt: task.updatedAt, statusChangedAt: task.statusChangedAt, archivedAt: task.archivedAt,
  };
  client.setQueryData<TaskListTask[]>(queryKey, current => {
    if (!current) return undefined;
    // The sync socket can deliver a newer state before this command response arrives.
    if (current.some(row => row.id === task.id && row.updatedAt > task.updatedAt)) return current;
    if (task.archivedAt) return current.filter(row => row.id !== task.id);
    return current.some(row => row.id === task.id) ? current.map(row => row.id === task.id ? summary : row) : [summary, ...current];
  });
  if (!client.getQueryData(queryKey)) void client.invalidateQueries({ queryKey });
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

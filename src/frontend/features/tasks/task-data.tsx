import { skipToken, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { readTaskCosts } from "../analytics/lib/analytics-api.js";
import type { TaskCostsResponse } from "../../contracts/generated/TaskCostsResponse.js";
import type { Task } from "../../contracts/tasks.js";
import { TaskAgentsBatchResponseSchema } from "../../contracts/task-responses.js";
import { readJsonUnchecked } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readTaskList, showRecentTasks } from "./lib/task-list.js";

const polling = { refetchInterval: 3000, refetchIntervalInBackground: false, staleTime: 3000 };
const emptyCosts = new Map<string, TaskCostsResponse["tasks"][number]>();
const TaskCostsContext = createContext<{ companyId: string | undefined; costs: typeof emptyCosts }>({ companyId: undefined, costs: emptyCosts });
export const taskCostsKey = (userId: string | undefined, companyId: string | undefined) => ["task-costs", userId, companyId] as const;
const TaskDataContext = createContext<UseQueryResult<Task[]> | null>(null);
export const taskListKey = (userId: string | undefined, companyId: string | undefined) => ["tasks", userId, companyId, "active"] as const;

export function TaskDataProvider({ children }: { children: ReactNode }) {
  const { user, currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id;
  const query = useQuery({
    queryKey: taskListKey(user?.id, companyId),
    queryFn: companyId ? ({ signal }) => readTaskList(companyId, false, signal) : skipToken,
    enabled: Boolean(user && companyId && showRecentTasks(window.location.pathname)),
    ...polling,
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
  return <TaskDataContext.Provider value={query}><TaskCostsContext.Provider value={costs}>{children}</TaskCostsContext.Provider></TaskDataContext.Provider>;
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
  client.setQueryData<Task[]>(queryKey, current => {
    if (!current) return undefined;
    if (task.archivedAt) return current.filter(row => row.id !== task.id);
    return current.some(row => row.id === task.id) ? current.map(row => row.id === task.id ? task : row) : [task, ...current];
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

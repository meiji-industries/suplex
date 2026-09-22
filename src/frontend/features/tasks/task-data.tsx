import { skipToken, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { Task } from "../../../tasks/contracts.js";
import { TaskAgentsBatchResponseSchema } from "../../../http/contracts/tasks.js";
import { readJson } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readTaskList, showRecentTasks } from "./lib/task-list.js";

const polling = { refetchInterval: 3000, refetchIntervalInBackground: false, staleTime: 3000 };
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
  return <TaskDataContext.Provider value={query}>{children}</TaskDataContext.Provider>;
}

export function useTaskData() {
  const query = useContext(TaskDataContext);
  if (!query) throw new Error("TaskDataProvider is required");
  return query;
}

export function useTaskAgents(taskIds: string[]) {
  const { user, currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id;
  const ids = [...new Set(taskIds)].sort();
  return useQuery({
    queryKey: ["task-agents", user?.id, companyId, ids],
    queryFn: companyId ? async ({ signal }) => TaskAgentsBatchResponseSchema.parse(await readJson(
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

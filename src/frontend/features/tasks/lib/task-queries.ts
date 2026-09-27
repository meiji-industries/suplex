import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { Task } from "../../../contracts/tasks.js";
import { useCompanyContext } from "../../../shell/company-context.js";
import { readTaskActivity, readTaskDiff, readTaskDiffSummary, readTaskExecution, readTaskTimeline } from "./task-api.js";

const polling = { refetchInterval: 5000, refetchIntervalInBackground: false, staleTime: 5000, retry: false };
export const taskObservationKey = (userId: string | undefined, companyId: string | undefined, taskId: string) => ["task-observation", userId, companyId, taskId] as const;

function activityOptions(userId: string | undefined, companyId: string | undefined, taskId: string) {
  return {
    queryKey: [...taskObservationKey(userId, companyId, taskId), "activity"],
    queryFn: ({ signal }: { signal: AbortSignal }) => readTaskActivity(taskId, signal),
    ...polling,
    refetchInterval: 3000,
    staleTime: 3000,
  };
}

export async function refreshTaskActivity(client: QueryClient, userId: string | undefined, companyId: string | undefined, taskId: string) {
  const options = activityOptions(userId, companyId, taskId);
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  return client.fetchQuery({ ...options, staleTime: 0 });
}

export function useTaskActivity(taskId: string) {
  const { user, currentCompany } = useCompanyContext();
  const client = useQueryClient();
  const userId = user?.id;
  const companyId = currentCompany?.id;
  const query = useQuery({ ...activityOptions(userId, companyId, taskId), enabled: Boolean(userId && companyId) });
  const refresh = useCallback(() => refreshTaskActivity(client, userId, companyId, taskId), [client, userId, companyId, taskId]);
  return { data: query.data, error: query.error, refresh };
}

export function useTaskExecutionQuery(taskId: string) {
  const { user, currentCompany } = useCompanyContext();
  return useQuery({
    queryKey: [...taskObservationKey(user?.id, currentCompany?.id, taskId), "execution"],
    queryFn: ({ signal }) => readTaskExecution(taskId, signal),
    enabled: Boolean(user && currentCompany),
    ...polling,
  });
}

export function useTaskTimeline(taskId: string) {
  const { user, currentCompany } = useCompanyContext();
  return useQuery({
    queryKey: [...taskObservationKey(user?.id, currentCompany?.id, taskId), "timeline"],
    queryFn: ({ signal }) => readTaskTimeline(taskId, signal),
    enabled: Boolean(user && currentCompany),
    ...polling,
  });
}

export function useTaskDiffSummary(task: Pick<Task, "id" | "updatedAt">) {
  const { user, currentCompany } = useCompanyContext();
  const client = useQueryClient();
  const userId = user?.id;
  const companyId = currentCompany?.id;
  const previous = useRef({ id: task.id, updatedAt: task.updatedAt });
  useEffect(() => {
    if (previous.current.id === task.id && previous.current.updatedAt !== task.updatedAt) {
      const queryKey = [...taskObservationKey(userId, companyId, task.id), "diff"];
      void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey })).catch(() => undefined);
    }
    previous.current = { id: task.id, updatedAt: task.updatedAt };
  }, [client, userId, companyId, task.id, task.updatedAt]);
  return useQuery({
    queryKey: [...taskObservationKey(userId, companyId, task.id), "diff", "summary"],
    queryFn: ({ signal }) => readTaskDiffSummary(task.id, signal),
    enabled: Boolean(userId && companyId),
    refetchOnMount: "always",
    ...polling,
  });
}

export function useTaskDiff(taskId: string) {
  const { user, currentCompany } = useCompanyContext();
  return useQuery({
    queryKey: [...taskObservationKey(user?.id, currentCompany?.id, taskId), "diff", "patch"],
    queryFn: ({ signal }) => readTaskDiff(taskId, signal),
    enabled: Boolean(user && currentCompany),
    refetchOnMount: "always",
    ...polling,
  });
}

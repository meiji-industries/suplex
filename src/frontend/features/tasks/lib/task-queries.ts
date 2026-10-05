import { skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { Task } from "../../../contracts/tasks.js";
import { useCompanyContext } from "../../../shell/company-context.js";
import { syncedPolling, useSyncLive, useSyncWatch } from "../../../shell/sync.js";
import { getTask, readTaskActivity, readTaskDiff, readTaskDiffSummary, readTaskExecution, readTaskTimeline } from "./task-api.js";

export const taskObservationKey = (userId: string | undefined, companyId: string | undefined, taskId: string) => ["task-observation", userId, companyId, taskId] as const;

/** The task of the open page. The sync socket pushes its changes, and command responses write it through `updateTaskCache`. */
export function useTask(taskId: string | undefined) {
  const { user, currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id;
  useSyncWatch([], taskId ?? null);
  return useQuery({
    queryKey: [...taskObservationKey(user?.id, companyId, taskId ?? ""), "task"],
    queryFn: taskId && companyId ? async ({ signal }) => {
      const task = await getTask(taskId, signal);
      if (task.companyId !== companyId) throw new Error("This task is not in the selected company");
      return task;
    } : skipToken,
    enabled: Boolean(user),
    retry: false,
    ...syncedPolling(useSyncLive()),
  });
}

function activityOptions(userId: string | undefined, companyId: string | undefined, taskId: string) {
  return {
    queryKey: [...taskObservationKey(userId, companyId, taskId), "activity"],
    queryFn: ({ signal }: { signal: AbortSignal }) => readTaskActivity(taskId, signal),
    retry: false,
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
  const query = useQuery({ ...activityOptions(userId, companyId, taskId), enabled: Boolean(userId && companyId), ...syncedPolling(useSyncLive()) });
  const refresh = useCallback(() => refreshTaskActivity(client, userId, companyId, taskId), [client, userId, companyId, taskId]);
  return { data: query.data, error: query.error, refresh };
}

export function useTaskExecutionQuery(taskId: string) {
  const { user, currentCompany } = useCompanyContext();
  return useQuery({
    queryKey: [...taskObservationKey(user?.id, currentCompany?.id, taskId), "execution"],
    queryFn: ({ signal }) => readTaskExecution(taskId, signal),
    enabled: Boolean(user && currentCompany),
    retry: false,
    ...syncedPolling(useSyncLive(), 5000),
  });
}

export function useTaskTimeline(taskId: string, refetchInterval?: number | false) {
  const { user, currentCompany } = useCompanyContext();
  return useQuery({
    queryKey: [...taskObservationKey(user?.id, currentCompany?.id, taskId), "timeline"],
    queryFn: ({ signal }) => readTaskTimeline(taskId, signal),
    enabled: Boolean(user && currentCompany),
    retry: false,
    ...syncedPolling(useSyncLive(), 5000),
    ...(refetchInterval !== undefined ? { refetchInterval, staleTime: 0 } : {}),
  });
}

/** Reads the summary and the patch again when the task or the agents' work changes. */
export function useTaskDiffSummary(task: Pick<Task, "id" | "updatedAt">) {
  const { user, currentCompany } = useCompanyContext();
  const client = useQueryClient();
  const live = useSyncLive();
  const userId = user?.id;
  const companyId = currentCompany?.id;
  const execution = useTaskExecutionQuery(task.id).data;
  const previous = useRef({ task, execution });
  const last = useRef(0);
  const timer = useRef<number>(undefined);
  useEffect(() => () => { window.clearTimeout(timer.current); timer.current = undefined; }, [client, userId, companyId, task.id]);
  useEffect(() => {
    // Without the socket, a new `updatedAt` reads the diff again. With it, any change of the task or of the agents' work can move the worktree.
    const before = previous.current;
    previous.current = { task, execution };
    if (before.task.id !== task.id || !(live ? before.task !== task || (before.execution !== undefined && before.execution !== execution) : before.task.updatedAt !== task.updatedAt)) return;
    const queryKey = [...taskObservationKey(userId, companyId, task.id), "diff"];
    const read = () => { last.current = Date.now(); void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey })).catch(() => undefined); };
    if (!live) { read(); return; }
    // Each diff read calls GitHub and runs git. Pushed changes read at most once in 5 seconds, and once after the last change.
    if (timer.current !== undefined) return;
    const wait = last.current + 5000 - Date.now();
    if (wait > 0) timer.current = window.setTimeout(() => { timer.current = undefined; read(); }, wait); else read();
  }, [client, userId, companyId, task, execution, live]);
  return useQuery({
    queryKey: [...taskObservationKey(userId, companyId, task.id), "diff", "summary"],
    queryFn: ({ signal }) => readTaskDiffSummary(task.id, signal),
    enabled: Boolean(userId && companyId),
    refetchOnMount: "always",
    retry: false,
    ...syncedPolling(live, 5000),
  });
}

export function useTaskDiff(taskId: string) {
  const { user, currentCompany } = useCompanyContext();
  return useQuery({
    queryKey: [...taskObservationKey(user?.id, currentCompany?.id, taskId), "diff", "patch"],
    queryFn: ({ signal }) => readTaskDiff(taskId, signal),
    enabled: Boolean(user && currentCompany),
    refetchOnMount: "always",
    retry: false,
    ...syncedPolling(useSyncLive(), 5000),
  });
}

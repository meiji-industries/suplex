import { createContext, useContext, useEffect } from "react";

/** True while the company sync socket delivers changes. */
export const SyncLiveContext = createContext(false);

export const useSyncLive = (): boolean => useContext(SyncLiveContext);

/**
 * Query timing for a value that the sync socket keeps current. Without the socket, the value polls at `interval`.
 * While the socket is open, a slow read repairs a missed frame.
 */
export const syncedPolling = (live: boolean, interval = 3000): { refetchInterval: number; refetchIntervalInBackground: false; staleTime: number } =>
  ({ refetchInterval: live ? 60_000 : interval, refetchIntervalInBackground: false, staleTime: live ? 60_000 : interval });

/** Adds what one component shows to the watch of the sync socket. Returns the function that removes it. */
export const SyncWatchContext = createContext<(agentTaskIds: string[], openTaskId: string | null) => () => void>(() => () => undefined);

/** Tells the sync socket which task agents and which open task this component shows, so the server pushes their changes. */
export function useSyncWatch(agentTaskIds: string[], openTaskId: string | null): void {
  const declare = useContext(SyncWatchContext);
  const ids = agentTaskIds.join("\n");
  useEffect(() => declare(ids ? ids.split("\n") : [], openTaskId), [declare, ids, openTaskId]);
}

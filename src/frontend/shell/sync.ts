import { createContext, useContext } from "react";

/** True while the company sync socket delivers changes. */
export const SyncLiveContext = createContext(false);

export const useSyncLive = (): boolean => useContext(SyncLiveContext);

/**
 * Query timing for a list that the sync socket keeps current. Without the socket, the list polls.
 * While the socket is open, a slow read repairs a missed frame.
 */
export const syncedPolling = (live: boolean): { refetchInterval: number; refetchIntervalInBackground: false; staleTime: number } =>
  ({ refetchInterval: live ? 60_000 : 3000, refetchIntervalInBackground: false, staleTime: live ? 60_000 : 3000 });

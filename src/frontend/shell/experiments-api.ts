import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";

import type { ExperimentsResponse } from "../contracts/generated/ExperimentsResponse.js";
import { readJson } from "../lib/api.js";

const ExperimentsSchema = z.object({ todayPage: z.boolean() }) satisfies z.ZodType<ExperimentsResponse>;
const OFF: ExperimentsResponse = { todayPage: false };

let current: ExperimentsResponse | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** Replaces the host experiments, for example after an administrator saves them. */
export function setExperiments(next: ExperimentsResponse): void {
  current = next;
  for (const listener of listeners) listener();
}

function load(): Promise<void> {
  // A failed read shows the default, which keeps every experiment off.
  loading ??= readJson("/api/experiments").then(body => ExperimentsSchema.parse(body), () => OFF).then(setExperiments);
  return loading;
}

/** Host experiments; undefined until the first read completes. */
export function useExperiments(): ExperimentsResponse | undefined {
  useEffect(() => { void load(); }, []);
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
}

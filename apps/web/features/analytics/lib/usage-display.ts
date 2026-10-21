import { useSyncExternalStore } from "react";

export const usageDisplayStorageKey = "suplex.usageDisplay";
export const defaultUsageDisplay = "spend";

export const usageDisplayOptions = [
  { value: "spend", label: "Spend" },
  { value: "tokens", label: "Tokens" },
] as const;

export type UsageDisplay = (typeof usageDisplayOptions)[number]["value"];

export function parseUsageDisplay(value: string | null): UsageDisplay {
  return usageDisplayOptions.find(option => option.value === value)?.value ?? defaultUsageDisplay;
}

export function readUsageDisplay(): UsageDisplay {
  try { return parseUsageDisplay(window.localStorage.getItem(usageDisplayStorageKey)); }
  catch { return defaultUsageDisplay; }
}

let current: UsageDisplay | undefined;
const listeners = new Set<() => void>();
function notify(): void { for (const listener of listeners) listener(); }

export function saveUsageDisplay(value: string): UsageDisplay {
  const parsed = parseUsageDisplay(value);
  try { window.localStorage.setItem(usageDisplayStorageKey, parsed); }
  catch { /* Browser storage can be disabled. */ }
  current = parsed;
  notify();
  return parsed;
}

function subscribe(listener: () => void): () => void {
  // Another tab can change the preference. Read it again on the next render.
  const storage = (event: StorageEvent) => { if (event.key === usageDisplayStorageKey || event.key === null) { current = undefined; listener(); } };
  listeners.add(listener);
  window.addEventListener("storage", storage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", storage); };
}

/** The usage display preference of this browser. Every mounted reader updates when it changes. */
export function useUsageDisplay(): UsageDisplay {
  return useSyncExternalStore(subscribe, () => current ??= readUsageDisplay(), () => defaultUsageDisplay);
}

/** True when a task cost row has a value to show in this display. */
export function hasUsageValue(cost: { cost: number | null; totalTokens: number } | undefined, display: UsageDisplay): boolean {
  if (!cost) return false;
  return cost.cost !== null || (display === "tokens" && cost.totalTokens > 0);
}

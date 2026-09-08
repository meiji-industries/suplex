export const taskAgentExpiryStorageKey = "forge.taskAgentExpiry";
export const defaultTaskAgentExpiryMs = 300_000;

export const taskAgentExpiryOptions = [
  { value: 0, label: "Immediately" },
  { value: 60_000, label: "1 minute" },
  { value: 300_000, label: "5 minutes" },
  { value: 900_000, label: "15 minutes" },
  { value: 3_600_000, label: "1 hour" },
  { value: 21_600_000, label: "6 hours" },
  { value: 86_400_000, label: "24 hours" },
] as const;

export type TaskAgentExpiryMs = (typeof taskAgentExpiryOptions)[number]["value"];

const taskAgentExpiryValues = new Set<number>(taskAgentExpiryOptions.map(option => option.value));

export function parseTaskAgentExpiry(value: string | null): TaskAgentExpiryMs {
  if (value === null || value.trim() === "") return defaultTaskAgentExpiryMs;
  const parsed = Number(value);
  return taskAgentExpiryValues.has(parsed) ? parsed as TaskAgentExpiryMs : defaultTaskAgentExpiryMs;
}

export function readTaskAgentExpiry(): TaskAgentExpiryMs {
  try { return parseTaskAgentExpiry(window.localStorage.getItem(taskAgentExpiryStorageKey)); }
  catch { return defaultTaskAgentExpiryMs; }
}

export function saveTaskAgentExpiry(value: number): TaskAgentExpiryMs {
  const parsed = parseTaskAgentExpiry(String(value));
  try { window.localStorage.setItem(taskAgentExpiryStorageKey, String(parsed)); }
  catch { /* Browser storage can be disabled. */ }
  return parsed;
}

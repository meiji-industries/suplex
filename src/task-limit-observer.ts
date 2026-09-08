import { usageIsUnpriced, usageMetrics } from "./task-analytics-metrics.js";
import type { NativeSessionReader } from "./task-harness.js";
import type { ModelPricingCatalog } from "./model-pricing.js";
import type { TaskControlStore } from "./root-session-store.js";
import type { TaskSession } from "./task-control.js";
import type { TaskLimitUsage } from "./task-limits.js";
import { estimateUnpricedUsage } from "./task-usage.js";

export async function observeTaskLimitUsage(input: {
  taskId: string;
  store: Pick<TaskControlStore, "taskSpend" | "taskLimits" | "sessionsWithNativeWork" | "replaceNativeUsage">;
  reader?: (session: TaskSession) => Pick<NativeSessionReader, "turnEvidence"> & Partial<Pick<NativeSessionReader, "timeline">>;
  readPricing: () => Promise<ModelPricingCatalog | undefined>;
}): Promise<TaskLimitUsage> {
  const admittedTurns = input.store.taskSpend(input.taskId).turns;
  const limits = input.store.taskLimits(input.taskId);
  if (limits.maxTurns > 0 && admittedTurns >= limits.maxTurns) return { estimatedCostUsd: null, admittedTurns };
  if (limits.budgetUsd === 0) return { estimatedCostUsd: null, admittedTurns };
  const sessions = input.store.sessionsWithNativeWork(input.taskId);
  if (!sessions.length) return { estimatedCostUsd: 0, admittedTurns };
  if (!input.reader) throw new Error("Native task usage is not available. Forge will retry the observation.");
  const unique = new Map<string, Awaited<ReturnType<NativeSessionReader["timeline"]>>["usage"][number]>();
  for (const session of sessions) {
    const reader = input.reader(session);
    if (!reader.timeline) throw new Error("Native task usage is not available. Forge will retry the observation.");
    const observed = await reader.timeline(session);
    for (const entry of observed.usage) unique.set(`${entry.sessionId}:${entry.messageId}`, entry);
  }
  let usage = [...unique.values()];
  if (usage.some(usageIsUnpriced)) {
    const pricing = await input.readPricing();
    if (pricing) usage = estimateUnpricedUsage(usage, pricing);
  }
  if (usage.some(usageIsUnpriced)) throw new Error("Native task usage has no price. Forge will retry after pricing is available.");
  input.store.replaceNativeUsage(input.taskId, usage);
  return { estimatedCostUsd: usageMetrics(usage).cost ?? 0, admittedTurns };
}

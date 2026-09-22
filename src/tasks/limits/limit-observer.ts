import { usageIsUnpriced, usageMetrics } from "../analytics/metrics.js";
import type { NativeSessionReader } from "../../runtimes/task-harness.js";
import type { ModelPricingCatalog } from "../../profiles/model-pricing.js";
import type { TaskControlStore } from "../../coordination/root-session-store.js";
import type { TaskSession } from "../control.js";
import type { TaskLimitUsage } from "./limits.js";
import { estimateUnpricedUsage } from "../usage.js";

export async function observeTaskLimitUsage(input: {
  taskId: string;
  store: Pick<TaskControlStore, "taskSpend" | "taskLimits" | "sessionsWithNativeWork" | "replaceNativeUsage">;
  reader?: (session: TaskSession) => Pick<NativeSessionReader, "turnEvidence"> & Partial<Pick<NativeSessionReader, "timeline">>;
  readPricing: () => Promise<ModelPricingCatalog | undefined>;
  requireCompletePricing?: boolean;
}): Promise<TaskLimitUsage> {
  const admittedTurns = input.store.taskSpend(input.taskId).turns;
  const limits = input.store.taskLimits(input.taskId);
  if (limits.maxTurns > 0 && admittedTurns >= limits.maxTurns) return { estimatedCostUsd: null, admittedTurns };
  if (limits.budgetUsd === 0) return { estimatedCostUsd: null, admittedTurns };
  const sessions = input.store.sessionsWithNativeWork(input.taskId);
  if (!sessions.length) return { estimatedCostUsd: input.requireCompletePricing ? null : 0, admittedTurns };
  if (!input.reader) throw new Error("Native task usage is not available. Suplex will retry the observation.");
  const unique = new Map<string, Awaited<ReturnType<NativeSessionReader["timeline"]>>["usage"][number]>();
  let complete = true;
  for (const session of sessions) {
    const reader = input.reader(session);
    if (!reader.timeline) throw new Error("Native task usage is not available. Suplex will retry the observation.");
    const observed = await reader.timeline(session);
    if (!observed.usage.length || observed.liveMessageId || observed.usage.some(entry => entry.completedAt === null)) complete = false;
    for (const entry of observed.usage) unique.set(`${entry.sessionId}:${entry.messageId}`, entry);
  }
  let usage = [...unique.values()];
  if (usage.some(usageIsUnpriced)) {
    let pricing: ModelPricingCatalog | undefined;
    try {
      pricing = await input.readPricing();
    } catch {
      pricing = undefined;
    }
    if (pricing) usage = estimateUnpricedUsage(usage, pricing);
  }
  if (input.requireCompletePricing && (!complete || usage.some(entry => entry.model === "unknown" || usageIsUnpriced(entry)))) return { estimatedCostUsd: null, admittedTurns };
  input.store.replaceNativeUsage(input.taskId, usage);
  return { estimatedCostUsd: usageMetrics(usage).cost, admittedTurns };
}

import { z } from "zod";
import type { OpenCodeMessageEnvelope } from "./opencode-contracts.js";
import { estimateUsageCost, modelPricingKey, type ModelPricingCatalog } from "./model-pricing.js";
import { TaskSessionKindSchema } from "./task-control.js";

const count = z.number().finite().nonnegative();
export const UsageTokensSchema = z.object({ input: count, output: count, reasoning: count, cache: z.object({ read: count, write: count }) });
export const TaskUsageSchema = z.object({
  sessionId: z.string(), messageId: z.string(), turnId: z.string(), role: TaskSessionKindSchema,
  provider: z.string(), model: z.string(), startedAt: z.number(), completedAt: z.number().nullable(),
  failed: z.boolean(), summary: z.boolean(), steps: count, cost: count, subsidized: z.boolean().default(false),
  tokens: UsageTokensSchema, source: z.enum(["steps", "message"]),
});
export type TaskUsage = z.infer<typeof TaskUsageSchema>;
export type UsageTokens = z.infer<typeof UsageTokensSchema>;
const StepSchema = z.object({ id: z.string(), type: z.literal("step-finish"), cost: count, tokens: UsageTokensSchema });

export function emptyTokens(): UsageTokens { return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }; }
export function addTokens(total: UsageTokens, value: UsageTokens): void {
  total.input += value.input;
  total.output += value.output;
  total.reasoning += value.reasoning;
  total.cache.read += value.cache.read;
  total.cache.write += value.cache.write;
}

export function taskUsage(messages: OpenCodeMessageEnvelope[], role: TaskUsage["role"], pricing?: ModelPricingCatalog): TaskUsage[] {
  return messages.flatMap(({ info, parts }) => {
    if (info.role !== "assistant") return [];
    const steps = new Map<string, z.infer<typeof StepSchema>>();
    for (const part of parts) {
      if (part.type !== "step-finish") continue;
      const step = StepSchema.parse(part);
      steps.set(step.id, step);
    }
    const tokens = steps.size ? emptyTokens() : UsageTokensSchema.parse(info.tokens);
    let cost = steps.size ? 0 : info.cost;
    for (const step of steps.values()) { addTokens(tokens, step.tokens); cost += step.cost; }
    const nativeCost = cost;
    const listedPrice = pricing?.get(modelPricingKey(info.providerID, info.modelID));
    const estimate = nativeCost === 0 && listedPrice ? estimateUsageCost(tokens, listedPrice) : 0;
    const subsidized = estimate > 0;
    return [TaskUsageSchema.parse({
      sessionId: info.sessionID, messageId: info.id, turnId: info.parentID, role,
      provider: info.providerID, model: info.modelID, startedAt: info.time.created,
      completedAt: info.time.completed ?? null, failed: Boolean(info.error), summary: info.summary ?? false,
      steps: steps.size || (info.time.completed === undefined ? 0 : 1), cost: estimate > 0 ? estimate : nativeCost, subsidized, tokens,
      source: steps.size ? "steps" : "message",
    })];
  });
}

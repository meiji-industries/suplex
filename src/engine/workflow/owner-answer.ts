import { z } from "zod";

const outcomeSchema = z.enum(["approved", "findings", "disagreement"]);

export const OwnerAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("owner.done"), outcome: outcomeSchema.optional() }).strict(),
  z.object({ type: z.literal("owner.live") }).strict(),
  z.object({ type: z.literal("owner.absent") }).strict(),
  z.object({ type: z.literal("owner.failed"), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal("owner.unavailable"), owner: z.enum(["member", "git", "github", "herdr", "timer"]), reason: z.string().min(1) }).strict(),
]);

export type OwnerAnswer = z.infer<typeof OwnerAnswerSchema>;

export function ownerAnswer(value: OwnerAnswer): OwnerAnswer {
  return OwnerAnswerSchema.parse(value);
}

export function herdrResultAnswer(result: unknown): OwnerAnswer {
  if (!result || typeof result !== "object" || Array.isArray(result)) return ownerAnswer({ type: "owner.done" });
  const value = result as Record<string, unknown>;
  if (value.outcome === "approved") return ownerAnswer({ type: "owner.done", outcome: "approved" });
  if (value.outcome === "blocking") return ownerAnswer({ type: "owner.failed", reason: "Herdr reported blocking findings" });
  if (value.decision === "repair") return ownerAnswer({ type: "owner.failed", reason: "Herdr requested a repair" });
  if (value.decision === "ask") return ownerAnswer({ type: "owner.done", outcome: "disagreement" });
  if (typeof value.blocker === "string" && value.blocker) return ownerAnswer({ type: "owner.failed", reason: value.blocker });
  return ownerAnswer({ type: "owner.done" });
}

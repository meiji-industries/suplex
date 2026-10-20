import { z } from "zod";

export const HARNESS_KIND_IDS = ["opencode", "claude-code", "devin", "codex", "pi"] as const;

export const HarnessKindSchema = z.enum(HARNESS_KIND_IDS);

export type HarnessKind = z.infer<typeof HarnessKindSchema>;

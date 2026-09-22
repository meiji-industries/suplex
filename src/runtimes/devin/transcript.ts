import type { NativeHistoryMessage } from "../../tasks/history/contracts.js";
import { emptyTokens, TaskUsageSchema, type TaskUsage } from "../../tasks/usage.js";

// `devin --print` emits presentation text, not a documented event stream. Turn
// logs are therefore authoritative only for final text; tool and token detail is unavailable.
export function devinResultText(log: string): string { return log.trim(); }
export interface DevinTurn {
  id: string;
  text: string;
  textAt: number;
  startedAt: number;
  completedAt: number | null;
  failed: boolean;
  running: boolean;
}
export function devinHistory(turns: readonly DevinTurn[]): NativeHistoryMessage[] {
  return turns.filter(turn => turn.text).map(turn => ({ id: turn.id, role: "assistant" as const, createdAt: turn.textAt, content: [{ id: `${turn.id}:text`, type: "text" as const, text: turn.text }] }));
}
export function devinUsage(turns: readonly DevinTurn[], sessionId: string, role: TaskUsage["role"]): TaskUsage[] {
  return turns.map(turn => TaskUsageSchema.parse({ sessionId, messageId: turn.id, turnId: turn.id, role, provider: "devin", model: "unknown", startedAt: turn.startedAt, completedAt: turn.completedAt, failed: turn.failed, summary: false, steps: turn.completedAt === null ? 0 : 1, cost: 0, subsidized: false, tokens: emptyTokens(), source: "message" }));
}

import type { ForgeDatabase } from "./database.js";
import { json } from "./task-utils.js";

export type OperationKind = "turn" | "repair" | "merge" | "push";

export type ClaimResult =
  | { status: "acquired" }
  | { status: "in_progress" }
  | { status: "settled" | "failed"; result: unknown | null };

export type SettlementResult =
  | { applied: true }
  | { applied: false; status: "settled" | "failed"; result: unknown | null };

export function operationKey(parts: Array<string | number | null | undefined>): string {
  return parts.map(String).join("|");
}

export function claimOperation(database: ForgeDatabase, input: { key: string; taskId: string; kind: OperationKind }): ClaimResult {
  return database.authTransaction((db) => {
    const now = new Date().toISOString();
    const inserted = db.prepare("INSERT OR IGNORE INTO forge_operation_claims (operation_key, task_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'claimed', ?, ?)").run(input.key, input.taskId, input.kind, now, now);
    if (inserted.changes === 1) return { status: "acquired" };
    const existing = db.prepare("SELECT status, result_json AS resultJson FROM forge_operation_claims WHERE operation_key = ?").get(input.key) as { status: "claimed" | "settled" | "failed"; resultJson: string | null } | undefined;
    if (!existing) throw new Error("Operation claim disappeared during lookup");
    if (existing.status === "claimed") return { status: "in_progress" };
    return { status: existing.status, result: existing.resultJson ? json(existing.resultJson, null) : null };
  });
}

export function settleOperation(database: ForgeDatabase, key: string, status: "settled" | "failed", result?: unknown): SettlementResult {
  return database.authTransaction((db) => {
    const updated = db.prepare("UPDATE forge_operation_claims SET status = ?, result_json = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed'")
      .run(status, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), key);
    if (updated.changes === 1) return { applied: true };
    const existing = db.prepare("SELECT status, result_json AS resultJson FROM forge_operation_claims WHERE operation_key = ?").get(key) as { status: "claimed" | "settled" | "failed"; resultJson: string | null } | undefined;
    if (!existing) throw new Error("Operation claim disappeared during settlement");
    if (existing.status === "claimed") throw new Error("Operation claim could not be settled");
    return { applied: false, status: existing.status, result: existing.resultJson ? json(existing.resultJson, null) : null };
  });
}

/**
 * Persist a cancellation even when the activity has not yet acquired a local
 * worker slot. A terminal result always wins this race.
 */
export function cancelOperation(database: ForgeDatabase, input: { key: string; taskId: string; kind: OperationKind }): void {
  const result = { status: "failed", reasonCode: "cancelled", summary: "Cancelled before the turn started" };
  database.authTransaction((db) => {
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO forge_operation_claims (operation_key, task_id, kind, status, result_json, created_at, updated_at) VALUES (?, ?, ?, 'failed', ?, ?, ?)")
      .run(input.key, input.taskId, input.kind, JSON.stringify(result), now, now);
    db.prepare("UPDATE forge_operation_claims SET status = 'failed', result_json = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed'")
      .run(JSON.stringify(result), now, input.key);
  });
}

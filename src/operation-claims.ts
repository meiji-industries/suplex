import type { ForgeDatabase } from "./database.js";
import { json } from "./task-utils.js";

export type OperationKind = "turn" | "repair" | "merge" | "push";

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; status: "claimed" | "settled" | "failed"; result: unknown | null };

export function operationKey(parts: Array<string | number | null | undefined>): string {
  return parts.map(String).join("|");
}

export function claimOperation(database: ForgeDatabase, input: { key: string; taskId: string; kind: OperationKind }): ClaimResult {
  return database.authTransaction((db) => {
    const now = new Date().toISOString();
    const inserted = db.prepare("INSERT OR IGNORE INTO forge_operation_claims (operation_key, task_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'claimed', ?, ?)").run(input.key, input.taskId, input.kind, now, now);
    if (inserted.changes === 1) return { claimed: true };
    const existing = db.prepare("SELECT status, result_json AS resultJson FROM forge_operation_claims WHERE operation_key = ?").get(input.key) as { status: "claimed" | "settled" | "failed"; resultJson: string | null } | undefined;
    if (!existing) throw new Error("Operation claim disappeared during lookup");
    return { claimed: false, status: existing.status, result: existing.resultJson ? json(existing.resultJson, null) : null };
  });
}

export function settleOperation(database: ForgeDatabase, key: string, status: "settled" | "failed", result?: unknown): void {
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_operation_claims SET status = ?, result_json = ?, updated_at = ? WHERE operation_key = ?").run(status, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), key);
  });
}

/**
 * Persist a cancellation even when the activity has not yet acquired a local
 * worker slot. A completed result always wins this race.
 */
export function cancelOperation(database: ForgeDatabase, input: { key: string; taskId: string; kind: OperationKind }): void {
  const result = { status: "failed", reasonCode: "cancelled", summary: "Cancelled before the turn started" };
  database.authTransaction((db) => {
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO forge_operation_claims (operation_key, task_id, kind, status, result_json, created_at, updated_at) VALUES (?, ?, ?, 'failed', ?, ?, ?)")
      .run(input.key, input.taskId, input.kind, JSON.stringify(result), now, now);
    db.prepare("UPDATE forge_operation_claims SET status = 'failed', result_json = ?, updated_at = ? WHERE operation_key = ? AND status <> 'settled'")
      .run(JSON.stringify(result), now, input.key);
  });
}

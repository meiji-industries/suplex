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

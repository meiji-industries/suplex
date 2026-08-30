import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type { ForgeDatabase } from "./database.js";
import { json } from "./task-utils.js";

export type OperationKind = "turn" | "repair" | "merge" | "push";

export interface OperationCoordinates {
  identity: Record<string, string | number | null>;
  authority: Record<string, string | number | boolean | null>;
}

export interface OperationOwnership {
  ownerToken: string | null;
  generation: number;
}

export type ClaimResult =
  | { status: "acquired"; ownership: OperationOwnership; coordinates: OperationCoordinates }
  | { status: "in_progress" }
  | { status: "recoverable"; previousOwnership: OperationOwnership; coordinates: OperationCoordinates }
  | { status: "settled" | "failed"; result: unknown | null };

export type SettlementResult =
  | { applied: true }
  | { applied: false; status: "in_progress"; result: null }
  | { applied: false; status: "settled" | "failed"; result: unknown | null };

const hostIdentity = createHash("sha256").update(hostname()).digest("hex");
const processOwnerToken = `${hostIdentity}:${process.pid}:${randomUUID()}`;
const identityFailure = { reasonCode: "operation-identity-drift", summary: "Operation recovery identity changed" };
const ownerFailure = { reasonCode: "operation-owner-unverifiable", summary: "Operation owner identity could not be verified; manual recovery is required" };

function ownerProcessState(ownerToken: string): "alive" | "dead" | "unknown" {
  const [ownerHost, ownerPid, nonce, ...extra] = ownerToken.split(":");
  const pid = Number(ownerPid);
  if (extra.length || ownerHost !== hostIdentity || !nonce || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ESRCH" ? "dead" : "alive";
  }
}

export function operationKey(parts: Array<string | number | null | undefined>): string {
  return parts.map(String).join("|");
}

export function claimOperation(database: ForgeDatabase, input: { key: string; taskId: string; kind: OperationKind; coordinates: OperationCoordinates; ownerToken?: string; allowLegacyRecovery?: boolean; allowLegacyTerminal?: boolean }): ClaimResult {
  return database.authTransaction((db) => {
    const now = new Date().toISOString();
    const ownerToken = input.ownerToken ?? processOwnerToken;
    const coordinatesJson = JSON.stringify(input.coordinates);
    const inserted = db.prepare("INSERT OR IGNORE INTO forge_operation_claims (operation_key, task_id, kind, status, coordinates_json, owner_token, generation, created_at, updated_at) VALUES (?, ?, ?, 'claimed', ?, ?, 1, ?, ?)").run(input.key, input.taskId, input.kind, coordinatesJson, ownerToken, now, now);
    if (inserted.changes === 1) return { status: "acquired", ownership: { ownerToken, generation: 1 }, coordinates: input.coordinates };
    const existing = db.prepare("SELECT task_id AS taskId, kind, status, result_json AS resultJson, coordinates_json AS coordinatesJson, owner_token AS ownerToken, generation FROM forge_operation_claims WHERE operation_key = ?").get(input.key) as { taskId: string; kind: OperationKind; status: "claimed" | "settled" | "failed"; resultJson: string | null; coordinatesJson: string | null; ownerToken: string | null; generation: number } | undefined;
    if (!existing) throw new Error("Operation claim disappeared during lookup");
    const coordinates = existing.coordinatesJson ? json(existing.coordinatesJson, null) as OperationCoordinates | null : null;
    const identityMatches = coordinates && JSON.stringify(coordinates.identity) === JSON.stringify(input.coordinates.identity);
    const rowIdentityMatches = existing.taskId === input.taskId && existing.kind === input.kind;
    if (existing.status !== "claimed") {
      if (!rowIdentityMatches || (!coordinates && !input.allowLegacyTerminal) || (coordinates && !identityMatches)) return { status: "failed", result: identityFailure };
      return { status: existing.status, result: existing.resultJson ? json(existing.resultJson, null) : null };
    }
    let ownerState: "alive" | "dead" | "unknown";
    if (existing.ownerToken === null) ownerState = "dead";
    else if (existing.ownerToken === ownerToken) ownerState = "alive";
    else ownerState = ownerProcessState(existing.ownerToken);
    if (ownerState === "alive") return { status: "in_progress" };
    if (ownerState === "unknown") return { status: "failed", result: ownerFailure };
    if (!rowIdentityMatches || (!identityMatches && !(input.allowLegacyRecovery && !coordinates))) {
      const resultJson = JSON.stringify(identityFailure);
      const failed = existing.ownerToken === null
        ? db.prepare("UPDATE forge_operation_claims SET status = 'failed', result_json = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token IS NULL").run(resultJson, now, input.key, existing.generation)
        : db.prepare("UPDATE forge_operation_claims SET status = 'failed', result_json = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token = ?").run(resultJson, now, input.key, existing.generation, existing.ownerToken);
      return failed.changes === 1 ? { status: "failed", result: identityFailure } : { status: "in_progress" };
    }
    return { status: "recoverable", previousOwnership: { ownerToken: existing.ownerToken, generation: existing.generation }, coordinates: coordinates ?? input.coordinates };
  });
}

export function recoverOperation(database: ForgeDatabase, key: string, previous: OperationOwnership, ownerToken?: string, legacyCoordinates?: OperationCoordinates): OperationOwnership | null {
  const nextOwnerToken = ownerToken ?? processOwnerToken;
  const coordinatesJson = legacyCoordinates ? JSON.stringify(legacyCoordinates) : null;
  return database.authTransaction((db) => {
    const updated = previous.ownerToken === null
      ? db.prepare("UPDATE forge_operation_claims SET coordinates_json = COALESCE(coordinates_json, ?), owner_token = ?, generation = generation + 1, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token IS NULL").run(coordinatesJson, nextOwnerToken, new Date().toISOString(), key, previous.generation)
      : db.prepare("UPDATE forge_operation_claims SET coordinates_json = COALESCE(coordinates_json, ?), owner_token = ?, generation = generation + 1, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token = ?").run(coordinatesJson, nextOwnerToken, new Date().toISOString(), key, previous.generation, previous.ownerToken);
    return updated.changes === 1 ? { ownerToken: nextOwnerToken, generation: previous.generation + 1 } : null;
  });
}

export function releaseOperation(database: ForgeDatabase, key: string, ownership: OperationOwnership): boolean {
  return database.authTransaction((db) => db.prepare("UPDATE forge_operation_claims SET owner_token = NULL, generation = generation + 1, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token = ?")
    .run(new Date().toISOString(), key, ownership.generation, ownership.ownerToken).changes === 1);
}

export function settleOperation(database: ForgeDatabase, key: string, ownership: OperationOwnership, status: "settled" | "failed", result?: unknown): SettlementResult {
  return database.authTransaction((db) => {
    const updated = db.prepare("UPDATE forge_operation_claims SET status = ?, result_json = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token = ?")
      .run(status, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), key, ownership.generation, ownership.ownerToken);
    if (updated.changes === 1) return { applied: true };
    const existing = db.prepare("SELECT status, result_json AS resultJson FROM forge_operation_claims WHERE operation_key = ?").get(key) as { status: "claimed" | "settled" | "failed"; resultJson: string | null } | undefined;
    if (!existing) throw new Error("Operation claim disappeared during settlement");
    if (existing.status === "claimed") return { applied: false, status: "in_progress", result: null };
    return { applied: false, status: existing.status, result: existing.resultJson ? json(existing.resultJson, null) : null };
  });
}

/**
 * Persist a cancellation even when the activity has not yet acquired a local
 * worker slot. Unlike generic recovery, explicit cancellation intentionally
 * overrides live ownership; a terminal result always wins this race.
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

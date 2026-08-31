import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type { ForgeDatabase } from "./database.js";
import { json } from "./task-utils.js";

export type OperationKind = "turn" | "repair" | "merge" | "push";
export type OperationPhase = "prepared" | "executing";

export interface OperationCoordinates {
  identity: Record<string, string | number | null>;
  authority: Record<string, string | number | boolean | null>;
}

export interface OperationOwnership {
  ownerToken: string | null;
  generation: number;
}

export interface OperationExecution {
  key: string;
  ownership: OperationOwnership;
  signal?: AbortSignal;
}

export interface WorktreeMutationOwnership {
  worktreePath: string;
  ownerToken: string;
  generation: number;
}

export type ClaimResult =
  | { status: "acquired"; ownership: OperationOwnership; coordinates: OperationCoordinates; phase: OperationPhase }
  | { status: "in_progress" }
  | { status: "recoverable"; previousOwnership: OperationOwnership; coordinates: OperationCoordinates; phase: OperationPhase; legacy: boolean }
  | { status: "settled" | "failed"; result: unknown | null };

export type SettlementResult =
  | { applied: true }
  | { applied: false; status: "in_progress"; result: null }
  | { applied: false; status: "settled" | "failed"; result: unknown | null };

const leaseMs = 30_000;
const hostIdentity = createHash("sha256").update(hostname()).digest("hex");
const identityFailure = { reasonCode: "operation-identity-drift", summary: "Operation recovery identity changed" };
const ownerFailure = { reasonCode: "operation-owner-unverifiable", summary: "A prior operation still requires exact recovery" };

function ownerToken(): string {
  return `${hostIdentity}:${randomUUID()}`;
}

function leaseDeadline(now = Date.now()): string {
  return new Date(now + leaseMs).toISOString();
}

export function operationKey(parts: Array<string | number | null | undefined>): string {
  return parts.map(String).join("|");
}

export function claimOperation(database: ForgeDatabase, input: { key: string; taskId: string; kind: OperationKind; coordinates: OperationCoordinates; ownerToken?: string; allowLegacyRecovery?: boolean; allowLegacyTerminal?: boolean }): ClaimResult {
  return database.authTransaction((db) => {
    const now = new Date().toISOString();
    const token = input.ownerToken ?? ownerToken();
    const coordinatesJson = JSON.stringify(input.coordinates);
    const unresolved = db.prepare("SELECT lease_expires_at AS leaseExpiresAt FROM forge_operation_claims WHERE task_id = ? AND kind = ? AND operation_key <> ? AND status = 'claimed' ORDER BY updated_at DESC LIMIT 1").get(input.taskId, input.kind, input.key) as { leaseExpiresAt: string | null } | undefined;
    if (unresolved) return unresolved.leaseExpiresAt && unresolved.leaseExpiresAt > now ? { status: "in_progress" } : { status: "failed", result: ownerFailure };
    const inserted = db.prepare("INSERT OR IGNORE INTO forge_operation_claims (operation_key, task_id, kind, status, phase, coordinates_json, owner_token, generation, lease_expires_at, heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, 'claimed', 'prepared', ?, ?, 1, ?, ?, ?, ?)").run(input.key, input.taskId, input.kind, coordinatesJson, token, leaseDeadline(), now, now, now);
    if (inserted.changes === 1) return { status: "acquired", ownership: { ownerToken: token, generation: 1 }, coordinates: input.coordinates, phase: "prepared" };
    const existing = db.prepare("SELECT task_id AS taskId, kind, status, phase, result_json AS resultJson, coordinates_json AS coordinatesJson, owner_token AS ownerToken, generation, lease_expires_at AS leaseExpiresAt FROM forge_operation_claims WHERE operation_key = ?").get(input.key) as { taskId: string; kind: OperationKind; status: "claimed" | "settled" | "failed"; phase: OperationPhase | null; resultJson: string | null; coordinatesJson: string | null; ownerToken: string | null; generation: number; leaseExpiresAt: string | null } | undefined;
    if (!existing) throw new Error("Operation claim disappeared during lookup");
    const coordinates = existing.coordinatesJson ? json(existing.coordinatesJson, null) as OperationCoordinates | null : null;
    const identityMatches = coordinates && JSON.stringify(coordinates.identity) === JSON.stringify(input.coordinates.identity);
    const rowIdentityMatches = existing.taskId === input.taskId && existing.kind === input.kind;
    if (existing.status !== "claimed") {
      if (!rowIdentityMatches || (!coordinates && !input.allowLegacyTerminal) || (coordinates && !identityMatches)) return { status: "failed", result: identityFailure };
      return { status: existing.status, result: existing.resultJson ? json(existing.resultJson, null) : null };
    }
    if (existing.leaseExpiresAt && existing.leaseExpiresAt > now) return { status: "in_progress" };
    if (!rowIdentityMatches || (!identityMatches && !(input.allowLegacyRecovery && !coordinates))) return { status: "failed", result: identityFailure };
    return { status: "recoverable", previousOwnership: { ownerToken: existing.ownerToken, generation: existing.generation }, coordinates: coordinates ?? input.coordinates, phase: existing.phase ?? "executing", legacy: !coordinates };
  });
}

export function recoverOperation(database: ForgeDatabase, key: string, previous: OperationOwnership, owner?: string, legacyCoordinates?: OperationCoordinates): OperationOwnership | null {
  const nextOwnerToken = owner ?? ownerToken();
  const coordinatesJson = legacyCoordinates ? JSON.stringify(legacyCoordinates) : null;
  const now = new Date().toISOString();
  return database.authTransaction((db) => {
    const updated = previous.ownerToken === null
      ? db.prepare("UPDATE forge_operation_claims SET coordinates_json = COALESCE(coordinates_json, ?), owner_token = ?, generation = generation + 1, lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token IS NULL AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").run(coordinatesJson, nextOwnerToken, leaseDeadline(), now, now, key, previous.generation, now)
      : db.prepare("UPDATE forge_operation_claims SET coordinates_json = COALESCE(coordinates_json, ?), owner_token = ?, generation = generation + 1, lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").run(coordinatesJson, nextOwnerToken, leaseDeadline(), now, now, key, previous.generation, previous.ownerToken, now);
    return updated.changes === 1 ? { ownerToken: nextOwnerToken, generation: previous.generation + 1 } : null;
  });
}

export function heartbeatOperation(database: ForgeDatabase, key: string, ownership: OperationOwnership): boolean {
  const now = new Date().toISOString();
  return database.authTransaction((db) => db.prepare("UPDATE forge_operation_claims SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token = ?")
    .run(leaseDeadline(), now, now, key, ownership.generation, ownership.ownerToken).changes === 1);
}

export function beginOperation(database: ForgeDatabase, key: string, ownership: OperationOwnership): boolean {
  const now = new Date().toISOString();
  return database.authTransaction((db) => {
    const updated = db.prepare("UPDATE forge_operation_claims SET phase = 'executing', lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND (phase = 'prepared' OR phase IS NULL) AND generation = ? AND owner_token = ?")
      .run(leaseDeadline(), now, now, key, ownership.generation, ownership.ownerToken);
    if (updated.changes === 1) return true;
    const existing = db.prepare("SELECT status, phase, owner_token AS ownerToken, generation FROM forge_operation_claims WHERE operation_key = ?").get(key) as { status: string; phase: string | null; ownerToken: string | null; generation: number } | undefined;
    return existing?.status === "claimed" && existing.phase === "executing" && existing.ownerToken === ownership.ownerToken && existing.generation === ownership.generation;
  });
}

export function fenceOperation(database: ForgeDatabase, key: string, ownership: OperationOwnership): boolean {
  const now = new Date().toISOString();
  return database.authTransaction((db) => db.prepare("UPDATE forge_operation_claims SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND phase = 'executing' AND generation = ? AND owner_token = ?")
    .run(leaseDeadline(), now, now, key, ownership.generation, ownership.ownerToken).changes === 1);
}

export function recordOperationEffect(database: ForgeDatabase, key: string, ownership: OperationOwnership, receipt: unknown): boolean {
  const receiptJson = JSON.stringify(receipt);
  return database.authTransaction((db) => {
    const updated = db.prepare("UPDATE forge_operation_claims SET effect_receipt_json = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND phase = 'executing' AND effect_receipt_json IS NULL AND generation = ? AND owner_token = ?")
      .run(receiptJson, new Date().toISOString(), key, ownership.generation, ownership.ownerToken);
    if (updated.changes === 1) return true;
    const existing = db.prepare("SELECT effect_receipt_json AS effectReceiptJson FROM forge_operation_claims WHERE operation_key = ? AND status = 'claimed' AND phase = 'executing' AND generation = ? AND owner_token = ?").get(key, ownership.generation, ownership.ownerToken) as { effectReceiptJson: string | null } | undefined;
    return existing?.effectReceiptJson === receiptJson;
  });
}

export function readOperationEffect(database: ForgeDatabase, key: string): unknown | null {
  const row = database.authQuery((db) => db.prepare("SELECT effect_receipt_json AS effectReceiptJson FROM forge_operation_claims WHERE operation_key = ?").get(key) as { effectReceiptJson: string | null } | undefined);
  return row?.effectReceiptJson ? json(row.effectReceiptJson, null) : null;
}

export function releaseOperation(database: ForgeDatabase, key: string, ownership: OperationOwnership, nextPhase: OperationPhase = "executing"): boolean {
  return database.authTransaction((db) => db.prepare("UPDATE forge_operation_claims SET phase = ?, owner_token = NULL, generation = generation + 1, lease_expires_at = NULL, heartbeat_at = ?, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND generation = ? AND owner_token = ?")
    .run(nextPhase, new Date().toISOString(), new Date().toISOString(), key, ownership.generation, ownership.ownerToken).changes === 1);
}

export function settleOperation(database: ForgeDatabase, key: string, ownership: OperationOwnership, status: "settled" | "failed", result?: unknown): SettlementResult {
  return database.authTransaction((db) => {
    const updated = db.prepare("UPDATE forge_operation_claims SET status = ?, result_json = ?, lease_expires_at = NULL, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND phase = 'executing' AND generation = ? AND owner_token = ?")
      .run(status, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), key, ownership.generation, ownership.ownerToken);
    if (updated.changes === 1) return { applied: true };
    const existing = db.prepare("SELECT status, result_json AS resultJson FROM forge_operation_claims WHERE operation_key = ?").get(key) as { status: "claimed" | "settled" | "failed"; resultJson: string | null } | undefined;
    if (!existing) throw new Error("Operation claim disappeared during settlement");
    if (existing.status === "claimed") return { applied: false, status: "in_progress", result: null };
    return { applied: false, status: existing.status, result: existing.resultJson ? json(existing.resultJson, null) : null };
  });
}

export function cancelOperation(database: ForgeDatabase, input: { key: string; taskId: string; kind: OperationKind }): void {
  const result = { status: "failed", reasonCode: "cancelled", summary: "Cancelled before the turn started" };
  const resultJson = JSON.stringify(result);
  database.authTransaction((db) => {
    const now = new Date().toISOString();
    const inserted = db.prepare("INSERT OR IGNORE INTO forge_operation_claims (operation_key, task_id, kind, status, phase, result_json, created_at, updated_at) VALUES (?, ?, ?, 'failed', 'prepared', ?, ?, ?)")
      .run(input.key, input.taskId, input.kind, resultJson, now, now);
    if (inserted.changes === 1) return;
    const existing = db.prepare("SELECT task_id AS taskId, kind, status, phase, owner_token AS ownerToken, generation FROM forge_operation_claims WHERE operation_key = ?").get(input.key) as { taskId: string; kind: OperationKind; status: string; phase: string | null; ownerToken: string | null; generation: number } | undefined;
    if (!existing || existing.taskId !== input.taskId || existing.kind !== input.kind || existing.status !== "claimed" || existing.phase !== "prepared") return;
    if (existing.ownerToken === null) {
      db.prepare("UPDATE forge_operation_claims SET status = 'failed', result_json = ?, lease_expires_at = NULL, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND phase = 'prepared' AND generation = ? AND owner_token IS NULL").run(resultJson, now, input.key, existing.generation);
    } else {
      db.prepare("UPDATE forge_operation_claims SET status = 'failed', result_json = ?, lease_expires_at = NULL, updated_at = ? WHERE operation_key = ? AND status = 'claimed' AND phase = 'prepared' AND generation = ? AND owner_token = ?").run(resultJson, now, input.key, existing.generation, existing.ownerToken);
    }
  });
}

export function acquireWorktreeMutation(database: ForgeDatabase, worktreePath: string, operationKeyValue: string, owner?: string): WorktreeMutationOwnership | null {
  const token = owner ?? ownerToken();
  const now = new Date().toISOString();
  return database.authTransaction((db) => {
    const inserted = db.prepare("INSERT OR IGNORE INTO forge_worktree_mutation_leases (worktree_path, operation_key, owner_token, generation, lease_expires_at, heartbeat_at) VALUES (?, ?, ?, 1, ?, ?)").run(worktreePath, operationKeyValue, token, leaseDeadline(), now);
    if (inserted.changes === 1) return { worktreePath, ownerToken: token, generation: 1 };
    const existing = db.prepare("SELECT owner_token AS ownerToken, generation, lease_expires_at AS leaseExpiresAt FROM forge_worktree_mutation_leases WHERE worktree_path = ?").get(worktreePath) as { ownerToken: string; generation: number; leaseExpiresAt: string } | undefined;
    if (!existing || existing.leaseExpiresAt > now) return null;
    const updated = db.prepare("UPDATE forge_worktree_mutation_leases SET operation_key = ?, owner_token = ?, generation = generation + 1, lease_expires_at = ?, heartbeat_at = ? WHERE worktree_path = ? AND generation = ? AND owner_token = ? AND lease_expires_at <= ?").run(operationKeyValue, token, leaseDeadline(), now, worktreePath, existing.generation, existing.ownerToken, now);
    return updated.changes === 1 ? { worktreePath, ownerToken: token, generation: existing.generation + 1 } : null;
  });
}

export function fenceWorktreeMutation(database: ForgeDatabase, ownership: WorktreeMutationOwnership): boolean {
  const now = new Date().toISOString();
  return database.authTransaction((db) => db.prepare("UPDATE forge_worktree_mutation_leases SET lease_expires_at = ?, heartbeat_at = ? WHERE worktree_path = ? AND generation = ? AND owner_token = ?")
    .run(leaseDeadline(), now, ownership.worktreePath, ownership.generation, ownership.ownerToken).changes === 1);
}

export function releaseWorktreeMutation(database: ForgeDatabase, ownership: WorktreeMutationOwnership): void {
  database.authTransaction((db) => db.prepare("DELETE FROM forge_worktree_mutation_leases WHERE worktree_path = ? AND generation = ? AND owner_token = ?").run(ownership.worktreePath, ownership.generation, ownership.ownerToken));
}

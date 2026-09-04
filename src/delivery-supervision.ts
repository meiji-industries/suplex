import { randomUUID } from "node:crypto";

import type { ForgeDatabase } from "./database.js";

const ownerKind = "delivery-owner";

export type DeliveryIntent = {
  taskId: string;
  companyId: string;
  workflowId: string;
  generation: number;
  projectRevisionId: string;
  repository?: string;
  branch?: string;
  target?: string;
  baseline?: string;
  objective?: string;
};

type DeliveryOperationRow = {
  id: string;
  operationKey: string;
  deliveryGeneration: number | null;
  ownerToken: string | null;
  ownerGeneration: number | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  cancelledAt: string | null;
  retryAt: string | null;
  completedAt: string | null;
};

export type DeliveryOwnerResult =
  | { outcome: "owned" | "recovered"; token: string; wakeAt: string }
  | { outcome: "owned_elsewhere"; wakeAt: string | null }
  | { outcome: "cancelled" };

function operationKey(intent: DeliveryIntent): string {
  return `delivery-owner:${intent.taskId}:${intent.workflowId}:${intent.generation}`;
}

function isoAfter(now: Date, leaseMs: number): string {
  return new Date(now.getTime() + leaseMs).toISOString();
}

function row(database: ForgeDatabase, intent: DeliveryIntent): DeliveryOperationRow | undefined {
  return database.authQuery((db) => db.prepare(`SELECT id, operation_key AS operationKey,
    delivery_generation AS deliveryGeneration, owner_token AS ownerToken,
    owner_generation AS ownerGeneration, lease_expires_at AS leaseExpiresAt,
    heartbeat_at AS heartbeatAt, cancelled_at AS cancelledAt, retry_at AS retryAt, completed_at AS completedAt
    FROM forge_provider_operations WHERE operation_key = ?`).get(operationKey(intent)) as DeliveryOperationRow | undefined);
}

export function claimOrRecoverDeliveryOwner(
  database: ForgeDatabase,
  intent: DeliveryIntent,
  options: { token?: string; now?: Date; leaseMs?: number; liveness: "live" | "stopped" | "unknown" },
): DeliveryOwnerResult {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseMs = options.leaseMs ?? 60_000;
  const token = options.token ?? randomUUID();
  const wakeAt = isoAfter(now, leaseMs);
  const key = operationKey(intent);
  let result: DeliveryOwnerResult | undefined;
  database.authTransaction((db) => {
    const newer = db.prepare(`SELECT 1 FROM forge_provider_operations WHERE kind = ? AND task_id = ? AND workflow_id = ?
      AND delivery_generation > ? AND cancelled_at IS NULL LIMIT 1`).get(ownerKind, intent.taskId, intent.workflowId, intent.generation);
    if (newer) { result = { outcome: "cancelled" }; return; }
    const existing = db.prepare(`SELECT id, operation_key AS operationKey,
      delivery_generation AS deliveryGeneration, owner_token AS ownerToken,
      owner_generation AS ownerGeneration, lease_expires_at AS leaseExpiresAt,
      heartbeat_at AS heartbeatAt, cancelled_at AS cancelledAt, retry_at AS retryAt, completed_at AS completedAt
      FROM forge_provider_operations WHERE operation_key = ?`).get(key) as DeliveryOperationRow | undefined;
    if (!existing) {
      const prior = db.prepare(`SELECT id FROM forge_provider_operations WHERE kind = ? AND task_id = ? AND workflow_id = ?
        AND delivery_generation < ? AND cancelled_at IS NULL`).all(ownerKind, intent.taskId, intent.workflowId, intent.generation) as Array<{ id: string }>;
      if (prior.length) db.prepare("UPDATE forge_provider_operations SET cancelled_at = ?, retry_at = NULL, updated_at = ? WHERE kind = ? AND task_id = ? AND workflow_id = ? AND delivery_generation < ? AND cancelled_at IS NULL")
        .run(nowIso, nowIso, ownerKind, intent.taskId, intent.workflowId, intent.generation);
      const observedElsewhere = options.liveness !== "stopped";
      db.prepare(`INSERT INTO forge_provider_operations
        (id, operation_key, task_id, company_id, workflow_id, project_revision_id, kind,
         result_json, delivery_generation, delivery_intent_json, owner_token, owner_generation,
         lease_expires_at, heartbeat_at, retry_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), key, intent.taskId, intent.companyId, intent.workflowId, intent.projectRevisionId,
          ownerKind, JSON.stringify({ derivedFrom: "Forge intent", outcome: "owned", observedAt: nowIso }),
          intent.generation, JSON.stringify(intent), observedElsewhere ? null : token, observedElsewhere ? null : intent.generation, observedElsewhere ? null : wakeAt, nowIso, wakeAt, nowIso, nowIso);
      result = observedElsewhere ? { outcome: "owned_elsewhere", wakeAt } : { outcome: "owned", token, wakeAt };
      return;
    }
    if (existing.cancelledAt || existing.deliveryGeneration !== intent.generation) {
      result = { outcome: "cancelled" };
      return;
    }
    const leaseExpired = !existing.leaseExpiresAt || Date.parse(existing.leaseExpiresAt) <= now.getTime();
    if (existing.completedAt) { result = { outcome: "owned_elsewhere", wakeAt: null }; return; }
    if (existing.ownerToken === token) {
      db.prepare("UPDATE forge_provider_operations SET heartbeat_at = ?, lease_expires_at = ?, retry_at = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL AND owner_token = ? AND owner_generation = ?")
        .run(nowIso, wakeAt, wakeAt, nowIso, existing.id, token, existing.ownerGeneration);
      result = { outcome: "owned", token, wakeAt };
      return;
    }
    // Expiry makes recovery eligible. It is never proof that the remote writer died.
    if (!leaseExpired || options.liveness === "live" || options.liveness === "unknown") {
      result = { outcome: "owned_elsewhere", wakeAt: existing.retryAt ?? existing.leaseExpiresAt };
      return;
    }
    const ownerGeneration = (existing.ownerGeneration ?? 0) + 1;
    const changed = db.prepare(`UPDATE forge_provider_operations
      SET owner_token = ?, owner_generation = ?, heartbeat_at = ?, lease_expires_at = ?, retry_at = ?,
          result_json = ?, updated_at = ?
      WHERE id = ? AND cancelled_at IS NULL AND delivery_generation = ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
      .run(token, ownerGeneration, nowIso, wakeAt, wakeAt,
        JSON.stringify({ derivedFrom: "Forge intent", outcome: "recovered", observedAt: nowIso }), nowIso,
        existing.id, intent.generation, nowIso).changes;
    result = changed ? { outcome: "recovered", token, wakeAt } : { outcome: "owned_elsewhere", wakeAt: existing.retryAt ?? existing.leaseExpiresAt };
  });
  return result!;
}

export function recordDeliveryObservation(database: ForgeDatabase, intent: DeliveryIntent, token: string, observation: unknown, now = new Date()): boolean {
  return database.authTransaction((db) => db.prepare(`UPDATE forge_provider_operations
    SET result_json = ?, observed_at = ?, updated_at = ?
    WHERE operation_key = ? AND delivery_generation = ?
      AND owner_token = ? AND cancelled_at IS NULL`)
    .run(JSON.stringify({ derivedFrom: "owner observation", observedAt: now.toISOString(), observation }), now.toISOString(), now.toISOString(), operationKey(intent), intent.generation, token).changes === 1);
}

export function scheduleDeliveryWake(database: ForgeDatabase, intent: DeliveryIntent, token: string, wakeAt: string): boolean {
  return database.authTransaction((db) => db.prepare(`UPDATE forge_provider_operations SET retry_at = ?, updated_at = ?
    WHERE operation_key = ? AND delivery_generation = ? AND owner_token = ? AND cancelled_at IS NULL`)
    .run(wakeAt, new Date().toISOString(), operationKey(intent), intent.generation, token).changes === 1);
}

export function completeDeliveryOperation(database: ForgeDatabase, intent: DeliveryIntent, token: string, receipt: unknown, now = new Date()): DeliveryOwnerResult["outcome"] {
  const changed = database.authTransaction((db) => db.prepare(`UPDATE forge_provider_operations
    SET result_json = ?, completed_at = ?, retry_at = NULL, updated_at = ?
    WHERE operation_key = ? AND delivery_generation = ? AND owner_token = ?
      AND cancelled_at IS NULL AND completed_at IS NULL`)
    .run(JSON.stringify({ derivedFrom: "Forge receipt", completedAt: now.toISOString(), receipt }), now.toISOString(), now.toISOString(), operationKey(intent), intent.generation, token).changes);
  return changed ? "owned" : row(database, intent)?.cancelledAt ? "cancelled" : "owned_elsewhere";
}

export function cancelDeliveryIntent(database: ForgeDatabase, intent: DeliveryIntent, now = new Date()): boolean {
  const timestamp = now.toISOString();
  return database.authTransaction((db) => {
    const changed = db.prepare(`UPDATE forge_provider_operations SET cancelled_at = ?, retry_at = NULL, updated_at = ?
      WHERE operation_key = ? AND delivery_generation = ? AND cancelled_at IS NULL`)
      .run(timestamp, timestamp, operationKey(intent), intent.generation).changes;
    if (changed) return true;
    if (db.prepare("SELECT 1 FROM forge_provider_operations WHERE operation_key = ?").get(operationKey(intent))) return false;
    db.prepare(`INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, workflow_id, project_revision_id, kind, delivery_generation, delivery_intent_json, cancelled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), operationKey(intent), intent.taskId, intent.companyId, intent.workflowId, intent.projectRevisionId, ownerKind, intent.generation, JSON.stringify(intent), timestamp, timestamp, timestamp);
    return true;
  });
}

export function dueDeliveryOperationKeys(database: ForgeDatabase, now = new Date()): string[] {
  return database.authQuery((db) => db.prepare(`SELECT operation_key AS operationKey FROM forge_provider_operations
    WHERE kind = ? AND cancelled_at IS NULL AND completed_at IS NULL AND retry_at IS NOT NULL AND retry_at <= ?`)
    .all(ownerKind, now.toISOString()) as Array<{ operationKey: string }>).map((item) => item.operationKey);
}

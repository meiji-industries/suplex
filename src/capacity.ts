import { randomBytes } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";

export type ExternalTurnKind = "lead" | "developer" | "review" | "ci-repair";
export type CapacityRequestStatus = "queued" | "active" | "released" | "cancelled" | "stale";

export interface CapacityRequest {
  id: string;
  companyId: string;
  taskId: string;
  workflowId: string;
  turnKind: ExternalTurnKind;
  status: CapacityRequestStatus;
  requestedAt: string;
  acquiredAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
}

export class CapacityFailure extends Error {
  constructor(readonly code: "not-found" | "not-owner" | "duplicate") {
    super(`Capacity request ${code}`);
    this.name = "CapacityFailure";
  }
}

function id(): string {
  return `capacity_${randomBytes(12).toString("hex")}`;
}

export class CapacityManager {
  constructor(private readonly database: ForgeDatabase, private readonly config: Pick<ForgeConfig, "externalTurnCapacity">) {}

  private row(raw: Record<string, unknown>): CapacityRequest {
    return { id: String(raw.id), companyId: String(raw.company_id), taskId: String(raw.task_id), workflowId: String(raw.workflow_id), turnKind: raw.turn_kind as ExternalTurnKind, status: raw.status as CapacityRequestStatus, requestedAt: String(raw.requested_at), acquiredAt: typeof raw.acquired_at === "string" ? raw.acquired_at : null, releasedAt: typeof raw.released_at === "string" ? raw.released_at : null, releaseReason: typeof raw.release_reason === "string" ? raw.release_reason : null };
  }

  request(input: { companyId: string; taskId: string; workflowId: string; turnKind: ExternalTurnKind; requestedAt?: string }): CapacityRequest {
    const requestedAt = input.requestedAt ?? new Date().toISOString();
    return this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT * FROM forge_capacity_requests WHERE task_id = ? AND turn_kind = ? AND status IN ('queued', 'active') ORDER BY requested_at, id LIMIT 1").get(input.taskId, input.turnKind) as Record<string, unknown> | undefined;
      if (existing) return this.row(existing);
      const requestId = id();
      db.prepare("INSERT INTO forge_capacity_requests (id, company_id, task_id, workflow_id, turn_kind, status, requested_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)").run(requestId, input.companyId, input.taskId, input.workflowId, input.turnKind, requestedAt);
      return this.row(db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown>);
    });
  }

  tryAcquire(requestId: string, now = new Date().toISOString()): { acquired: boolean; request: CapacityRequest } {
    return this.database.authTransaction((db) => {
      const rawRequest = db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown> | undefined;
      const request = rawRequest ? this.row(rawRequest) : undefined;
      if (!request) throw new CapacityFailure("not-found");
      if (request.status === "active") return { acquired: true, request };
      if (request.status !== "queued") return { acquired: false, request };
      const active = Number((db.prepare("SELECT COUNT(*) AS count FROM forge_capacity_requests WHERE status = 'active'").get() as { count: number }).count);
      const first = db.prepare("SELECT id FROM forge_capacity_requests WHERE status = 'queued' ORDER BY requested_at, id LIMIT 1").get() as { id: string } | undefined;
      if (active >= this.config.externalTurnCapacity || first?.id !== requestId) return { acquired: false, request };
      db.prepare("UPDATE forge_capacity_requests SET status = 'active', acquired_at = ? WHERE id = ? AND status = 'queued'").run(now, requestId);
      return { acquired: true, request: this.row(db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown>) };
    });
  }

  release(requestId: string, reason: string, now = new Date().toISOString()): boolean {
    return this.database.authTransaction((db) => db.prepare("UPDATE forge_capacity_requests SET status = 'released', released_at = ?, release_reason = ? WHERE id = ? AND status = 'active'").run(now, reason.slice(0, 500), requestId).changes === 1);
  }

  cancel(requestId: string, reason = "cancelled", now = new Date().toISOString()): boolean {
    return this.database.authTransaction((db) => db.prepare("UPDATE forge_capacity_requests SET status = 'cancelled', released_at = ?, release_reason = ? WHERE id = ? AND status = 'queued'").run(now, reason.slice(0, 500), requestId).changes === 1);
  }

  reconcile(activeRequestIds: Set<string>, reason = "worker-restart-reconciled", now = new Date().toISOString()): number {
    return this.database.authTransaction((db) => {
      const active = db.prepare("SELECT id FROM forge_capacity_requests WHERE status = 'active'").all() as Array<{ id: string }>;
      let released = 0;
      for (const row of active) if (!activeRequestIds.has(row.id)) released += db.prepare("UPDATE forge_capacity_requests SET status = 'stale', released_at = ?, release_reason = ? WHERE id = ? AND status = 'active'").run(now, reason, row.id).changes;
      return released;
    });
  }

  position(requestId: string): number | null {
    return this.database.authQuery((db) => {
      const request = db.prepare("SELECT requested_at, status FROM forge_capacity_requests WHERE id = ?").get(requestId) as { requested_at: string; status: string } | undefined;
      if (!request || request.status !== "queued") return null;
      return Number((db.prepare("SELECT COUNT(*) AS count FROM forge_capacity_requests WHERE status = 'queued' AND (requested_at < ? OR (requested_at = ? AND id <= ?))").get(request.requested_at, request.requested_at, requestId) as { count: number }).count);
    });
  }
}

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { resolveAgentProfiles } from "./projects.js";
import { AgentWrapperResultSchema, AgentWrapperStateSchema } from "./agent-wrapper.js";
import {
  CapacityExecutionOwnerSchema,
  CapacityRequestInputSchema,
  CapacityRequestSnapshotSchema,
  PublicCapacityStatusSchema,
  type AdminCapacityLane,
  type CapacityAdmissionResult,
  type CapacityExecutionOwner,
  type CapacityOperation,
  type CapacityRequestInput,
  type CapacityRequestSnapshot,
  type PublicCapacityStatus,
} from "./capacity-contracts.js";

export type ExternalTurnKind = "lead" | "developer" | "review" | "ci-repair";

export class CapacityFailure extends Error {
  constructor(readonly code: "not-found" | "not-owner" | "duplicate" | "conflict" | "stale-revision" | "profile-unavailable" | "invalid-status" | "stale-owner" | "ownership-ambiguous" | "deadline-exhausted") {
    super(`Capacity request ${code}`);
    this.name = "CapacityFailure";
  }
}

function id(): string {
  return `capacity_${randomBytes(12).toString("hex")}`;
}

function isoAfter(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function wrapperIsLive(wrapperPath: string | null | undefined): boolean {
  if (!wrapperPath) return false;
  try {
    const state = AgentWrapperStateSchema.safeParse(JSON.parse(readFileSync(`${wrapperPath}/state.json`, "utf8")));
    const result = (() => {
      try { return AgentWrapperResultSchema.safeParse(JSON.parse(readFileSync(`${wrapperPath}/result.json`, "utf8"))); }
      catch { return undefined; }
    })();
    return state.success && ["starting", "running"].includes(state.data.status) && (!result || !result.success);
  } catch {
    return false;
  }
}

function legacyOperation(turnKind: ExternalTurnKind): { operation: CapacityOperation; role: "planner" | "builder" | "reviewer" } {
  if (turnKind === "lead") return { operation: "lead_planning", role: "planner" };
  if (turnKind === "review") return { operation: "supplemental_review", role: "reviewer" };
  if (turnKind === "ci-repair") return { operation: "developer_repair", role: "builder" };
  return { operation: "developer_execution", role: "builder" };
}

function row(raw: Record<string, unknown>): CapacityRequestSnapshot {
  return CapacityRequestSnapshotSchema.parse({
    id: String(raw.id),
    logicalTurnKey: String(raw.logical_turn_key),
    companyId: String(raw.company_id),
    taskId: String(raw.task_id),
    workflowId: String(raw.workflow_id),
    projectRevisionId: String(raw.project_revision_id),
    workflowRevision: Number(raw.workflow_revision),
    operation: raw.operation,
    role: raw.role,
    profileId: String(raw.profile_id),
    provider: raw.provider,
    model: String(raw.model),
    reasoningLevel: raw.reasoning_level,
    servicePriority: raw.service_priority,
    laneKey: String(raw.lane_key),
    requestedCapacity: Number(raw.requested_capacity),
    status: raw.status,
    waitReason: typeof raw.wait_reason === "string" ? raw.wait_reason : null,
    skipReason: typeof raw.skip_reason === "string" ? raw.skip_reason : null,
    sessionRef: typeof raw.session_ref === "string" ? raw.session_ref : null,
    worktreePath: typeof raw.worktree_path === "string" ? raw.worktree_path : null,
    executionKind: raw.execution_kind === "agent" || raw.execution_kind === "developer" ? raw.execution_kind : null,
    executionId: typeof raw.execution_id === "string" ? raw.execution_id : null,
    requestedAt: String(raw.requested_at),
    deadlineAt: String(raw.deadline_at),
    acquiredAt: typeof raw.acquired_at === "string" ? raw.acquired_at : null,
    heartbeatAt: typeof raw.heartbeat_at === "string" ? raw.heartbeat_at : null,
    retryAt: typeof raw.retry_at === "string" ? raw.retry_at : null,
    cancelledAt: typeof raw.cancelled_at === "string" ? raw.cancelled_at : null,
    releasedAt: typeof raw.released_at === "string" ? raw.released_at : null,
    updatedAt: String(raw.updated_at),
    rateLimitAttempts: Number(raw.rate_limit_attempts),
    terminalReason: typeof raw.terminal_reason === "string" ? raw.terminal_reason : null,
  });
}

function toWorkflowState(request: CapacityRequestSnapshot, position: number | null = null): CapacityAdmissionResult["publicState"] {
  return {
    requestId: request.id,
    logicalTurnKey: request.logicalTurnKey,
    workflowRevision: request.workflowRevision,
    operation: request.operation,
    role: request.role,
    profileId: request.profileId,
    laneKey: request.laneKey,
    status: request.status,
    position,
    reason: request.waitReason,
    requestedAt: request.requestedAt,
    retryAt: request.retryAt,
    rateLimitAttempts: request.rateLimitAttempts,
  };
}

export class CapacityManager {
  private readonly waitLimitMs: number;
  private readonly enforceDeadline: boolean;

  constructor(private readonly database: ForgeDatabase, private readonly config: Pick<ForgeConfig, "externalTurnCapacity"> & Partial<Pick<ForgeConfig, "externalTurnWaitLimitMs" | "externalTurnRateLimitAttempts">>) {
    this.waitLimitMs = config.externalTurnWaitLimitMs ?? 7_200_000;
    this.enforceDeadline = config.externalTurnWaitLimitMs !== undefined;
  }

  request(rawInput: CapacityRequestInput | { companyId: string; taskId: string; workflowId: string; turnKind: ExternalTurnKind; requestedAt?: string }): CapacityRequestSnapshot & { turnKind?: ExternalTurnKind } {
    const input = "turnKind" in rawInput
      ? (() => {
        const legacy = legacyOperation(rawInput.turnKind);
        const profileId = this.database.authQuery((db) => {
          const selected = db.prepare("SELECT role_agents_json FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(rawInput.taskId, rawInput.companyId, rawInput.workflowId) as { role_agents_json: string } | undefined;
          let agents: Record<string, string> = {};
          try { agents = selected ? JSON.parse(selected.role_agents_json) as Record<string, string> : {}; } catch {}
          return resolveAgentProfiles(db, { [legacy.role]: agents[legacy.role] })[legacy.role] ?? "legacy-unresolved";
        });
        return { logicalTurnKey: `${rawInput.workflowId}:0:${legacy.operation}`, companyId: rawInput.companyId, taskId: rawInput.taskId, workflowId: rawInput.workflowId, projectRevisionId: "legacy", workflowRevision: 0, operation: legacy.operation, role: legacy.role, profileId, ...(rawInput.requestedAt ? { requestedAt: rawInput.requestedAt } : {}) } satisfies CapacityRequestInput;
      })()
      : CapacityRequestInputSchema.parse(rawInput);
    return this.database.authTransaction((db) => this.requestInTransaction(db, input));
  }

  private requestInTransaction(db: import("better-sqlite3").Database, input: CapacityRequestInput): CapacityRequestSnapshot & { turnKind?: ExternalTurnKind } {
    const existingRaw = db.prepare("SELECT * FROM forge_capacity_requests WHERE logical_turn_key = ? AND status IN ('queued', 'active', 'rate_limited', 'ownership_ambiguous')").get(input.logicalTurnKey) as Record<string, unknown> | undefined;
    if (existingRaw) {
      const existing = row(existingRaw);
      const immutableMatches = existing.companyId === input.companyId && existing.taskId === input.taskId && existing.workflowId === input.workflowId && existing.projectRevisionId === input.projectRevisionId && existing.workflowRevision === input.workflowRevision && existing.operation === input.operation && existing.role === input.role;
      if (!immutableMatches) throw new CapacityFailure("conflict");
      return existing;
    }

    const task = input.projectRevisionId === "legacy"
      ? db.prepare("SELECT role_agents_json FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId) as { role_agents_json: string } | undefined
      : db.prepare("SELECT role_agents_json FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ? AND project_revision_id = ?").get(input.taskId, input.companyId, input.workflowId, input.projectRevisionId) as { role_agents_json: string } | undefined;
    let effectiveProfileId = input.profileId;
    if (task) {
      let roleAgents: Record<string, string> = {};
      try { roleAgents = JSON.parse(task.role_agents_json) as Record<string, string>; } catch {}
      const agentId = roleAgents[input.role];
      const agent = typeof agentId === "string" ? db.prepare("SELECT profile_id FROM forge_agents WHERE id = ? AND role = ?").get(agentId, input.role) as { profile_id: string } | undefined : undefined;
      if (agent) effectiveProfileId = agent.profile_id;
    }
    const profile = effectiveProfileId === "legacy-unresolved"
      ? undefined
      : db.prepare("SELECT id, provider, model, reasoning_level, service_priority, capacity FROM forge_profiles WHERE id = ?").get(effectiveProfileId) as { id: string; provider: string; model: string; reasoning_level: string; service_priority: string; capacity: number | null } | undefined;
    if (!profile && effectiveProfileId !== "legacy-unresolved") throw new CapacityFailure("profile-unavailable");
    const requestedAt = input.requestedAt ?? new Date().toISOString();
    const requestedCapacity = profile?.capacity ?? this.config.externalTurnCapacity;
    const requestId = id();
    db.prepare(`INSERT INTO forge_capacity_requests (id, logical_turn_key, company_id, task_id, workflow_id, project_revision_id, workflow_revision, operation, role, profile_id, provider, model, reasoning_level, service_priority, lane_key, requested_capacity, status, requested_at, deadline_at, updated_at, rate_limit_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0)`).run(
      requestId, input.logicalTurnKey, input.companyId, input.taskId, input.workflowId, input.projectRevisionId, input.workflowRevision, input.operation, input.role,
      profile?.id ?? "legacy-unresolved", profile?.provider ?? "codex", profile?.model ?? "legacy-unresolved", profile?.reasoning_level ?? "medium", profile?.service_priority ?? "standard", `codex:${profile?.id ?? "legacy-unresolved"}`, requestedCapacity,
      requestedAt, isoAfter(requestedAt, this.waitLimitMs), requestedAt,
    );
    return row(db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown>);
  }

  inspect(requestId: string): CapacityRequestSnapshot {
    const raw = this.database.authQuery((db) => db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown> | undefined);
    if (!raw) throw new CapacityFailure("not-found");
    return row(raw);
  }

  tryAcquire(requestId: string, expectedWorkflowRevision = 0, now = new Date().toISOString()): CapacityAdmissionResult & { acquired: boolean; request: CapacityRequestSnapshot } {
    return this.database.authImmediateTransaction((db) => {
      const raw = db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown> | undefined;
      if (!raw) throw new CapacityFailure("not-found");
      let request = row(raw);
      if (request.workflowRevision !== expectedWorkflowRevision) throw new CapacityFailure("stale-revision");
      if (request.status === "active") return { status: "active", publicState: toWorkflowState(request), acquired: true, request };
      if (!(["queued", "rate_limited"] as string[]).includes(request.status)) return { status: request.status, publicState: toWorkflowState(request), acquired: false, request };
      if (request.status === "rate_limited") return { status: request.status, publicState: toWorkflowState(request), acquired: false, request };
      if (this.enforceDeadline && Date.parse(request.deadlineAt) <= Date.parse(now)) {
        db.prepare("UPDATE forge_capacity_requests SET status = 'exhausted', terminal_reason = 'wait_exhausted', updated_at = ?, released_at = ? WHERE id = ? AND status = 'queued'").run(now, now, requestId);
        request = row(db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown>);
        return { status: "exhausted", publicState: toWorkflowState(request), acquired: false, request };
      }

      const ownerConflict = this.conflictFor(db, request, requestId);
      if (ownerConflict) {
        this.setWait(db, requestId, ownerConflict, now);
        request = row(db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown>);
        return { status: request.status, publicState: toWorkflowState(request), acquired: false, request };
      }
      const effectiveCapacity = this.currentLaneCapacity(db, request.profileId);
      const activeCount = Number((db.prepare("SELECT COUNT(*) AS count FROM forge_capacity_requests WHERE lane_key = ? AND status IN ('active', 'ownership_ambiguous')").get(request.laneKey) as { count: number }).count);
      if (activeCount >= effectiveCapacity) {
        this.setWait(db, requestId, "lane_full", now);
        request = row(db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown>);
        return { status: request.status, publicState: toWorkflowState(request, this.positionInTransaction(db, requestId)), acquired: false, request };
      }

      const eligible = this.eligibleInTransaction(db, request.laneKey, now);
      const first = eligible[0];
      if (!first || first.id !== requestId) {
        this.setWait(db, requestId, "lane_full", now);
        request = row(db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown>);
        return { status: request.status, publicState: toWorkflowState(request, this.positionInTransaction(db, requestId)), acquired: false, request };
      }
      const changed = db.prepare("UPDATE forge_capacity_requests SET status = 'active', wait_reason = NULL, skip_reason = NULL, acquired_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, now, now, requestId).changes;
      if (changed !== 1) throw new CapacityFailure("duplicate");
      request = row(db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown>);
      return { status: "active", publicState: toWorkflowState(request), acquired: true, request };
    });
  }

  private currentLaneCapacity(db: import("better-sqlite3").Database, profileId: string): number {
    const profile = db.prepare("SELECT capacity FROM forge_profiles WHERE id = ?").get(profileId) as { capacity: number | null } | undefined;
    return profile?.capacity ?? this.config.externalTurnCapacity;
  }

  private conflictFor(db: import("better-sqlite3").Database, request: CapacityRequestSnapshot, excludeId: string): "issue_active" | "session_active" | "worktree_active" | null {
    if (db.prepare("SELECT id FROM forge_capacity_requests WHERE task_id = ? AND status IN ('active', 'ownership_ambiguous') AND id <> ? LIMIT 1").get(request.taskId, excludeId)) return "issue_active";
    if (request.sessionRef && db.prepare("SELECT id FROM forge_capacity_requests WHERE session_ref = ? AND status IN ('active', 'ownership_ambiguous') AND id <> ? LIMIT 1").get(request.sessionRef, excludeId)) return "session_active";
    if (request.worktreePath && db.prepare("SELECT id FROM forge_capacity_requests WHERE worktree_path = ? AND status IN ('active', 'ownership_ambiguous') AND id <> ? LIMIT 1").get(request.worktreePath, excludeId)) return "worktree_active";
    return null;
  }

  private staleWorkflowRevision(db: import("better-sqlite3").Database, request: CapacityRequestSnapshot): boolean {
    const projection = db.prepare("SELECT revision, state_json FROM forge_workflow_snapshots WHERE task_id = ? AND workflow_id = ? ORDER BY revision DESC LIMIT 1").get(request.taskId, request.workflowId) as { revision: number; state_json: string } | undefined;
    if (!projection || projection.revision <= request.workflowRevision) return false;
    try {
      const state = JSON.parse(projection.state_json) as { capacity?: { requestId?: string; workflowRevision?: number } | null };
      return state.capacity?.requestId !== request.id || state.capacity.workflowRevision !== request.workflowRevision;
    } catch {
      return true;
    }
  }

  private eligibleInTransaction(db: import("better-sqlite3").Database, laneKey: string, now: string): CapacityRequestSnapshot[] {
    const rows = (db.prepare("SELECT * FROM forge_capacity_requests WHERE lane_key = ? AND status = 'queued' ORDER BY requested_at, id").all(laneKey) as Array<Record<string, unknown>>).map((candidate) => row(candidate));
    return rows.filter((candidate) => {
      if (this.staleWorkflowRevision(db, candidate)) {
        db.prepare("UPDATE forge_capacity_requests SET status = 'stale', skip_reason = 'stale_workflow_revision', terminal_reason = 'proven_dead', released_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, now, candidate.id);
        return false;
      }
      return !this.conflictFor(db, candidate, candidate.id);
    });
  }

  private setWait(db: import("better-sqlite3").Database, requestId: string, reason: "lane_full" | "issue_active" | "session_active" | "worktree_active", now: string): void {
    db.prepare("UPDATE forge_capacity_requests SET wait_reason = ?, skip_reason = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(reason, reason, now, requestId);
  }

  private positionInTransaction(db: import("better-sqlite3").Database, requestId: string): number | null {
    const request = db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown> | undefined;
    if (!request || request.status !== "queued" || request.wait_reason !== null && request.wait_reason !== "lane_full") return null;
    const current = row(request);
    const eligible = this.eligibleInTransaction(db, current.laneKey, new Date().toISOString());
    const index = eligible.findIndex((candidate) => candidate.id === requestId);
    return index < 0 ? null : index + 1;
  }

  bindExecution(requestId: string, owner: CapacityExecutionOwner): CapacityRequestSnapshot {
    const validated = CapacityExecutionOwnerSchema.parse(owner);
    return this.database.authTransaction((db) => this.bindExecutionInTransaction(db, requestId, validated));
  }

  bindExecutionInTransaction(db: import("better-sqlite3").Database, requestId: string, owner: CapacityExecutionOwner): CapacityRequestSnapshot {
    const validated = CapacityExecutionOwnerSchema.parse(owner);
    let request = this.inspectInTransaction(db, requestId);
    if (request.status === "ownership_ambiguous" && !request.executionKind && !request.executionId && !request.sessionRef && !request.worktreePath) {
      const now = new Date().toISOString();
      db.prepare("UPDATE forge_capacity_requests SET status = 'active', terminal_reason = NULL, skip_reason = NULL, heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'ownership_ambiguous' AND execution_kind IS NULL AND execution_id IS NULL AND session_ref IS NULL AND worktree_path IS NULL").run(now, now, requestId);
      request = this.inspectInTransaction(db, requestId);
    }
    if (request.status !== "active") throw new CapacityFailure("invalid-status");
    if (request.executionId && (request.executionId !== validated.executionId || request.executionKind !== validated.executionKind)) throw new CapacityFailure("stale-owner");
    if (request.sessionRef && validated.sessionRef && request.sessionRef !== validated.sessionRef) throw new CapacityFailure("stale-owner");
    if (request.worktreePath && validated.worktreePath && request.worktreePath !== validated.worktreePath) throw new CapacityFailure("stale-owner");
    const now = new Date().toISOString();
    db.prepare("UPDATE forge_capacity_requests SET execution_kind = ?, execution_id = ?, session_ref = COALESCE(session_ref, ?), worktree_path = COALESCE(worktree_path, ?), heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(validated.executionKind, validated.executionId, validated.sessionRef ?? null, validated.worktreePath ?? null, now, now, requestId);
    return this.inspectInTransaction(db, requestId);
  }

  recordHeartbeat(requestId: string, executionId: string): void {
    this.database.authTransaction((db) => {
      const now = new Date().toISOString();
      const result = db.prepare("UPDATE forge_capacity_requests SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND execution_id = ?").run(now, now, requestId, executionId);
      if (result.changes !== 1) throw new CapacityFailure("not-owner");
    });
  }

  recordRateLimit(requestId: string, executionId: string, retryAt?: string): CapacityRequestSnapshot {
    return this.database.authTransaction((db) => {
      const request = this.inspectInTransaction(db, requestId);
      if (request.status !== "active" || request.executionId !== executionId) throw new CapacityFailure("not-owner");
      const now = new Date();
      const attempts = request.rateLimitAttempts + 1;
      const boundedRetryAt = retryAt && CapacityRequestSnapshotSchema.shape.retryAt.safeParse(retryAt).success && Date.parse(retryAt) > now.getTime() ? retryAt : new Date(now.getTime() + Math.min(900, 30 * 2 ** Math.max(0, attempts - 1)) * 1_000).toISOString();
      const exhausted = attempts >= (this.config.externalTurnRateLimitAttempts ?? 5) || Date.parse(request.deadlineAt) <= now.getTime();
      db.prepare("UPDATE forge_capacity_requests SET status = ?, wait_reason = ?, retry_at = ?, terminal_reason = ?, released_at = ?, execution_kind = CASE WHEN ? = 'exhausted' THEN execution_kind ELSE NULL END, execution_id = CASE WHEN ? = 'exhausted' THEN execution_id ELSE NULL END, rate_limit_attempts = ?, updated_at = ? WHERE id = ? AND status = 'active' AND execution_id = ?").run(exhausted ? "exhausted" : "rate_limited", exhausted ? null : "rate_limit_reset", exhausted ? null : boundedRetryAt, exhausted ? "wait_exhausted" : null, now.toISOString(), exhausted ? "exhausted" : "rate_limited", exhausted ? "exhausted" : "rate_limited", attempts, now.toISOString(), requestId, executionId);
      return this.inspectInTransaction(db, requestId);
    });
  }

  requeueRateLimited(requestId: string, now = new Date().toISOString()): CapacityRequestSnapshot {
    return this.database.authTransaction((db) => {
      const request = this.inspectInTransaction(db, requestId);
      if (request.status !== "rate_limited") return request;
      if (!request.retryAt || Date.parse(request.retryAt) > Date.parse(now)) return request;
      db.prepare("UPDATE forge_capacity_requests SET status = 'queued', wait_reason = NULL, retry_at = NULL, released_at = NULL, updated_at = ? WHERE id = ? AND status = 'rate_limited'").run(now, requestId);
      return this.inspectInTransaction(db, requestId);
    });
  }

  cancelQueued(requestId: string, reason = "cancelled", now = new Date().toISOString()): CapacityRequestSnapshot {
    return this.database.authTransaction((db) => {
      const request = this.inspectInTransaction(db, requestId);
      if (!["queued", "rate_limited"].includes(request.status)) throw new CapacityFailure("invalid-status");
      db.prepare("UPDATE forge_capacity_requests SET status = 'cancelled', cancelled_at = ?, released_at = ?, terminal_reason = 'cancelled', skip_reason = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'rate_limited')").run(now, now, reason.slice(0, 200), now, requestId);
      return this.inspectInTransaction(db, requestId);
    });
  }

  markOwnershipAmbiguous(requestId: string, reason: string, now = new Date().toISOString()): CapacityRequestSnapshot {
    return this.database.authTransaction((db) => {
      const request = this.inspectInTransaction(db, requestId);
      if (request.status === "ownership_ambiguous") return request;
      if (request.status !== "active") throw new CapacityFailure("invalid-status");
      db.prepare("UPDATE forge_capacity_requests SET status = 'ownership_ambiguous', terminal_reason = 'ownership_ambiguous', skip_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(reason.slice(0, 200), now, requestId);
      return this.inspectInTransaction(db, requestId);
    });
  }

  finalize(requestId: string, expectedExecutionId: string, terminalReason: CapacityRequestSnapshot["terminalReason"]): CapacityRequestSnapshot {
    if (!terminalReason) throw new CapacityFailure("invalid-status");
    return this.database.authTransaction((db) => {
      const request = this.inspectInTransaction(db, requestId);
      if (["released", "cancelled", "stale", "exhausted"].includes(request.status)) {
        if (request.executionId === expectedExecutionId && request.terminalReason === terminalReason) return request;
        throw new CapacityFailure("stale-owner");
      }
      if (request.status === "active" && !request.executionId && terminalReason === "failed_before_start" && expectedExecutionId === requestId) {
        const now = new Date().toISOString();
        db.prepare("UPDATE forge_capacity_requests SET status = 'released', released_at = ?, terminal_reason = ?, wait_reason = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND execution_id IS NULL").run(now, terminalReason, now, requestId);
        return this.inspectInTransaction(db, requestId);
      }
      if (request.status !== "active" || request.executionId !== expectedExecutionId) throw new CapacityFailure("not-owner");
      if (request.executionKind === "agent") {
        const execution = db.prepare("SELECT status, wrapper_path FROM forge_agent_executions WHERE id = ?").get(expectedExecutionId) as { status: string; wrapper_path: string | null } | undefined;
        if (execution && (["starting", "running", "cancelling", "ownership_ambiguous"].includes(execution.status) || wrapperIsLive(execution.wrapper_path))) throw new CapacityFailure("invalid-status");
      } else if (request.executionKind === "developer") {
        const execution = db.prepare("SELECT status, wrapper_path FROM forge_developer_executions WHERE id = ?").get(expectedExecutionId) as { status: string; wrapper_path: string | null } | undefined;
        if (execution && (["starting", "running", "cancelling", "ownership_ambiguous"].includes(execution.status) || wrapperIsLive(execution.wrapper_path))) throw new CapacityFailure("invalid-status");
      }
      const now = new Date().toISOString();
      db.prepare("UPDATE forge_capacity_requests SET status = 'released', released_at = ?, terminal_reason = ?, wait_reason = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND execution_id = ?").run(now, terminalReason, now, requestId, expectedExecutionId);
      return this.inspectInTransaction(db, requestId);
    });
  }

  private inspectInTransaction(db: import("better-sqlite3").Database, requestId: string): CapacityRequestSnapshot {
    const raw = db.prepare("SELECT * FROM forge_capacity_requests WHERE id = ?").get(requestId) as Record<string, unknown> | undefined;
    if (!raw) throw new CapacityFailure("not-found");
    return row(raw);
  }

  reconcile(activeRequestIds: Set<string>, reason = "worker-restart-reconciled", now = new Date().toISOString()): number {
    return this.database.authTransaction((db) => {
      const active = db.prepare("SELECT id FROM forge_capacity_requests WHERE status = 'active'").all() as Array<{ id: string }>;
      let released = 0;
      for (const item of active) if (!activeRequestIds.has(item.id)) released += db.prepare("UPDATE forge_capacity_requests SET status = 'stale', released_at = ?, terminal_reason = 'proven_dead', skip_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(now, reason.slice(0, 200), now, item.id).changes;
      return released;
    });
  }

  reconcileFromLedgers(now = new Date().toISOString()): number {
    return this.database.authTransaction((db) => {
      const rows = db.prepare("SELECT c.*, a.status AS agent_status, d.status AS developer_status FROM forge_capacity_requests c LEFT JOIN forge_agent_executions a ON a.id = c.execution_id AND c.execution_kind = 'agent' LEFT JOIN forge_developer_executions d ON d.id = c.execution_id AND c.execution_kind = 'developer' WHERE c.status IN ('active', 'ownership_ambiguous')").all() as Array<Record<string, unknown> & { id: string; status: string; execution_kind: string | null; execution_id: string | null; agent_status: string | null; developer_status: string | null }>;
      let changed = 0;
      for (const item of rows) {
        const live = item.agent_status && ["starting", "running", "cancelling"].includes(item.agent_status)
          || item.developer_status && ["starting", "running", "cancelling"].includes(item.developer_status);
        if (live) continue;
        const unprovable = item.agent_status === "ownership_ambiguous" || item.developer_status === "ownership_ambiguous"
          || !item.execution_kind || !item.execution_id || (!item.agent_status && !item.developer_status);
        if (unprovable) {
          // A request the workflow has already moved past can never be adjudicated:
          // it is proven dead, not ambiguous, so it must stop blocking the issue.
          if (this.staleWorkflowRevision(db, row(item))) {
            changed += db.prepare("UPDATE forge_capacity_requests SET status = 'stale', skip_reason = 'stale_workflow_revision', terminal_reason = 'proven_dead', released_at = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'ownership_ambiguous')").run(now, now, item.id).changes;
            continue;
          }
          changed += db.prepare("UPDATE forge_capacity_requests SET status = 'ownership_ambiguous', terminal_reason = 'ownership_ambiguous', skip_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run("Worker restart could not prove the external execution owner", now, item.id).changes;
          continue;
        }
        const terminalReason = item.agent_status === "completed" || item.developer_status === "completed" ? "completed" : item.agent_status === "cancelled" || item.developer_status === "cancelled" ? "cancelled" : "process_failed";
        changed += db.prepare("UPDATE forge_capacity_requests SET status = 'released', released_at = ?, terminal_reason = ?, wait_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('active', 'ownership_ambiguous')").run(now, terminalReason, now, item.id).changes;
      }
      return changed;
    });
  }

  statusForTask(taskId: string): PublicCapacityStatus | null {
    return this.database.authQuery((db) => {
      const raw = db.prepare(`SELECT c.*, ag.name AS agent_name, ag.avatar_seed FROM forge_capacity_requests c LEFT JOIN forge_tasks t ON t.id = c.task_id LEFT JOIN forge_agents ag ON ag.id = json_extract(t.role_agents_json, '$.' || c.role) WHERE c.task_id = ? AND c.status IN ('queued', 'active', 'rate_limited', 'ownership_ambiguous', 'exhausted') ORDER BY c.requested_at DESC, c.id DESC LIMIT 1`).get(taskId) as (Record<string, unknown> & { agent_name: string | null; avatar_seed: string | null }) | undefined;
      if (!raw || !raw.agent_name) return null;
      const request = row(raw);
      const position = request.status === "queued" ? this.positionInTransaction(db, request.id) : null;
      return PublicCapacityStatusSchema.parse({ profileId: request.profileId, agentName: raw.agent_name, avatarSeed: raw.avatar_seed, status: request.status, position, reason: request.waitReason, requestedAt: request.requestedAt, retryAt: request.retryAt });
    });
  }

  listAdminLanes(): AdminCapacityLane[] {
    return this.database.authQuery((db) => (db.prepare("SELECT id, name, capacity FROM forge_profiles ORDER BY name, id").all() as Array<{ id: string; name: string; capacity: number | null }>).map((profile) => {
      const counts = db.prepare("SELECT SUM(status = 'active' OR status = 'ownership_ambiguous') AS active_count, SUM(status = 'queued') AS queued_count, SUM(status = 'rate_limited') AS rate_limited_count, MIN(CASE WHEN status = 'queued' THEN requested_at END) AS oldest_queued_at FROM forge_capacity_requests WHERE lane_key = ?").get(`codex:${profile.id}`) as { active_count: number | null; queued_count: number | null; rate_limited_count: number | null; oldest_queued_at: string | null };
      return { profileId: profile.id, profileName: profile.name, provider: "codex" as const, capacity: profile.capacity, effectiveCapacity: profile.capacity ?? this.config.externalTurnCapacity, activeCount: Number(counts.active_count ?? 0), queuedCount: Number(counts.queued_count ?? 0), rateLimitedCount: Number(counts.rate_limited_count ?? 0), oldestQueuedAt: counts.oldest_queued_at };
    }));
  }

  position(requestId: string): number | null {
    return this.database.authQuery((db) => {
      const request = db.prepare("SELECT logical_turn_key, requested_at, status FROM forge_capacity_requests WHERE id = ?").get(requestId) as { logical_turn_key: string; requested_at: string; status: string } | undefined;
      if (request?.logical_turn_key.includes(":0:")) {
        if (request.status !== "queued") return null;
        return Number((db.prepare("SELECT COUNT(*) AS count FROM forge_capacity_requests WHERE status = 'queued' AND (requested_at < ? OR (requested_at = ? AND id <= ?))").get(request.requested_at, request.requested_at, requestId) as { count: number }).count);
      }
      return this.positionInTransaction(db, requestId);
    });
  }

  release(requestId: string, reason: string, now = new Date().toISOString()): boolean {
    void reason;
    const request = this.inspect(requestId);
    if (request.status !== "active") return false;
    if (!request.executionId) {
      if (!request.logicalTurnKey.includes(":0:")) return false;
      return this.database.authTransaction((db) => db.prepare("UPDATE forge_capacity_requests SET status = 'released', released_at = ?, terminal_reason = 'stored_result', updated_at = ? WHERE id = ? AND status = 'active'").run(now, now, requestId).changes === 1);
    }
    this.finalize(requestId, request.executionId, "completed");
    return true;
  }

  cancel(requestId: string, reason = "cancelled", now = new Date().toISOString()): boolean {
    try { this.cancelQueued(requestId, reason, now); return true; } catch (error) { if (error instanceof CapacityFailure && error.code === "invalid-status") return false; throw error; }
  }
}

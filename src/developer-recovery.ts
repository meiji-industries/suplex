import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { ForgeDatabase } from "./database.js";
import { DeveloperExecutionLeaseRepository, type DeveloperExecutionLease } from "./developer-execution-leases.js";
import { requestDeveloperSupervisor } from "./developer-supervisor.js";
import { DeveloperSupervisorSnapshotSchema, validateSupervisorResult, type DeveloperSupervisorResult } from "./developer-supervisor-protocol.js";
import { compareProcessIdentity, defaultProcessController, type ProcessInspection } from "./process-manager.js";
import type { DeveloperCancellationResult } from "./temporal/issue-contracts.js";

export interface DeveloperProcessInspection {
  pid: number;
  processGroupId: number;
  processStartIdentity: string;
  command: string;
  executable?: string;
  argv?: string[];
  ownerUid?: number;
}

export interface DeveloperProcessController {
  inspect(pid: number): Promise<DeveloperProcessInspection | undefined>;
  signalGroup(processGroupId: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  isProcessGroupAlive?: (processGroupId: number) => Promise<boolean>;
}

export interface DeveloperRecoveryOutcome {
  executionId: string;
  status: "active" | "recovered" | "interrupted" | "ownership_ambiguous";
  reason?: string;
}

export interface RestoredDeveloperRecoveryReport {
  executionId: string;
  status: "recovered" | "interrupted";
  reason: "stored-delivery-result" | "restore-invalidated-process-ownership";
}

export const DeveloperRecoveryObservationSchema = z.object({
  executionId: z.string().regex(/^developer_[a-f0-9]{24}$/),
  status: z.enum(["active", "result_ready", "interrupted", "ownership_ambiguous"]),
  reasonCode: z.string().max(100).nullable(),
  summary: z.string().max(500),
  lastHeartbeatAt: z.string().datetime().nullable(),
}).strict();
export type DeveloperRecoveryObservation = z.infer<typeof DeveloperRecoveryObservationSchema>;

const legacyController: DeveloperProcessController = {
  async inspect(pid) {
    const inspection = await defaultProcessController.inspect(pid);
    return inspection ? { pid: inspection.pid, processGroupId: inspection.processGroup, processStartIdentity: `${inspection.pid}:${inspection.startTime}`, command: inspection.command, executable: inspection.executable, argv: inspection.argv, ...(inspection.ownerUid !== undefined ? { ownerUid: inspection.ownerUid } : {}) } : undefined;
  },
  async signalGroup(processGroupId, signal) { await defaultProcessController.signalGroup?.(processGroupId, signal); },
  async isProcessGroupAlive(processGroupId) { return defaultProcessController.isProcessGroupAlive ? defaultProcessController.isProcessGroupAlive(processGroupId) : false; },
};

function toInspection(value: DeveloperProcessInspection): ProcessInspection {
  return { pid: value.pid, processGroup: value.processGroupId, startTime: value.processStartIdentity.includes(":") ? value.processStartIdentity.slice(value.processStartIdentity.indexOf(":") + 1) : value.processStartIdentity, command: value.command, executable: value.executable ?? value.argv?.[0] ?? value.command.split(/\s+/)[0] ?? "", argv: value.argv ?? value.command.split(/\s+/).filter(Boolean), ...(value.ownerUid !== undefined ? { ownerUid: value.ownerUid } : {}) };
}

async function readResult(lease: DeveloperExecutionLease): Promise<DeveloperSupervisorResult | undefined> {
  const handle = await open(join(lease.executionRoot, lease.resultPath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const result = validateSupervisorResult(JSON.parse(await handle.readFile("utf8")));
    return result.executionId === lease.executionId && result.leaseTokenHash === lease.leaseTokenHash ? result : undefined;
  } catch { return undefined; } finally { await handle.close(); }
}

function resultHashFromClaim(database: ForgeDatabase, executionId: string): string | undefined {
  return database.authQuery((db) => (db.prepare("SELECT result_hash FROM forge_developer_result_claims WHERE execution_id = ?").get(executionId) as { result_hash: string } | undefined)?.result_hash);
}

function activeLeases(database: ForgeDatabase): DeveloperExecutionLease[] {
  return new DeveloperExecutionLeaseRepository(database, "").listActive();
}

function markExecutionTerminal(database: ForgeDatabase, executionId: string, status: "cancelled" | "interrupted", failureCode: string | null, failureSummary: string | null): void {
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_developer_executions SET status = ?, finished_at = COALESCE(finished_at, ?), heartbeat_at = ?, failure_code = ?, failure_summary = ? WHERE id = ? AND status IN ('starting', 'running', 'cancelling', 'ownership_ambiguous')").run(status, now, now, failureCode, failureSummary, executionId);
    db.prepare("UPDATE forge_capacity_requests SET status = 'released', released_at = ?, terminal_reason = ?, wait_reason = NULL, updated_at = ? WHERE execution_kind = 'developer' AND execution_id = ? AND status IN ('active', 'ownership_ambiguous')").run(now, status === "interrupted" ? "process_failed" : "cancelled", now, executionId);
  });
}

/** Read-only observation. Workflow state changes belong to the Temporal Workflow. */
export function reconcileRestoredDeveloperExecutions(database: ForgeDatabase): RestoredDeveloperRecoveryReport[] {
  const rows = database.authQuery((db) => db.prepare("SELECT l.execution_id, l.status, c.execution_id AS claim_id FROM forge_developer_execution_leases l LEFT JOIN forge_developer_result_claims c ON c.execution_id = l.execution_id WHERE l.status IN ('reserved', 'supervisor_starting', 'running', 'result_ready', 'cancel_requested', 'cancelling') ORDER BY l.created_at, l.execution_id").all() as Array<{ execution_id: string; status: string; claim_id: string | null }>);
  const reports = rows.map((row) => row.claim_id ? { executionId: row.execution_id, status: "recovered" as const, reason: "stored-delivery-result" as const } : { executionId: row.execution_id, status: "interrupted" as const, reason: "restore-invalidated-process-ownership" as const });
  // Pre-lease executions can exist in backups created before the supervisor
  // lease ledger was introduced. Preserve the established restore behavior
  // for those rows while keeping the new lease path projection-free.
  const legacyRows = database.authQuery((db) => db.prepare("SELECT d.id FROM forge_developer_executions d LEFT JOIN forge_developer_execution_leases l ON l.execution_id = d.id WHERE l.execution_id IS NULL AND d.status IN ('starting', 'running', 'cancelling') ORDER BY d.started_at, d.id").all() as Array<{ id: string }>);
  if (legacyRows.length > 0) {
    database.authTransaction((db) => {
      for (const row of legacyRows) db.prepare("UPDATE forge_developer_executions SET status = 'interrupted', failure_code = 'restore-process-invalidated', failure_summary = 'Restore invalidated process ownership.' WHERE id = ? AND status IN ('starting', 'running', 'cancelling')").run(row.id);
    });
    reports.push(...legacyRows.map((row) => ({ executionId: row.id, status: "interrupted" as const, reason: "restore-invalidated-process-ownership" as const })));
  }
  return reports;
}

export async function reconcileDeveloperExecutions(database: ForgeDatabase, controller: DeveloperProcessController = legacyController): Promise<DeveloperRecoveryOutcome[]> {
  const rows = activeLeases(database);
  const outcomes: DeveloperRecoveryOutcome[] = [];
  for (const lease of rows) {
    if (resultHashFromClaim(database, lease.executionId)) {
      outcomes.push({ executionId: lease.executionId, status: "recovered", reason: "stored-delivery-result" });
      continue;
    }
    if (!lease.supervisor || !lease.child) {
      outcomes.push({ executionId: lease.executionId, status: "ownership_ambiguous", reason: "ownership-missing" });
      continue;
    }
    const supervisorInspection = await controller.inspect(lease.supervisor.pid);
    const supervisorComparison = supervisorInspection ? compareProcessIdentity({ name: "developer-supervisor", pid: lease.supervisor.pid, command: lease.supervisor.argv.join(" "), startedAt: lease.supervisor.startTime, processGroup: lease.supervisor.processGroup, startTime: lease.supervisor.startTime, executable: lease.supervisor.executable, argv: lease.supervisor.argv, ...(lease.supervisor.ownerUid !== null ? { ownerUid: lease.supervisor.ownerUid } : {}) }, toInspection(supervisorInspection)) : { kind: "not_running" as const };
    const inspection = await controller.inspect(lease.child.pid);
    if (!inspection) {
      // Release the lease too: the active-worktree unique index otherwise keeps
      // blocking every retry on this worktree with "lease was not created".
      new DeveloperExecutionLeaseRepository(database, "").setStatus(lease.executionId, "interrupted", ["reserved", "supervisor_starting", "running", "result_ready", "cancel_requested", "cancelling"]);
      markExecutionTerminal(database, lease.executionId, "interrupted", "worker-restart", "The recorded Developer process is gone; Forge marked the turn interrupted so the workflow can retry.");
      outcomes.push({ executionId: lease.executionId, status: "interrupted", reason: supervisorComparison.kind === "exact_match" ? "process-missing" : "supervisor-and-process-missing" });
      continue;
    }
    const comparison = compareProcessIdentity({ name: "developer", pid: lease.child.pid, command: lease.child.argv.join(" "), startedAt: lease.child.startTime, processGroup: lease.child.processGroup, startTime: lease.child.startTime, executable: lease.child.executable, argv: lease.child.argv, ...(lease.child.ownerUid !== null ? { ownerUid: lease.child.ownerUid } : {}) }, toInspection(inspection));
    outcomes.push(comparison.kind === "exact_match" && supervisorComparison.kind === "exact_match" ? { executionId: lease.executionId, status: "active" } : { executionId: lease.executionId, status: "ownership_ambiguous", reason: comparison.kind === "exact_match" ? `supervisor-${supervisorComparison.kind}` : comparison.kind });
  }
  return outcomes;
}

/**
 * Ask the durable supervisor to perform bounded cancellation. This function
 * never signals a PID or writes an issue projection.
 */
export async function cancelDeveloperExecution(database: ForgeDatabase, executionId: string, controller: DeveloperProcessController = legacyController): Promise<DeveloperCancellationResult> {
  const lease = database.authQuery((db) => db.prepare("SELECT * FROM forge_developer_execution_leases WHERE execution_id = ?").get(executionId) as Record<string, unknown> | undefined);
  if (!lease) return { status: "ownership_ambiguous", executionId, reasonCode: "developer-lease-missing", summary: "Forge cannot prove ownership of the previous Developer process." };
  const repository = new DeveloperExecutionLeaseRepository(database, dirname(dirname(String(lease.execution_root))));
  const current = repository.get(executionId);
  if (!current) return { status: "ownership_ambiguous", executionId, reasonCode: "developer-lease-missing", summary: "Forge cannot prove ownership of the previous Developer process." };
  const claim = repository.readClaim(executionId);
  if (claim) {
    try { return { status: "completed_before_cancellation", executionId, result: JSON.parse(claim.activityResultJson) as never, resultHash: claim.resultHash }; } catch { return { status: "ownership_ambiguous", executionId, reasonCode: "developer-claim-invalid", summary: "Forge cannot validate the completed Developer result." }; }
  }
  if (current.status === "interrupted") {
    markExecutionTerminal(database, executionId, "interrupted", "developer-child-missing", "The recorded Developer process is no longer running.");
    return { status: "interrupted", executionId, reasonCode: "developer-child-missing", summary: "The recorded Developer process is no longer running." };
  }
  if (current.status === "terminated") {
    markExecutionTerminal(database, executionId, "cancelled", null, null);
    return { status: "cancelled_confirmed", executionId, exitCode: current.exitCode, exitSignal: current.exitSignal, evidenceArtifactId: null };
  }
  if (!current.supervisor || !current.child) return { status: "ownership_ambiguous", executionId, reasonCode: "developer-ownership-incomplete", summary: "Forge cannot prove ownership of the previous Developer process." };
  const inspection = await controller.inspect(current.child.pid);
  if (!inspection) {
    if (controller.isProcessGroupAlive && await controller.isProcessGroupAlive(current.child.processGroup)) return { status: "ownership_ambiguous", executionId, reasonCode: "developer-child-group-live", summary: "Forge cannot prove ownership of the previous Developer process." };
    repository.setStatus(executionId, "interrupted", ["reserved", "supervisor_starting", "running", "result_ready", "cancel_requested", "cancelling"]);
    markExecutionTerminal(database, executionId, "interrupted", "developer-child-missing", "The recorded Developer process is no longer running.");
    return { status: "interrupted", executionId, reasonCode: "developer-child-missing", summary: "The recorded Developer process is no longer running." };
  }
  const supervisorInspection = await controller.inspect(current.supervisor.pid);
  if (!supervisorInspection) return { status: "ownership_ambiguous", executionId, reasonCode: "developer-supervisor-missing", summary: "Forge cannot prove ownership of the previous Developer process." };
  const supervisorComparison = compareProcessIdentity({ name: "developer-supervisor", pid: current.supervisor.pid, command: current.supervisor.argv.join(" "), startedAt: current.supervisor.startTime, processGroup: current.supervisor.processGroup, startTime: current.supervisor.startTime, executable: current.supervisor.executable, argv: current.supervisor.argv, ...(current.supervisor.ownerUid !== null ? { ownerUid: current.supervisor.ownerUid } : {}) }, toInspection(supervisorInspection));
  if (supervisorComparison.kind !== "exact_match") return { status: "ownership_ambiguous", executionId, reasonCode: `developer-supervisor-${supervisorComparison.kind}`, summary: "Forge cannot prove ownership of the previous Developer process." };
  const comparison = compareProcessIdentity({ name: "developer", pid: current.child.pid, command: current.child.argv.join(" "), startedAt: current.child.startTime, processGroup: current.child.processGroup, startTime: current.child.startTime, executable: current.child.executable, argv: current.child.argv, ...(current.child.ownerUid !== null ? { ownerUid: current.child.ownerUid } : {}) }, toInspection(inspection));
  if (comparison.kind !== "exact_match") return { status: "ownership_ambiguous", executionId, reasonCode: `developer-${comparison.kind}`, summary: "Forge cannot prove ownership of the previous Developer process." };
  const token = await repository.readLeaseToken(executionId).catch(() => undefined);
  if (!token) return { status: "ownership_ambiguous", executionId, reasonCode: "developer-lease-token-missing", summary: "Forge cannot prove ownership of the previous Developer process." };
  repository.setStatus(executionId, "cancel_requested", ["reserved", "supervisor_starting", "running", "result_ready"]);
  repository.recordCancellationEvidence(executionId, "cancellation_requested_at");
  repository.setStatus(executionId, "cancelling", ["cancel_requested"]);
  const response = await requestDeveloperSupervisor(current.executionRoot, { version: 1, command: "cancel", executionId, leaseToken: token, termGraceMs: 3_000, killGraceMs: 2_000 }).catch(() => null);
  if (!response) return { status: "termination_failed", executionId, reasonCode: "developer-supervisor-unavailable", summary: "Forge could not confirm that the Developer supervisor completed cancellation.", evidenceArtifactId: null };
  if (response.status === "ownership_ambiguous") return { status: "ownership_ambiguous", executionId, reasonCode: response.reasonCode, summary: response.summary };
  if (response.status === "termination_failed") return { status: "termination_failed", executionId, reasonCode: response.reasonCode, summary: response.summary, evidenceArtifactId: null };
  if (response.termSentAt) repository.recordCancellationEvidence(executionId, "term_sent_at", response.termSentAt);
  if (response.killSentAt) repository.recordCancellationEvidence(executionId, "kill_sent_at", response.killSentAt);
  let result: DeveloperSupervisorResult | undefined;
  for (let attempt = 0; attempt < 50 && !result; attempt += 1) {
    result = await readResult(current);
    if (!result) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!result) return { status: "termination_failed", executionId, reasonCode: "developer-result-missing-after-cancel", summary: "Forge could not confirm the cancelled Developer result.", evidenceArtifactId: null };
  const snapshot = await open(join(current.executionRoot, "supervisor.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).then(async (handle) => { try { return DeveloperSupervisorSnapshotSchema.parse(JSON.parse(await handle.readFile("utf8"))); } catch { return undefined; } finally { await handle.close(); } }).catch(() => undefined);
  if (snapshot?.termSentAt) repository.recordCancellationEvidence(executionId, "term_sent_at", snapshot.termSentAt);
  if (snapshot?.killSentAt) repository.recordCancellationEvidence(executionId, "kill_sent_at", snapshot.killSentAt);
  let completedClaim = repository.readClaim(executionId);
  for (let attempt = 0; !completedClaim && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    completedClaim = repository.readClaim(executionId);
  }
  if (completedClaim) {
    try { return { status: "completed_before_cancellation", executionId, result: JSON.parse(completedClaim.activityResultJson) as never, resultHash: completedClaim.resultHash }; } catch { return { status: "ownership_ambiguous", executionId, reasonCode: "developer-claim-invalid", summary: "Forge cannot validate the completed Developer result." }; }
  }
  const confirmedExitAt = snapshot?.confirmedExitAt ?? response.confirmedExitAt;
  if (!confirmedExitAt) {
    if (!snapshot?.termSentAt && !snapshot?.killSentAt) return { status: "ownership_ambiguous", executionId, reasonCode: "developer-result-claim-missing", summary: "The Developer produced a result before Forge could claim it or confirm cancellation." };
    return { status: "termination_failed", executionId, reasonCode: "developer-exit-unconfirmed", summary: "Forge could not confirm Developer process termination after signalling it.", evidenceArtifactId: null };
  }
  repository.recordCancellationEvidence(executionId, "confirmed_exit_at", confirmedExitAt);
  repository.setStatus(executionId, "terminated", ["cancel_requested", "cancelling", "result_ready"]);
  markExecutionTerminal(database, executionId, "cancelled", null, null);
  return { status: "cancelled_confirmed", executionId, exitCode: result.exitCode, exitSignal: result.exitSignal, evidenceArtifactId: null };
}

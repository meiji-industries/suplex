import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";

import { sha256 } from "./developer-supervisor-protocol.js";
import type { DeveloperSupervisorIdentity } from "./developer-supervisor-protocol.js";
import type { ForgeDatabase } from "./database.js";

export type DeveloperExecutionLeaseStatus = "reserved" | "supervisor_starting" | "running" | "result_ready" | "cancel_requested" | "cancelling" | "terminated" | "interrupted" | "ownership_ambiguous" | "failed";
export type DeveloperTurnKind = "implementation" | "repair" | "merge_conflict_resolution";

export interface DeveloperExecutionLease {
  executionId: string;
  companyId: string;
  taskId: string;
  workflowId: string;
  attempt: number;
  turnKind: DeveloperTurnKind;
  leaseTokenHash: string;
  executionRoot: string;
  canonicalWorktreePath: string;
  worktreeIdentityHash: string;
  protocolVersion: number;
  status: DeveloperExecutionLeaseStatus;
  supervisor: DeveloperSupervisorIdentity | null;
  child: DeveloperSupervisorIdentity | null;
  controlSocketPath: string;
  outputPath: string;
  resultPath: string;
  heartbeatAt: string | null;
  resultHash: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  outputTruncated: boolean;
  cancellationRequestedAt: string | null;
  termSentAt: string | null;
  killSentAt: string | null;
  confirmedExitAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperResultClaim {
  executionId: string;
  claimKey: string;
  resultHash: string;
  activityResultJson: string;
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  claimedAt: string;
}

export class DeveloperLeaseFailure extends Error {
  constructor(readonly code: "worktree-busy" | "lease-conflict" | "identity-conflict" | "claim-conflict" | "invalid-execution-root" | "unsafe-path" | "not-found" | "invalid-transition", message: string) {
    super(message);
    this.name = "DeveloperLeaseFailure";
  }
}

const executionIdPattern = /^developer_[a-f0-9]{24}$/;
const activeStatuses = ["reserved", "supervisor_starting", "running", "result_ready", "cancel_requested", "cancelling"] as const;
const terminalExecutionStatuses = ["completed", "blocked", "interrupted", "cancelled", "failed"] as const;

function now(): string { return new Date().toISOString(); }

/** Terminal executions must never retain the active-worktree lease slot. */
export function releaseDeveloperExecutionLease(db: Database.Database, executionId: string, status: Extract<DeveloperExecutionLeaseStatus, "terminated" | "interrupted"> = "terminated"): void {
  db.prepare(`UPDATE forge_developer_execution_leases SET status = ?, updated_at = ?
    WHERE execution_id = ? AND status IN (${activeStatuses.map(() => "?").join(",")})`)
    .run(status, now(), executionId, ...activeStatuses);
}

function identityFromRow(row: Record<string, unknown>, prefix: "supervisor" | "child"): DeveloperSupervisorIdentity | null {
  const pid = row[`${prefix}_pid`];
  const processGroup = row[`${prefix}_process_group`];
  const startTime = row[`${prefix}_start_time`];
  const executable = row[`${prefix}_executable`];
  const argvJson = row[`${prefix}_argv_json`];
  if (pid === null || processGroup === null || startTime === null || executable === null || argvJson === null) return null;
  let argv: unknown;
  try { argv = JSON.parse(String(argvJson)); } catch { throw new DeveloperLeaseFailure("identity-conflict", `${prefix} argv identity is invalid`); }
  if (!Array.isArray(argv)) throw new DeveloperLeaseFailure("identity-conflict", `${prefix} argv identity is invalid`);
  return {
    pid: Number(pid),
    processGroup: Number(processGroup),
    startTime: String(startTime),
    executable: String(executable),
    argv: argv.map(String),
    ownerUid: row[`${prefix}_owner_uid`] === null ? null : Number(row[`${prefix}_owner_uid`]),
  };
}

function row(raw: Record<string, unknown>): DeveloperExecutionLease {
  return {
    executionId: String(raw.execution_id), companyId: String(raw.company_id), taskId: String(raw.task_id), workflowId: String(raw.workflow_id),
    attempt: Number(raw.attempt), turnKind: raw.turn_kind as DeveloperTurnKind, leaseTokenHash: String(raw.lease_token_hash), executionRoot: String(raw.execution_root), canonicalWorktreePath: String(raw.canonical_worktree_path), worktreeIdentityHash: String(raw.worktree_identity_hash), protocolVersion: Number(raw.protocol_version), status: raw.status as DeveloperExecutionLeaseStatus,
    supervisor: identityFromRow(raw, "supervisor"), child: identityFromRow(raw, "child"), controlSocketPath: String(raw.control_socket_path), outputPath: String(raw.output_path), resultPath: String(raw.result_path), heartbeatAt: raw.heartbeat_at ? String(raw.heartbeat_at) : null, resultHash: raw.result_hash ? String(raw.result_hash) : null, exitCode: raw.exit_code === null ? null : Number(raw.exit_code), exitSignal: raw.exit_signal ? String(raw.exit_signal) : null, outputTruncated: Number(raw.output_truncated) === 1, cancellationRequestedAt: raw.cancellation_requested_at ? String(raw.cancellation_requested_at) : null, termSentAt: raw.term_sent_at ? String(raw.term_sent_at) : null, killSentAt: raw.kill_sent_at ? String(raw.kill_sent_at) : null, confirmedExitAt: raw.confirmed_exit_at ? String(raw.confirmed_exit_at) : null, createdAt: String(raw.created_at), updatedAt: String(raw.updated_at),
  };
}

function identityValues(identity: DeveloperSupervisorIdentity): [number, number, string, string, string, number | null] {
  return [identity.pid, identity.processGroup, identity.startTime, identity.executable, JSON.stringify(identity.argv), identity.ownerUid];
}

function identityMatches(left: DeveloperSupervisorIdentity | null, right: DeveloperSupervisorIdentity): boolean {
  return left?.pid === right.pid && left.processGroup === right.processGroup && left.startTime === right.startTime && left.executable === right.executable && JSON.stringify(left.argv) === JSON.stringify(right.argv) && left.ownerUid === right.ownerUid;
}

function requireExecutionId(executionId: string): void {
  if (!executionIdPattern.test(executionId)) throw new DeveloperLeaseFailure("invalid-execution-root", "Developer execution ID is invalid");
}

async function rejectSymlinkComponents(root: string, target: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const path = relative(absoluteRoot, absoluteTarget);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new DeveloperLeaseFailure("unsafe-path", "Developer execution path escapes the runtime root");
  let candidate = absoluteRoot;
  for (const part of path.split(sep).filter(Boolean)) {
    candidate = join(candidate, part);
    try {
      if ((await lstat(candidate)).isSymbolicLink()) throw new DeveloperLeaseFailure("unsafe-path", "Developer execution path cannot traverse a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function deriveDeveloperExecutionId(workflowId: string, planRevision: number, developerAttempt: number, turnKind: DeveloperTurnKind): string {
  if (!Number.isInteger(planRevision) || planRevision < 0 || !Number.isInteger(developerAttempt) || developerAttempt <= 0) throw new DeveloperLeaseFailure("invalid-execution-root", "Developer attempt coordinates are invalid");
  return `developer_${createHash("sha256").update(`${workflowId}\0${planRevision}\0${developerAttempt}\0${turnKind}`).digest("hex").slice(0, 24)}`;
}

export function claimKey(executionId: string, resultHash: string): string {
  return sha256(`${executionId}\0${resultHash}`);
}

export class DeveloperExecutionLeaseRepository {
  constructor(private readonly database: ForgeDatabase, private readonly runtimeRoot: string) {}

  executionRoot(executionId: string): string {
    requireExecutionId(executionId);
    return join(resolve(this.runtimeRoot), "developer-executions", executionId);
  }

  async ensureExecutionRoot(executionId: string): Promise<string> {
    const root = this.executionRoot(executionId);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.runtimeRoot, dirname(root));
    await mkdir(root, { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.runtimeRoot, root);
    return root;
  }

  async ensureLeaseToken(executionId: string): Promise<string> {
    const root = await this.ensureExecutionRoot(executionId);
    try { return await this.readLeaseToken(executionId); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const token = randomBytes(32).toString("base64url");
    const path = join(root, "lease-token");
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(token, "utf8"); } finally { await handle.close(); }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.readLeaseToken(executionId);
    }
  }

  async readLeaseToken(executionId: string): Promise<string> {
    const path = join(this.executionRoot(executionId), "lease-token");
    await rejectSymlinkComponents(this.runtimeRoot, path);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return (await handle.readFile("utf8")).trim(); } finally { await handle.close(); }
  }

  reserve(input: { executionId: string; companyId: string; taskId: string; workflowId: string; attempt: number; turnKind: DeveloperTurnKind; canonicalWorktreePath: string; worktreeIdentityHash: string; executionRoot?: string; leaseToken?: string; }): { lease: DeveloperExecutionLease; leaseToken: string | null; created: boolean } {
    return this.database.authTransaction((db) => this.reserveInTransaction(db, input));
  }

  reserveInTransaction(db: Database.Database, input: { executionId: string; companyId: string; taskId: string; workflowId: string; attempt: number; turnKind: DeveloperTurnKind; canonicalWorktreePath: string; worktreeIdentityHash: string; executionRoot?: string; leaseToken?: string; }): { lease: DeveloperExecutionLease; leaseToken: string | null; created: boolean } {
    requireExecutionId(input.executionId);
    const executionRoot = input.executionRoot ?? this.executionRoot(input.executionId);
    if (resolve(executionRoot) !== this.executionRoot(input.executionId)) throw new DeveloperLeaseFailure("invalid-execution-root", "Developer execution root is not canonical");
    const createdAt = now();
    const token = input.leaseToken ?? randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    // The partial unique index only protects active leases.  Older database
    // rows may still say active after their execution became terminal, so
    // release those stale slots before trying the new attempt.
    db.prepare(`UPDATE forge_developer_execution_leases
        SET status = 'interrupted', updated_at = ?
        WHERE canonical_worktree_path = ?
          AND status IN (${activeStatuses.map(() => "?").join(",")})
          AND EXISTS (SELECT 1 FROM forge_developer_executions
            WHERE id = forge_developer_execution_leases.execution_id
              AND status IN (${terminalExecutionStatuses.map(() => "?").join(",")}))`)
      .run(createdAt, input.canonicalWorktreePath, ...activeStatuses, ...terminalExecutionStatuses);
    const insert = db.prepare(`INSERT OR IGNORE INTO forge_developer_execution_leases (execution_id, company_id, task_id, workflow_id, attempt, turn_kind, lease_token_hash, execution_root, canonical_worktree_path, worktree_identity_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`);
    const result = insert.run(input.executionId, input.companyId, input.taskId, input.workflowId, input.attempt, input.turnKind, tokenHash, executionRoot, input.canonicalWorktreePath, input.worktreeIdentityHash, createdAt, createdAt);
    const existing = db.prepare("SELECT * FROM forge_developer_execution_leases WHERE execution_id = ? OR (workflow_id = ? AND attempt = ? AND turn_kind = ?)").get(input.executionId, input.workflowId, input.attempt, input.turnKind) as Record<string, unknown> | undefined;
    if (!existing) {
      const busy = db.prepare(`SELECT execution_id FROM forge_developer_execution_leases
          WHERE worktree_identity_hash = ? AND status IN (${activeStatuses.map(() => "?").join(",")})
        ORDER BY created_at LIMIT 1`).get(input.worktreeIdentityHash, ...activeStatuses) as { execution_id: string } | undefined;
      if (busy) throw new DeveloperLeaseFailure("worktree-busy", `Developer execution ${busy.execution_id} is still running on this worktree`);
      throw new DeveloperLeaseFailure("lease-conflict", "Developer execution lease conflicts with an existing lease");
    }
    const parsed = row(existing);
    if (parsed.executionId !== input.executionId || parsed.companyId !== input.companyId || parsed.taskId !== input.taskId || parsed.workflowId !== input.workflowId || parsed.attempt !== input.attempt || parsed.turnKind !== input.turnKind || parsed.canonicalWorktreePath !== input.canonicalWorktreePath || parsed.worktreeIdentityHash !== input.worktreeIdentityHash || (input.leaseToken !== undefined && parsed.leaseTokenHash !== tokenHash)) throw new DeveloperLeaseFailure("lease-conflict", "Developer execution lease identity conflicts with an existing attempt");
    return { lease: parsed, leaseToken: result.changes === 1 ? token : null, created: result.changes === 1 };
  }

  get(executionId: string): DeveloperExecutionLease | undefined {
    requireExecutionId(executionId);
    const raw = this.database.authQuery((db) => db.prepare("SELECT * FROM forge_developer_execution_leases WHERE execution_id = ?").get(executionId) as Record<string, unknown> | undefined);
    return raw ? row(raw) : undefined;
  }

  listActive(): DeveloperExecutionLease[] {
    const placeholders = activeStatuses.map(() => "?").join(",");
    return this.database.authQuery((db) => (db.prepare(`SELECT * FROM forge_developer_execution_leases WHERE status IN (${placeholders}) ORDER BY created_at, execution_id`).all(...activeStatuses) as Array<Record<string, unknown>>).map(row));
  }

  verifyLeaseToken(executionId: string, token: string): boolean {
    const lease = this.get(executionId);
    return Boolean(lease && sha256(token) === lease.leaseTokenHash);
  }

  setStatus(executionId: string, next: DeveloperExecutionLeaseStatus, prior: DeveloperExecutionLeaseStatus[]): boolean {
    const updatedAt = now();
    return this.database.authTransaction((db) => db.prepare(`UPDATE forge_developer_execution_leases SET status = ?, updated_at = ? WHERE execution_id = ? AND status IN (${prior.map(() => "?").join(",")})`).run(next, updatedAt, executionId, ...prior).changes === 1);
  }

  markSupervisorStarting(executionId: string): void {
    if (!this.setStatus(executionId, "supervisor_starting", ["reserved"])) throw new DeveloperLeaseFailure("invalid-transition", "Developer lease is not reserved for supervisor startup");
  }

  setSupervisorIdentity(executionId: string, identity: DeveloperSupervisorIdentity): void {
    const values = identityValues(identity);
    this.database.authTransaction((db) => {
      const lease = this.get(executionId);
      if (!lease) throw new DeveloperLeaseFailure("not-found", "Developer execution lease is unavailable");
      if (lease.supervisor) { if (!identityMatches(lease.supervisor, identity)) throw new DeveloperLeaseFailure("identity-conflict", "Developer supervisor identity changed"); return; }
      const result = db.prepare("UPDATE forge_developer_execution_leases SET supervisor_pid = ?, supervisor_process_group = ?, supervisor_start_time = ?, supervisor_executable = ?, supervisor_argv_json = ?, supervisor_owner_uid = ?, updated_at = ? WHERE execution_id = ? AND status = 'supervisor_starting' AND supervisor_pid IS NULL").run(...values, now(), executionId);
      if (result.changes !== 1) {
        const current = this.get(executionId);
        if (!current?.supervisor || !identityMatches(current.supervisor, identity)) throw new DeveloperLeaseFailure("identity-conflict", "Developer supervisor identity could not be persisted exactly once");
      }
    });
  }

  setChildIdentity(executionId: string, identity: DeveloperSupervisorIdentity): void {
    const values = identityValues(identity);
    this.database.authTransaction((db) => {
      const lease = this.get(executionId);
      if (!lease) throw new DeveloperLeaseFailure("not-found", "Developer execution lease is unavailable");
      if (lease.child) { if (!identityMatches(lease.child, identity)) throw new DeveloperLeaseFailure("identity-conflict", "Developer child identity changed"); return; }
      const result = db.prepare("UPDATE forge_developer_execution_leases SET child_pid = ?, child_process_group = ?, child_start_time = ?, child_executable = ?, child_argv_json = ?, child_owner_uid = ?, status = 'running', updated_at = ? WHERE execution_id = ? AND status IN ('supervisor_starting', 'reserved') AND child_pid IS NULL").run(...values, now(), executionId);
      if (result.changes !== 1) {
        const current = this.get(executionId);
        if (!current?.child || !identityMatches(current.child, identity)) throw new DeveloperLeaseFailure("identity-conflict", "Developer child identity could not be persisted exactly once");
      }
    });
  }

  heartbeat(executionId: string, heartbeatAt = now()): void {
    this.database.authQuery((db) => db.prepare("UPDATE forge_developer_execution_leases SET heartbeat_at = ?, updated_at = ? WHERE execution_id = ? AND status IN ('reserved', 'supervisor_starting', 'running', 'result_ready', 'cancel_requested', 'cancelling')").run(heartbeatAt, now(), executionId));
  }

  recordResultReady(executionId: string, result: { resultHash: string; exitCode: number | null; exitSignal: string | null; outputTruncated: boolean }): void {
    this.database.authQuery((db) => db.prepare("UPDATE forge_developer_execution_leases SET status = 'result_ready', result_hash = ?, exit_code = ?, exit_signal = ?, output_truncated = ?, heartbeat_at = ?, updated_at = ? WHERE execution_id = ? AND status IN ('reserved', 'supervisor_starting', 'running', 'cancelling', 'result_ready')").run(result.resultHash, result.exitCode, result.exitSignal, result.outputTruncated ? 1 : 0, now(), now(), executionId));
  }

  recordCancellationEvidence(executionId: string, field: "cancellation_requested_at" | "term_sent_at" | "kill_sent_at" | "confirmed_exit_at", value = now()): void {
    if (!/^(cancellation_requested_at|term_sent_at|kill_sent_at|confirmed_exit_at)$/.test(field)) throw new DeveloperLeaseFailure("unsafe-path", "Cancellation evidence field is invalid");
    this.database.authQuery((db) => db.prepare(`UPDATE forge_developer_execution_leases SET ${field} = ?, updated_at = ? WHERE execution_id = ?`).run(value, now(), executionId));
  }

  claim(input: { executionId: string; resultHash: string; activityResultJson: string; deliveryArtifactId: string; evidenceArtifactId: string; }): { claim: DeveloperResultClaim; conflict: boolean } {
    const key = claimKey(input.executionId, input.resultHash);
    const claimedAt = now();
    return this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT * FROM forge_developer_result_claims WHERE execution_id = ?").get(input.executionId) as Record<string, unknown> | undefined;
      if (existing) {
        const claim: DeveloperResultClaim = { executionId: String(existing.execution_id), claimKey: String(existing.claim_key), resultHash: String(existing.result_hash), activityResultJson: String(existing.activity_result_json), deliveryArtifactId: String(existing.delivery_artifact_id), evidenceArtifactId: String(existing.evidence_artifact_id), claimedAt: String(existing.claimed_at) };
        if (claim.resultHash !== input.resultHash) {
          db.prepare(`INSERT OR IGNORE INTO forge_developer_result_conflicts (id, execution_id, existing_result_hash, conflicting_result_hash, existing_delivery_artifact_id, existing_evidence_artifact_id, conflicting_delivery_artifact_id, conflicting_evidence_artifact_id, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`developer_result_conflict_${randomBytes(12).toString("hex")}`, input.executionId, claim.resultHash, input.resultHash, claim.deliveryArtifactId, claim.evidenceArtifactId, input.deliveryArtifactId, input.evidenceArtifactId, claimedAt);
          db.prepare("UPDATE forge_developer_execution_leases SET status = 'ownership_ambiguous', failure_code = 'developer-result-claim-conflict', failure_summary = ?, updated_at = ? WHERE execution_id = ?").run(`Conflicting Developer result hashes: ${claim.resultHash} and ${input.resultHash}.`, claimedAt, input.executionId);
          return { claim, conflict: true };
        }
        return { claim, conflict: false };
      }
      db.prepare("INSERT INTO forge_developer_result_claims (execution_id, claim_key, result_hash, activity_result_json, delivery_artifact_id, evidence_artifact_id, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.executionId, key, input.resultHash, input.activityResultJson, input.deliveryArtifactId, input.evidenceArtifactId, claimedAt);
      db.prepare("UPDATE forge_developer_execution_leases SET status = 'terminated', result_hash = ?, updated_at = ? WHERE execution_id = ? AND status IN ('result_ready', 'running', 'cancelling')").run(input.resultHash, claimedAt, input.executionId);
      return { claim: { executionId: input.executionId, claimKey: key, resultHash: input.resultHash, activityResultJson: input.activityResultJson, deliveryArtifactId: input.deliveryArtifactId, evidenceArtifactId: input.evidenceArtifactId, claimedAt }, conflict: false };
    });
  }

  readClaim(executionId: string): DeveloperResultClaim | undefined {
    const raw = this.database.authQuery((db) => db.prepare("SELECT * FROM forge_developer_result_claims WHERE execution_id = ?").get(executionId) as Record<string, unknown> | undefined);
    return raw ? { executionId: String(raw.execution_id), claimKey: String(raw.claim_key), resultHash: String(raw.result_hash), activityResultJson: String(raw.activity_result_json), deliveryArtifactId: String(raw.delivery_artifact_id), evidenceArtifactId: String(raw.evidence_artifact_id), claimedAt: String(raw.claimed_at) } : undefined;
  }
}

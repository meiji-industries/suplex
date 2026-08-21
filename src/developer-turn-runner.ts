import { ApplicationFailure, Context, CancelledFailure } from "@temporalio/activity";
import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ForgeConfig } from "./config.js";
import { compareProcessIdentity, defaultProcessController, type ProcessController } from "./process-manager.js";
import { DeveloperExecutionLeaseRepository, deriveDeveloperExecutionId, type DeveloperExecutionLease, type DeveloperResultClaim, type DeveloperTurnKind } from "./developer-execution-leases.js";
import { requestDeveloperSupervisor, spawnDeveloperSupervisor } from "./developer-supervisor.js";
import { DeveloperSupervisorInvocationSchema, DeveloperSupervisorSnapshotSchema, validateSupervisorResult, type DeveloperSupervisorIdentity, type DeveloperSupervisorInvocation, type DeveloperSupervisorResponse } from "./developer-supervisor-protocol.js";
import { cancelDeveloperExecution } from "./developer-recovery.js";

export interface DeveloperTurnRunInput {
  database: import("./database.js").ForgeDatabase;
  config: ForgeConfig;
  executionId: string;
  developerAttempt: number;
  planRevision: number;
  turnKind: DeveloperTurnKind;
  companyId: string;
  taskId: string;
  workflowId: string;
  canonicalWorktreePath: string;
  worktreeIdentityHash: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  controller?: ProcessController;
  spawnSupervisor?: typeof spawnDeveloperSupervisor;
  onMilestone?: (status: "active" | "reconnecting" | "result_pending_claim" | "cancellation_requested" | "cancelling") => Promise<void>;
  onStart?: (pid: number, startedAt: string) => Promise<void>;
  onLine?: (line: string) => Promise<void>;
}

export interface DeveloperTurnRunResult {
  executionId: string;
  resultHash: string;
  exitCode: number | null;
  exitSignal: string | null;
  lines: string[];
  outputTruncated: boolean;
  terminal: "result" | "interrupted" | "ownership_ambiguous";
  lastHeartbeatAt: string | null;
  claim?: DeveloperResultClaim;
}

function identityForLease(value: DeveloperSupervisorIdentity): import("./developer-supervisor-protocol.js").DeveloperSupervisorIdentity { return value; }

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
}

function stableInvocation(value: DeveloperSupervisorInvocation): DeveloperSupervisorInvocation {
  const guardDirectory = value.env.FORGE_GIT_GUARD_DIR;
  if (!guardDirectory) return value;
  const env = { ...value.env };
  delete env.FORGE_GIT_GUARD_DIR;
  if (env.PATH) env.PATH = env.PATH.split(process.platform === "win32" ? ";" : ":").filter((segment) => segment !== guardDirectory).join(process.platform === "win32" ? ";" : ":");
  return { ...value, env };
}

async function writeExclusiveOrVerify(path: string, content: string): Promise<void> {
  try { await writeExclusive(path, content); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = DeveloperSupervisorInvocationSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const current = DeveloperSupervisorInvocationSchema.parse(JSON.parse(content));
    if (JSON.stringify(stableInvocation(existing)) !== JSON.stringify(stableInvocation(current))) throw new Error("Developer execution input conflicts with the durable start record");
  }
}

async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
}

async function readEvents(root: string): Promise<string[]> {
  try {
    const raw = await readFile(join(root, "events.jsonl"), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { const value = JSON.parse(line) as { stream?: unknown; line?: unknown }; return value.stream === "stdout" && typeof value.line === "string" ? [value.line] : []; } catch { return []; }
    });
  } catch { return []; }
}

/**
 * A worker restart (a `tsx watch` hot reload, a deploy) cancels every running
 * Activity. The Developer supervisor is detached in its own process group and
 * survives that restart, so cancelling the turn here would throw away a live
 * agent turn. Only an operator's cancel request may signal the Developer.
 */
function cancelledByWorkerRestart(error: CancelledFailure): boolean {
  // Temporal sends this exact reason during Worker.shutdown(); cancellation
  // details describe workflow-level requests and do not contain this reason.
  return error.message === "WORKER_SHUTDOWN";
}

async function activitySleep(ms: number): Promise<void> {
  try { await Context.current().sleep(ms); } catch (error) { if (error instanceof CancelledFailure) throw error; await new Promise((resolve) => setTimeout(resolve, ms)); }
}

async function heartbeat(lease: DeveloperExecutionLease, repo: DeveloperExecutionLeaseRepository, lastSequence: number): Promise<void> {
  const at = new Date().toISOString();
  repo.heartbeat(lease.executionId, at);
  try { Context.current().heartbeat({ executionId: lease.executionId, status: lease.status, lastSequence }); } catch { /* Unit callers have no Activity context. */ }
}

export async function runDeveloperTurn(input: DeveloperTurnRunInput): Promise<DeveloperTurnRunResult> {
  const repo = new DeveloperExecutionLeaseRepository(input.database, input.config.runtimeRoot);
  const existingClaim = repo.readClaim(input.executionId);
  if (existingClaim) {
    return { executionId: input.executionId, resultHash: existingClaim.resultHash, exitCode: null, exitSignal: null, lines: [], outputTruncated: false, terminal: "result", lastHeartbeatAt: existingClaim.claimedAt, claim: existingClaim };
  }
  const controller = input.controller ?? defaultProcessController;
  const root = await repo.ensureExecutionRoot(input.executionId);
  let token = await repo.readLeaseToken(input.executionId).catch(() => undefined);
  if (!token) {
    const candidate = randomBytes(32).toString("base64url");
    try { await writeExclusive(join(root, "lease-token"), candidate); token = candidate; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      token = await repo.readLeaseToken(input.executionId);
    }
  }
  const leaseResult = repo.reserve({ executionId: input.executionId, companyId: input.companyId, taskId: input.taskId, workflowId: input.workflowId, attempt: input.developerAttempt, turnKind: input.turnKind, canonicalWorktreePath: input.canonicalWorktreePath, worktreeIdentityHash: input.worktreeIdentityHash, leaseToken: token });
  const lease = leaseResult.lease;
  const invocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId: lease.executionId, command: input.command, args: input.args, cwd: input.cwd, env: Object.fromEntries(Object.entries(input.env).filter(([key]) => key === "PATH" || key === "FORGE_GIT_REAL_BIN" || key === "FORGE_GIT_GUARD_DIR" || key === "MISE_TRUSTED_CONFIG_PATHS")) });
  await writeExclusiveOrVerify(join(root, "invocation.json"), `${JSON.stringify(invocation)}\n`);
  try { await writeFile(join(root, "events.jsonl"), "", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }

  const persistedSnapshot = await readJson(join(root, "supervisor.json")).then((value) => DeveloperSupervisorSnapshotSchema.parse(value)).catch(() => undefined);
  if (persistedSnapshot?.supervisor) repo.setSupervisorIdentity(lease.executionId, persistedSnapshot.supervisor);
  if (persistedSnapshot?.child) repo.setChildIdentity(lease.executionId, persistedSnapshot.child);
  const beforeStart = repo.get(lease.executionId);
  if (!beforeStart?.supervisor && !persistedSnapshot) {
    repo.setStatus(lease.executionId, "supervisor_starting", ["reserved"]);
    (input.spawnSupervisor ?? spawnDeveloperSupervisor)(root, token, invocation);
  }
  let lastStatus: "active" | "reconnecting" = lease.status === "reserved" ? "active" : "reconnecting";
  await input.onMilestone?.(lastStatus);
  let lastHeartbeat = lease.heartbeatAt;
  let startedChildPid: number | undefined;
  let streamedLines = 0;
  const streamEvents = async (): Promise<void> => {
    if (!input.onLine) return;
    // ponytail: reread the bounded 8 MiB spool; add byte-offset checkpoints only if this polling becomes measurable.
    const lines = await readEvents(root);
    while (streamedLines < lines.length) await input.onLine!(lines[streamedLines++]!);
  };
  const completedResult = async (): Promise<DeveloperTurnRunResult | undefined> => {
    try {
      const parsed = validateSupervisorResult(await readJson(join(root, lease.resultPath)));
      const output = await readFile(join(root, parsed.outputPath));
      if (createHash("sha256").update(output).digest("hex") !== parsed.outputSha256) throw new Error("Developer supervisor output hash is invalid");
      repo.recordResultReady(lease.executionId, { resultHash: parsed.resultHash, exitCode: parsed.exitCode, exitSignal: parsed.exitSignal, outputTruncated: parsed.outputTruncated });
      await input.onMilestone?.("result_pending_claim");
      await streamEvents();
      return { executionId: lease.executionId, resultHash: parsed.resultHash, exitCode: parsed.exitCode, exitSignal: parsed.exitSignal, lines: input.onLine ? [] : await readEvents(root), outputTruncated: parsed.outputTruncated, terminal: "result", lastHeartbeatAt: repo.get(lease.executionId)?.heartbeatAt ?? lastHeartbeat };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && /ENOENT|invalid|expected|received/i.test(error.message)) return undefined;
      throw error;
    }
  };
  // Measures how long the supervisor has been unreachable, not turn runtime:
  // reset on every successful status response so the startup and finalization
  // grace windows below stay bounded relative to the last confirmed contact.
  let noSupervisorSince = Date.now();
  try {
    for (;;) {
      await streamEvents();
      const current = repo.get(lease.executionId);
      if (!current) throw new Error("Developer execution lease disappeared");
      const result = await completedResult();
      if (result) return result;
      const snapshot = await readJson(join(root, "supervisor.json")).then((value) => DeveloperSupervisorSnapshotSchema.parse(value)).catch(() => undefined);
      if (snapshot?.supervisor && !current.supervisor) repo.setSupervisorIdentity(lease.executionId, snapshot.supervisor);
      if (snapshot?.child && !current.child) repo.setChildIdentity(lease.executionId, snapshot.child);
      const token = await repo.readLeaseToken(lease.executionId);
      let response: DeveloperSupervisorResponse | null = null;
      try { response = await requestDeveloperSupervisor(root, { version: 1, command: "status", executionId: lease.executionId, leaseToken: token }); } catch { response = null; }
      if (response) noSupervisorSince = Date.now();
      if (response && "child" in response && response.child) {
        repo.setChildIdentity(lease.executionId, identityForLease(response.child));
        if (startedChildPid !== response.child.pid) { startedChildPid = response.child.pid; await input.onStart?.(response.child.pid, response.child.startTime); }
        lastHeartbeat = response.heartbeatAt;
        await heartbeat(current, repo, 0);
      }
      if (response && response.status === "ownership_ambiguous") return { executionId: lease.executionId, resultHash: "", exitCode: null, exitSignal: null, lines: input.onLine ? [] : await readEvents(root), outputTruncated: false, terminal: "ownership_ambiguous", lastHeartbeatAt: lastHeartbeat };
      if (!response) {
        // The result file is the durable completion authority. Re-read it
        // after a failed socket request: the supervisor may have exited in
        // the narrow interval since the loop's first check.
        const result = await completedResult();
        if (result) return result;
        const latest = repo.get(lease.executionId);
        // A "failed" snapshot is the supervisor's own declaration that it
        // could not finish. Release the lease immediately so the worktree's
        // active-lease slot frees up for a retry.
        if (snapshot?.status === "failed") {
          repo.setStatus(lease.executionId, "interrupted", ["reserved", "supervisor_starting", "running", "result_ready", "cancel_requested", "cancelling"]);
          return { executionId: lease.executionId, resultHash: "", exitCode: null, exitSignal: null, lines: input.onLine ? [] : await readEvents(root), outputTruncated: false, terminal: "interrupted", lastHeartbeatAt: latest?.heartbeatAt ?? lastHeartbeat };
        }
        // The supervisor persists its own identity before it creates the
        // control socket and launches/persists the child. Treat that whole
        // bounded interval as startup; otherwise a busy host can make a
        // healthy turn look interrupted between those writes.
        if (latest?.status === "supervisor_starting" && !latest.child && Date.now() - noSupervisorSince < 30_000) {
          await activitySleep(250);
          continue;
        }
        if (latest?.child) {
          const child = await controller.inspect(latest.child.pid);
          if (child && compareProcessIdentity({ name: "developer", pid: latest.child.pid, command: latest.child.argv.join(" "), startedAt: latest.child.startTime, processGroup: latest.child.processGroup, startTime: latest.child.startTime, executable: latest.child.executable, argv: latest.child.argv, ...(latest.child.ownerUid !== null ? { ownerUid: latest.child.ownerUid } : {}) }, child).kind === "exact_match") return { executionId: lease.executionId, resultHash: "", exitCode: null, exitSignal: null, lines: input.onLine ? [] : await readEvents(root), outputTruncated: false, terminal: "ownership_ambiguous", lastHeartbeatAt: latest.heartbeatAt };
          // A short-lived child can exit and close the control socket just
          // before the supervisor's atomic result rename becomes visible.
          // Keep polling that bounded finalization window instead of falsely
          // classifying the turn as interrupted.
          if (Date.now() - noSupervisorSince < 30_000) {
            await activitySleep(250);
            continue;
          }
        }
        // An interrupted turn's process is confirmed gone; release the lease
        // so the worktree's active-lease slot frees up for a retry.
        repo.setStatus(lease.executionId, "interrupted", ["reserved", "supervisor_starting", "running", "result_ready", "cancel_requested", "cancelling"]);
        return { executionId: lease.executionId, resultHash: "", exitCode: null, exitSignal: null, lines: input.onLine ? [] : await readEvents(root), outputTruncated: false, terminal: "interrupted", lastHeartbeatAt: latest?.heartbeatAt ?? lastHeartbeat };
      }
      if (response.status === "running" && lastStatus !== "active") { lastStatus = "active"; await input.onMilestone?.("active"); }
      await activitySleep(500);
      const refreshed = repo.get(lease.executionId);
      if (refreshed) await heartbeat(refreshed, repo, 0);
    }
  } catch (error) {
    if (!(error instanceof CancelledFailure)) throw error;
    // Fail retryably instead of cancelling: the next Activity attempt reattaches
    // to the still-running supervisor and keeps polling its durable spool.
    if (cancelledByWorkerRestart(error)) throw ApplicationFailure.retryable("Forge restarted its worker while the Developer turn was running; the next attempt reattaches to the live supervisor.", "developer-worker-restart", { executionId: input.executionId });
    const cancellationController = {
      inspect: async (pid: number) => {
        const inspected = await controller.inspect(pid);
        return inspected ? { pid: inspected.pid, processGroupId: inspected.processGroup, processStartIdentity: `${inspected.pid}:${inspected.startTime}`, command: inspected.command, executable: inspected.executable, argv: inspected.argv, ...(inspected.ownerUid === undefined ? {} : { ownerUid: inspected.ownerUid }) } : undefined;
      },
      signalGroup: async (processGroupId: number, signal: "SIGTERM" | "SIGKILL") => { await controller.signalGroup?.(processGroupId, signal); },
      ...(controller.isProcessGroupAlive ? { isProcessGroupAlive: controller.isProcessGroupAlive } : {}),
    };
    const cancellation = await cancelDeveloperExecution(input.database, input.executionId, cancellationController).catch((cancellationError) => ({ status: "termination_failed" as const, executionId: input.executionId, reasonCode: "developer-cancellation-error", summary: cancellationError instanceof Error ? cancellationError.message : "Developer cancellation could not be confirmed", evidenceArtifactId: null }));
    if (cancellation.status === "ownership_ambiguous" || cancellation.status === "termination_failed") {
      throw ApplicationFailure.nonRetryable(cancellation.summary, cancellation.reasonCode, { executionId: input.executionId });
    }
    throw error;
  }
}

export { deriveDeveloperExecutionId };

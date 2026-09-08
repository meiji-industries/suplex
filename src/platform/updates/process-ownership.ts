import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ForgeConfig } from "../config.js";
import { processIdentityMatches, readProcessRegistry, type OwnedProcess, type ProcessController, type ProcessInspection } from "../process-manager.js";
import type { SelfUpdateOwnership, SelfUpdatePayload, SelfUpdateRunnerClaim } from "./self-update-contracts.js";

export type ProcessLiveness = "live" | "absent" | "unknown";
export type OwnershipFailure = (message: string, code?: string, statusCode?: 400 | 409 | 503) => Error;

export function processRecordFromInspection(inspection: ProcessInspection, startedAt: string): OwnedProcess {
  return {
    name: "server",
    pid: inspection.pid,
    command: inspection.command,
    startedAt,
    processGroup: inspection.processGroup,
    startTime: inspection.startTime,
    startId: randomUUID(),
    executable: inspection.executable,
    argv: inspection.argv,
    ...(inspection.ownerUid === undefined ? {} : { ownerUid: inspection.ownerUid }),
  };
}

export function sameCapturedIdentity(left: OwnedProcess, right: OwnedProcess): boolean {
  return left.pid === right.pid
    && left.command === right.command
    && left.startedAt === right.startedAt
    && left.processGroup === right.processGroup
    && left.startTime === right.startTime
    && left.startId === right.startId
    && left.executable === right.executable
    && JSON.stringify(left.argv) === JSON.stringify(right.argv)
    && left.ownerUid === right.ownerUid;
}

export function capturedIdentityFromInspection(inspection: ProcessInspection, name: string, startedAt: string): SelfUpdatePayload["serverIdentity"] {
  return {
    name,
    pid: inspection.pid,
    command: inspection.command,
    startedAt,
    processGroup: inspection.processGroup,
    startTime: inspection.startTime,
    startId: randomUUID(),
    executable: inspection.executable,
    argv: inspection.argv,
    ...(inspection.ownerUid === undefined ? {} : { ownerUid: inspection.ownerUid }),
  };
}

export async function inspectCapturedProcess(identity: SelfUpdatePayload["serverIdentity"], processController: ProcessController): Promise<ProcessLiveness> {
  const inspection = await processController.inspect(identity.pid);
  if (!inspection) return "absent";
  return processIdentityMatches(identity, inspection) ? "live" : "absent";
}

export async function inspectRunnerClaim(
  claim: SelfUpdateRunnerClaim,
  processController: ProcessController,
): Promise<ProcessLiveness> {
  const inspection = await processController.inspect(claim.pid);
  if (!inspection) return claim.identity ? "absent" : "unknown";
  return claim.identity && processIdentityMatches(claim.identity, inspection) ? "live" : claim.identity ? "absent" : "live";
}

export function watchOwnership(argv: readonly string[], execArgv: readonly string[], environment: NodeJS.ProcessEnv, parentInspection?: ProcessInspection): boolean {
  if (environment.FORGE_WATCH_MODE === "1") return true;
  const argumentsToInspect = [...argv, ...execArgv, ...(parentInspection?.argv ?? [])];
  return argumentsToInspect.some((argument) => argument === "watch"
    || argument === "--watch"
    || argument === "--watch-path"
    || argument === "--watch-preserve-output"
    || argument.startsWith("--watch=")
    || argument.startsWith("--watch-path="));
}

export async function rejectWatchOwnership(argv: readonly string[], execArgv: readonly string[], environment: NodeJS.ProcessEnv, parentInspection: ProcessInspection | undefined, failure: OwnershipFailure): Promise<void> {
  if (watchOwnership(argv, execArgv, environment, parentInspection)) throw failure("Forge cannot restart safely while a file watcher owns this server.", "watch_ownership_unsupported", 409);
}

export async function captureOwnership(options: {
  config: ForgeConfig;
  processController: ProcessController;
  now: () => Date;
  argv: readonly string[];
  execArgv: readonly string[];
  environment: NodeJS.ProcessEnv;
  failure: OwnershipFailure;
}): Promise<{ ownership: SelfUpdateOwnership; serverIdentity: OwnedProcess }> {
  const parentInspection = process.ppid > 1 ? await options.processController.inspect(process.ppid) : undefined;
  await rejectWatchOwnership(options.argv, options.execArgv, options.environment, parentInspection, options.failure);
  const registryFilename = join(options.config.runtimeRoot, "owned-processes.json");
  let registry;
  try {
    registry = await readProcessRegistry(registryFilename);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw options.failure("Forge could not validate its owned-process registry.", "ownership_registry_invalid");
    }
  }
  const inspection = await options.processController.inspect(process.pid);
  if (!inspection) throw options.failure("Forge could not prove ownership of its current server process.", "ownership_unproven");
  if (registry) {
    const servers = registry.processes.filter((process) => process.name === "server");
    const server = servers.length === 1 ? servers[0] : undefined;
    if (server && processIdentityMatches(server, inspection)) return { ownership: "registry", serverIdentity: server };
  }
  return { ownership: "direct", serverIdentity: processRecordFromInspection(inspection, options.now().toISOString()) };
}

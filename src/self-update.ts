import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { ForgeConfig } from "./config.js";
import { runCommand as defaultRunCommand, type CommandRunResult, type RunCommandInput } from "./command-runner.js";
import {
  defaultProcessController,
  processIdentityMatches,
  readProcessRegistry,
  type OwnedProcess,
  type ProcessController,
  type ProcessInspection,
} from "./process-manager.js";
import {
  FORGE_REPOSITORY,
  GIT_TIMEOUT_MS,
  matchingRemote,
  readCurrentRevision,
  requiredCommitRevision,
  inspectUpdateAvailability,
  type GitCommand,
  type UpdateAvailability,
} from "./update.js";
import {
  UpdateOperationStatusSchema,
  UPDATE_OPERATION_TIMEOUT_MS,
  type UpdateOperationStatus,
  type UpdateRestartResponse,
} from "./http/contracts/update.js";

export const SELF_UPDATE_STATUS_FILENAME = "update-status.json";
export const SELF_UPDATE_OPERATION_FILENAME = "update-operation.json";
export const SELF_UPDATE_LOCK_FILENAME = "update-operation.lock";
export const SELF_UPDATE_LOG_FILENAME = "self-update.log";
export const SELF_UPDATE_SERVER_LOG_FILENAME = "self-update-server.log";
export const SELF_UPDATE_RUNNER_CLAIM_FILENAME = "update-operation-runner.lock";

export const SELF_UPDATE_TIMEOUTS = {
  git: GIT_TIMEOUT_MS,
  install: 5 * 60_000,
  build: 5 * 60_000,
  restart: 30_000,
  operation: UPDATE_OPERATION_TIMEOUT_MS,
} as const;

const MAX_STATUS_TEXT = 2_000;
const ACTIVE_OPERATION_STATUSES = new Set<UpdateOperationStatus["status"]>(["pending", "preparing", "restarting"]);

const CapturedProcessIdentitySchema = z.object({
  name: z.string().min(1),
  pid: z.number().int().positive(),
  command: z.string().min(1),
  startedAt: z.string().min(1),
  processGroup: z.number().int().positive(),
  startTime: z.string().min(1),
  startId: z.string().min(1),
  executable: z.string().min(1),
  argv: z.array(z.string()).min(1),
  ownerUid: z.number().int().nonnegative().optional(),
}).strict();

const SelfUpdatePayloadSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  targetRevision: z.string().regex(/^[0-9a-f]{40}$/),
  ownership: z.enum(["direct", "registry"]),
  serverIdentity: CapturedProcessIdentitySchema,
  workingDirectory: z.string().min(1),
  config: z.object({
    accessMode: z.literal("tailscale"),
    tailscaleExposure: z.enum(["direct", "serve"]),
    bindAddress: z.string().min(1),
    reachableAddress: z.string().url(),
    port: z.number().int().min(1).max(65535),
    dataRoot: z.string().min(1),
    databasePath: z.string().min(1),
    artifactRoot: z.string().min(1),
    runtimeRoot: z.string().min(1),
    repositoryRoot: z.string().min(1),
    worktreeRoot: z.string().min(1),
    installationId: z.string().min(1),
    developmentAutoLogin: z.boolean(),
  }).strict(),
}).strict();

const UpdateLockSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  helper: CapturedProcessIdentitySchema.optional(),
}).strict();

const UpdateRunnerClaimSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  identity: CapturedProcessIdentitySchema.optional(),
}).strict();

export type SelfUpdatePayload = z.infer<typeof SelfUpdatePayloadSchema>;
export type SelfUpdateOwnership = SelfUpdatePayload["ownership"];

export interface UpdateObservation extends UpdateAvailability {
  currentRevision?: string;
  instanceId: string;
  operation?: UpdateOperationStatus;
}

export class SelfUpdateFailure extends Error {
  readonly code: string;
  readonly statusCode: 400 | 409 | 503;
  readonly publicMessage: string;

  constructor(publicMessage: string, code = "update_failed", statusCode: 400 | 409 | 503 = 409) {
    super(publicMessage);
    this.name = "SelfUpdateFailure";
    this.code = code;
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

export type SelfUpdateCommand = (input: RunCommandInput) => Promise<CommandRunResult>;
export type SelfUpdateSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SelfUpdateStoreOptions {
  runtimeRoot: string;
}

function statusPath(runtimeRoot: string): string {
  return join(runtimeRoot, SELF_UPDATE_STATUS_FILENAME);
}

function operationPath(runtimeRoot: string): string {
  return join(runtimeRoot, SELF_UPDATE_OPERATION_FILENAME);
}

function lockPath(runtimeRoot: string): string {
  return join(runtimeRoot, SELF_UPDATE_LOCK_FILENAME);
}

function runnerClaimPath(runtimeRoot: string): string {
  return join(runtimeRoot, SELF_UPDATE_RUNNER_CLAIM_FILENAME);
}

async function writeJsonAtomically(filename: string, value: unknown): Promise<void> {
  const staging = `${filename}.${process.pid}.${randomUUID()}.staging`;
  await mkdir(dirname(filename), { recursive: true });
  try {
    await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(staging, filename);
  } finally {
    await rm(staging, { force: true });
  }
}

async function readJson<T>(filename: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const contents = await readFile(filename, "utf8");
    return schema.parse(JSON.parse(contents) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class SelfUpdateStore {
  readonly runtimeRoot: string;

  constructor(options: string | SelfUpdateStoreOptions) {
    this.runtimeRoot = typeof options === "string" ? options : options.runtimeRoot;
  }

  async readStatus(): Promise<UpdateOperationStatus | undefined> {
    return readJson(statusPath(this.runtimeRoot), UpdateOperationStatusSchema);
  }

  async writeStatus(status: UpdateOperationStatus): Promise<void> {
    const parsed = UpdateOperationStatusSchema.parse(status);
    await writeJsonAtomically(statusPath(this.runtimeRoot), parsed);
  }

  async readPayload(): Promise<SelfUpdatePayload | undefined> {
    return readJson(operationPath(this.runtimeRoot), SelfUpdatePayloadSchema);
  }

  async writePayload(payload: SelfUpdatePayload): Promise<void> {
    const parsed = SelfUpdatePayloadSchema.parse(payload);
    await writeJsonAtomically(operationPath(this.runtimeRoot), parsed);
  }

  async readLock(): Promise<z.infer<typeof UpdateLockSchema> | undefined> {
    return readJson(lockPath(this.runtimeRoot), UpdateLockSchema);
  }

  async acquireLock(operationId: string): Promise<boolean> {
    await mkdir(this.runtimeRoot, { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath(this.runtimeRoot), "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ version: 1, operationId })}\n`, "utf8");
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async recordHelper(operationId: string, helper: SelfUpdatePayload["serverIdentity"]): Promise<boolean> {
    const lock = await this.readLock();
    if (!lock || lock.operationId !== operationId) return false;
    await writeJsonAtomically(lockPath(this.runtimeRoot), { ...lock, helper });
    return true;
  }

  async readRunnerClaim(): Promise<z.infer<typeof UpdateRunnerClaimSchema> | undefined> {
    return readJson(runnerClaimPath(this.runtimeRoot), UpdateRunnerClaimSchema);
  }

  async acquireRunnerClaim(operationId: string, identity: SelfUpdatePayload["serverIdentity"] | undefined, startedAt: string): Promise<boolean> {
    await mkdir(this.runtimeRoot, { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(runnerClaimPath(this.runtimeRoot), "wx", 0o600);
      const claim = {
        version: 1 as const,
        operationId,
        pid: identity?.pid ?? process.pid,
        startedAt: identity?.startedAt ?? startedAt,
        ...(identity ? { identity } : {}),
      };
      await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async releaseRunnerClaim(operationId: string): Promise<void> {
    const claim = await this.readRunnerClaim();
    if (claim?.operationId === operationId) await rm(runnerClaimPath(this.runtimeRoot), { force: true });
  }

  async releaseLock(operationId?: string): Promise<void> {
    if (!operationId) {
      await rm(lockPath(this.runtimeRoot), { force: true });
      return;
    }
    const lock = await this.readLock();
    if (lock?.operationId === operationId) await rm(lockPath(this.runtimeRoot), { force: true });
  }

  async removePayload(operationId?: string): Promise<void> {
    if (!operationId) {
      await rm(operationPath(this.runtimeRoot), { force: true });
      return;
    }
    const payload = await this.readPayload();
    if (payload?.operationId === operationId) await rm(operationPath(this.runtimeRoot), { force: true });
  }

  async cleanupOperation(operationId: string): Promise<void> {
    await this.removePayload(operationId);
    await this.releaseLock(operationId);
  }
}

export interface SelfUpdateServiceOptions {
  config: ForgeConfig;
  workingDirectory?: string;
  instanceId?: string;
  store?: SelfUpdateStore;
  processController?: ProcessController;
  runGit?: GitCommand;
  runCommand?: SelfUpdateCommand;
  spawn?: SelfUpdateSpawner;
  now?: () => Date;
  argv?: readonly string[];
  execArgv?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  runningRevision?: string;
}

export interface SelfUpdateRunnerOptions {
  operationId: string;
  config?: ForgeConfig;
  store?: SelfUpdateStore;
  processController?: ProcessController;
  runGit?: GitCommand;
  runCommand?: SelfUpdateCommand;
  spawn?: SelfUpdateSpawner;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  runnerIdentity?: SelfUpdatePayload["serverIdentity"];
}

function bounded(value: string, maximum = MAX_STATUS_TEXT): string {
  const trimmed = value.trim();
  if (trimmed.length <= maximum) return trimmed;
  return trimmed.slice(trimmed.length - maximum);
}

function errorText(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

function operationFailure(message: string, code = "update_failed", statusCode: 400 | 409 | 503 = 409): SelfUpdateFailure {
  return new SelfUpdateFailure(bounded(message), code, statusCode);
}

function normalizedRevision(value: string): string {
  const revision = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw operationFailure("Forge accepted only a full commit revision.", "revision_invalid", 400);
  return revision;
}

function commandFailure(label: string, result: CommandRunResult): SelfUpdateFailure {
  const details = bounded([result.stderr, result.stdout].filter(Boolean).join("\n"));
  return operationFailure(details ? `${label} failed: ${details}` : `${label} failed.`, result.timedOut ? "preparation_timeout" : "preparation_failed");
}

async function defaultGitCommand(args: readonly string[], cwd: string, execute: SelfUpdateCommand): Promise<string> {
  const result = await execute({ taskId: null, stepId: null, command: "git", args, cwd, timeout: SELF_UPDATE_TIMEOUTS.git, expectNonZero: true });
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

function makeGitCommand(execute: SelfUpdateCommand): GitCommand {
  return (args, cwd) => defaultGitCommand(args, cwd, execute);
}

function environmentForConfig(config: ForgeConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const reachableHost = new URL(config.reachableAddress).hostname.replace(/^\[|\]$/g, "");
  return {
    ...base,
    FORGE_ACCESS_MODE: config.accessMode,
    FORGE_TAILSCALE_EXPOSURE: config.tailscaleExposure,
    FORGE_TAILSCALE_ADDRESS: reachableHost,
    FORGE_BIND_ADDRESS: config.bindAddress,
    FORGE_PORT: String(config.port),
    FORGE_DATA_ROOT: config.dataRoot,
    FORGE_DATABASE_PATH: config.databasePath,
    FORGE_ARTIFACT_ROOT: config.artifactRoot,
    FORGE_RUNTIME_ROOT: config.runtimeRoot,
    FORGE_REPOSITORY_ROOT: config.repositoryRoot,
    FORGE_WORKTREE_ROOT: config.worktreeRoot,
    FORGE_INSTALLATION_ID: config.installationId,
    FORGE_DEVELOPMENT_AUTO_LOGIN: config.developmentAutoLogin ? "1" : undefined,
  };
}

function processRecordFromInspection(inspection: ProcessInspection, startedAt: string): OwnedProcess {
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

function sameCapturedIdentity(left: OwnedProcess, right: OwnedProcess): boolean {
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

function capturedIdentityFromInspection(inspection: ProcessInspection, name: string, startedAt: string): SelfUpdatePayload["serverIdentity"] {
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

type ProcessLiveness = "live" | "absent" | "unknown";

async function inspectCapturedProcess(identity: SelfUpdatePayload["serverIdentity"], processController: ProcessController): Promise<ProcessLiveness> {
  const inspection = await processController.inspect(identity.pid);
  if (!inspection) return "absent";
  return processIdentityMatches(identity, inspection) ? "live" : "absent";
}

async function inspectRunnerClaim(
  claim: z.infer<typeof UpdateRunnerClaimSchema>,
  processController: ProcessController,
): Promise<ProcessLiveness> {
  const inspection = await processController.inspect(claim.pid);
  if (!inspection) return claim.identity ? "absent" : "unknown";
  return claim.identity && processIdentityMatches(claim.identity, inspection) ? "live" : claim.identity ? "absent" : "live";
}

function watchOwnership(argv: readonly string[], execArgv: readonly string[], environment: NodeJS.ProcessEnv, parentInspection?: ProcessInspection): boolean {
  if (environment.FORGE_WATCH_MODE === "1") return true;
  const argumentsToInspect = [...argv, ...execArgv, ...(parentInspection?.argv ?? [])];
  return argumentsToInspect.some((argument) => argument === "watch"
    || argument === "--watch"
    || argument === "--watch-path"
    || argument === "--watch-preserve-output"
    || argument.startsWith("--watch=")
    || argument.startsWith("--watch-path="));
}

function operationStatus(input: {
  operationId: string;
  targetRevision: string;
  now: Date;
  status?: UpdateOperationStatus["status"];
  message?: string;
}): UpdateOperationStatus {
  return UpdateOperationStatusSchema.parse({
    operationId: input.operationId,
    status: input.status ?? "pending",
    targetRevision: input.targetRevision,
    acceptedAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    ...(input.message ? { message: input.message } : {}),
  });
}

async function updateOperationStatus(
  store: SelfUpdateStore,
  operationId: string,
  now: () => Date,
  patch: Partial<Pick<UpdateOperationStatus, "status" | "targetRevision" | "message" | "error">>,
): Promise<UpdateOperationStatus> {
  const current = await store.readStatus();
  if (!current || current.operationId !== operationId) throw operationFailure("Forge could not find the active update operation.", "operation_missing");
  const next = UpdateOperationStatusSchema.parse({
    ...current,
    ...patch,
    updatedAt: now().toISOString(),
  });
  await store.writeStatus(next);
  return next;
}

async function markOperationFailed(store: SelfUpdateStore, operationId: string, now: () => Date, error: unknown): Promise<void> {
  try {
    const current = await store.readStatus();
    if (!current || current.operationId !== operationId || current.status === "succeeded" || current.status === "failed") return;
    await store.writeStatus(UpdateOperationStatusSchema.parse({
      ...current,
      status: "failed",
      updatedAt: now().toISOString(),
      message: "Forge could not complete the update.",
      error: errorText(error),
    }));
  } catch {
    // A status write failure cannot be repaired safely by the old process.
  }
}

async function rejectWatchOwnership(argv: readonly string[], execArgv: readonly string[], environment: NodeJS.ProcessEnv, parentInspection?: ProcessInspection): Promise<void> {
  if (watchOwnership(argv, execArgv, environment, parentInspection)) throw operationFailure("Forge cannot restart safely while a file watcher owns this server.", "watch_ownership_unsupported", 409);
}

async function captureOwnership(options: {
  config: ForgeConfig;
  processController: ProcessController;
  now: () => Date;
  argv: readonly string[];
  execArgv: readonly string[];
  environment: NodeJS.ProcessEnv;
}): Promise<{ ownership: SelfUpdateOwnership; serverIdentity: OwnedProcess }> {
  const parentInspection = process.ppid > 1 ? await options.processController.inspect(process.ppid) : undefined;
  await rejectWatchOwnership(options.argv, options.execArgv, options.environment, parentInspection);
  const registryFilename = join(options.config.runtimeRoot, "owned-processes.json");
  let registry;
  try {
    registry = await readProcessRegistry(registryFilename);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw operationFailure("Forge could not validate its owned-process registry.", "ownership_registry_invalid");
    }
  }
  const inspection = await options.processController.inspect(process.pid);
  if (!inspection) throw operationFailure("Forge could not prove ownership of its current server process.", "ownership_unproven");
  if (registry) {
    const servers = registry.processes.filter((process) => process.name === "server");
    const server = servers.length === 1 ? servers[0] : undefined;
    if (server && processIdentityMatches(server, inspection)) return { ownership: "registry", serverIdentity: server };
  }
  return { ownership: "direct", serverIdentity: processRecordFromInspection(inspection, options.now().toISOString()) };
}

async function readStatusForView(store: SelfUpdateStore, now: () => Date): Promise<UpdateOperationStatus | undefined> {
  try {
    return await store.readStatus();
  } catch (error: unknown) {
    return operationStatus({ operationId: "invalid-status", targetRevision: "unknown", now: now(), status: "failed", message: `Forge could not read the update status: ${errorText(error)}` });
  }
}

export class SelfUpdateService {
  private readonly config: ForgeConfig;
  private readonly workingDirectory: string;
  private readonly instanceId: string;
  private readonly store: SelfUpdateStore;
  private readonly processController: ProcessController;
  private readonly runGit: GitCommand;
  private readonly runCommand: SelfUpdateCommand;
  private readonly spawnProcess: SelfUpdateSpawner;
  private readonly now: () => Date;
  private readonly argv: readonly string[];
  private readonly execArgv: readonly string[];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly launches = new Map<string, Promise<void>>();
  private runningRevision: string | undefined;
  private revisionCapture: Promise<void> | undefined;

  constructor(options: SelfUpdateServiceOptions) {
    this.config = options.config;
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.instanceId = options.instanceId ?? randomUUID();
    this.store = options.store ?? new SelfUpdateStore(this.config.runtimeRoot);
    this.processController = options.processController ?? defaultProcessController;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.runGit = options.runGit ?? makeGitCommand(this.runCommand);
    this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.now = options.now ?? (() => new Date());
    this.argv = options.argv ?? process.argv;
    this.execArgv = options.execArgv ?? process.execArgv;
    this.environment = options.environment ?? process.env;
    this.runningRevision = options.runningRevision;
  }

  private async captureRunningRevision(): Promise<void> {
    if (this.runningRevision) return;
    if (this.revisionCapture) {
      await this.revisionCapture;
      return;
    }
    this.revisionCapture = (async () => {
      try {
        this.runningRevision = await readCurrentRevision({ cwd: this.workingDirectory, runGit: this.runGit });
      } catch {
        this.runningRevision = undefined;
      }
    })();
    try {
      await this.revisionCapture;
    } finally {
      this.revisionCapture = undefined;
    }
  }

  private async operationLiveness(operationId: string, lock: Awaited<ReturnType<SelfUpdateStore["readLock"]>>): Promise<ProcessLiveness> {
    const claim = await this.store.readRunnerClaim();
    if (claim) {
      const claimLiveness = await inspectRunnerClaim(claim, this.processController);
      if (claim.operationId === operationId) {
        if (claimLiveness !== "absent") return claimLiveness;
        await this.store.releaseRunnerClaim(operationId);
      } else if (claimLiveness !== "absent") {
        return claimLiveness;
      } else {
        await this.store.releaseRunnerClaim(claim.operationId);
      }
    }
    if (lock?.operationId !== operationId) return "absent";
    if (lock.helper) return inspectCapturedProcess(lock.helper, this.processController);
    return "unknown";
  }

  private async recoverStaleOperation(status: UpdateOperationStatus, lock: Awaited<ReturnType<SelfUpdateStore["readLock"]>>): Promise<boolean> {
    const liveness = await this.operationLiveness(status.operationId, lock);
    const timedOut = Date.parse(status.updatedAt) + SELF_UPDATE_TIMEOUTS.operation < this.now().getTime();
    if (liveness === "live" || (liveness === "unknown" && !timedOut)) return false;
    await this.store.writeStatus(UpdateOperationStatusSchema.parse({
      ...status,
      status: "failed",
      updatedAt: this.now().toISOString(),
      message: "Forge stopped the stale update operation.",
      error: "The detached update helper did not finish within the time limit.",
    }));
    await this.store.cleanupOperation(status.operationId);
    await this.store.releaseRunnerClaim(status.operationId);
    return true;
  }

  async initialize(): Promise<void> {
    await this.captureRunningRevision();
    let status: UpdateOperationStatus | undefined;
    try {
      status = await this.store.readStatus();
    } catch {
      return;
    }
    if (!status || status.status !== "restarting") return;
    try {
      if (this.runningRevision !== status.targetRevision) {
        await markOperationFailed(this.store, status.operationId, this.now, `Forge started at ${this.runningRevision ?? "an unknown revision"}, not the selected revision ${status.targetRevision}.`);
        return;
      }
      await this.store.writeStatus(UpdateOperationStatusSchema.parse({
        ...status,
        status: "succeeded",
        updatedAt: this.now().toISOString(),
        message: "Forge restarted.",
        error: undefined,
      }));
    } catch (error: unknown) {
      await markOperationFailed(this.store, status.operationId, this.now, error);
    }
  }

  async readUpdate(): Promise<UpdateObservation> {
    await this.captureRunningRevision();
    let operation = await readStatusForView(this.store, this.now);
    const operationExpired = operation && Date.parse(operation.updatedAt) + SELF_UPDATE_TIMEOUTS.operation < this.now().getTime();
    if (operation && ACTIVE_OPERATION_STATUSES.has(operation.status) && operationExpired) {
      const lock = await this.store.readLock();
      if (lock?.operationId === operation.operationId) {
        await this.recoverStaleOperation(operation, lock);
        operation = await readStatusForView(this.store, this.now);
      }
    }
    const observed = operation && ACTIVE_OPERATION_STATUSES.has(operation.status)
      ? { available: true, revision: operation.targetRevision }
      : await inspectUpdateAvailability({
        cwd: this.workingDirectory,
        runGit: this.runGit,
        ...(this.runningRevision ? { currentRevision: this.runningRevision } : {}),
      });
    return {
      ...observed,
      ...(this.runningRevision ? { currentRevision: this.runningRevision } : {}),
      instanceId: this.instanceId,
      ...(operation ? { operation } : {}),
    };
  }

  async acceptRestart(targetRevision: string): Promise<UpdateRestartResponse> {
    const target = normalizedRevision(targetRevision);
    const existing = await this.store.readStatus();
    const lock = await this.store.readLock();
    if (existing && (ACTIVE_OPERATION_STATUSES.has(existing.status) || lock)) {
      if (lock?.operationId === existing.operationId) {
        if (!await this.recoverStaleOperation(existing, lock)) return { accepted: true, operation: existing };
      } else if (lock) {
        throw operationFailure("Forge already has an update operation in progress.", "update_in_progress", 409);
      } else if (ACTIVE_OPERATION_STATUSES.has(existing.status)) {
        if (!await this.recoverStaleOperation(existing, undefined)) throw operationFailure("Forge already has an update operation in progress.", "update_in_progress", 409);
      }
    }
    const remainingLock = await this.store.readLock();
    if (remainingLock) throw operationFailure("Forge already has an update operation in progress.", "update_in_progress", 409);

    const operationId = randomUUID();
    if (!await this.store.acquireLock(operationId)) throw operationFailure("Forge already has an update operation in progress.", "update_in_progress", 409);
    try {
      const ownership = await captureOwnership({ config: this.config, processController: this.processController, now: this.now, argv: this.argv, execArgv: this.execArgv, environment: this.environment });
      const status = operationStatus({ operationId, targetRevision: target, now: this.now(), message: "Forge accepted the update restart." });
      const payload: SelfUpdatePayload = {
        version: 1,
        operationId,
        targetRevision: target,
        ownership: ownership.ownership,
        serverIdentity: CapturedProcessIdentitySchema.parse(ownership.serverIdentity),
        workingDirectory: this.workingDirectory,
        config: this.config,
      };
      await this.store.writePayload(payload);
      await this.store.writeStatus(status);
      return { accepted: true, operation: status };
    } catch (error: unknown) {
      await this.store.cleanupOperation(operationId);
      throw error;
    }
  }

  async launchRestart(operationId: string): Promise<void> {
    const existing = this.launches.get(operationId);
    if (existing) return existing;
    const launch = this.launchHelper(operationId);
    this.launches.set(operationId, launch);
    return launch;
  }

  private async launchHelper(operationId: string): Promise<void> {
    const status = await this.store.readStatus();
    if (!status || status.operationId !== operationId || !ACTIVE_OPERATION_STATUSES.has(status.status)) return;
    try {
      const payload = await this.store.readPayload();
      if (!payload || payload.operationId !== operationId) throw operationFailure("Forge could not read the update operation.", "operation_invalid");
      const lock = await this.store.readLock();
      if (lock?.operationId === operationId && lock.helper && await inspectCapturedProcess(lock.helper, this.processController) === "live") return;
      const runnerClaim = await this.store.readRunnerClaim();
      if (runnerClaim && await inspectRunnerClaim(runnerClaim, this.processController) !== "absent") return;
      const log = await open(join(this.config.runtimeRoot, SELF_UPDATE_LOG_FILENAME), "a", 0o600);
      let child: ChildProcess | undefined;
      try {
        child = this.spawnProcess(process.execPath, ["--import", "tsx", "src/self-update-runner.ts", "--operation", operationId], {
          cwd: payload.workingDirectory,
          detached: true,
          env: environmentForConfig(payload.config, this.environment),
          stdio: ["ignore", log.fd, log.fd],
        });
        await waitForSpawn(child);
        child.unref();
        if (child.pid) {
          const helperInspection = await this.processController.inspect(child.pid);
          if (helperInspection?.pid === child.pid) {
            await this.store.recordHelper(operationId, capturedIdentityFromInspection(helperInspection, "self-update-helper", this.now().toISOString()));
          }
        }
      } finally {
        await log.close();
      }
    } catch (error: unknown) {
      await markOperationFailed(this.store, operationId, this.now, error);
      await this.store.cleanupOperation(operationId);
      throw error;
    }
  }
}

export function createSelfUpdateService(options: SelfUpdateServiceOptions): SelfUpdateService {
  return new SelfUpdateService(options);
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => { child.off("error", onError); resolve(); };
    const onError = (error: Error): void => { child.off("spawn", onSpawn); reject(error); };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  if (!child.pid) throw operationFailure("Forge could not start the detached update helper.", "helper_spawn_failed", 503);
}

async function prepareSelfUpdate(input: {
  cwd: string;
  runGit: GitCommand;
  runCommand: SelfUpdateCommand;
  onRevisionSelected: (revision: string) => Promise<void>;
}): Promise<void> {
  const branch = (await input.runGit(["symbolic-ref", "--short", "HEAD"], input.cwd)).trim();
  if (branch !== "main") throw operationFailure("Forge can update only a checkout on the main branch.", "branch_invalid");
  const remote = await matchingRemote(input.runGit, input.cwd);
  if (!remote) throw operationFailure(`Forge could not find the pinned GitHub remote ${FORGE_REPOSITORY}.`, "remote_invalid");
  const head = await readCurrentRevision({ cwd: input.cwd, runGit: input.runGit });
  await input.runGit(["fetch", "--no-tags", remote, "refs/heads/main:refs/remotes/" + remote + "/main"], input.cwd);
  const targetRevision = requiredCommitRevision(await input.runGit(["rev-parse", "--verify", `refs/remotes/${remote}/main^{commit}`], input.cwd));
  await input.onRevisionSelected(targetRevision);
  try {
    await input.runGit(["merge-base", "--is-ancestor", head, targetRevision], input.cwd);
  } catch {
    throw operationFailure("Forge refused to update because the current commit is not an ancestor of the selected revision.", "checkout_diverged");
  }
  try {
    await input.runGit(["merge", "--ff-only", targetRevision], input.cwd);
  } catch (error: unknown) {
    throw operationFailure(`Forge could not fast-forward to the selected revision. Git reported ${errorText(error)}`, "checkout_merge_failed");
  }
  const mergedRevision = await readCurrentRevision({ cwd: input.cwd, runGit: input.runGit });
  if (mergedRevision !== targetRevision) throw operationFailure("Forge could not prove that the checkout reached the selected revision.", "revision_unverified");

  let result: CommandRunResult;
  try {
    result = await input.runCommand({ taskId: null, stepId: null, command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: input.cwd, timeout: SELF_UPDATE_TIMEOUTS.install });
  } catch (error: unknown) {
    throw operationFailure(`pnpm install failed: ${errorText(error)}`, "preparation_failed");
  }
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure("pnpm install", result);
  try {
    result = await input.runCommand({ taskId: null, stepId: null, command: "pnpm", args: ["run", "build"], cwd: input.cwd, timeout: SELF_UPDATE_TIMEOUTS.build });
  } catch (error: unknown) {
    throw operationFailure(`pnpm run build failed: ${errorText(error)}`, "preparation_failed");
  }
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure("pnpm run build", result);
}

function processIdentityIsCurrent(identity: OwnedProcess, inspection: ProcessInspection | undefined): boolean {
  return inspection !== undefined && processIdentityMatches(identity, inspection);
}

async function assertServerOwnership(payload: SelfUpdatePayload, processController: ProcessController, requireRegistry: boolean): Promise<void> {
  if (requireRegistry) {
    const registryFilename = join(payload.config.runtimeRoot, "owned-processes.json");
    let registry;
    try {
      registry = await readProcessRegistry(registryFilename);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw operationFailure("Forge could not validate its owned-process registry.", "ownership_registry_invalid");
    }
    if (!registry) throw operationFailure("Forge refused to restart because server ownership changed.", "ownership_changed");
    const servers = registry.processes.filter((process) => process.name === "server");
    const recorded = servers.length === 1 ? servers[0] : undefined;
    if (!recorded || !sameCapturedIdentity(recorded, payload.serverIdentity)) throw operationFailure("Forge refused to restart because the owned server registry changed.", "ownership_changed");
  }
  const inspection = await processController.inspect(payload.serverIdentity.pid);
  if (!processIdentityIsCurrent(payload.serverIdentity, inspection)) throw operationFailure("Forge refused to restart because the server process identity changed and ownership is not proven.", "ownership_changed");
}

async function signalDirectServer(identity: OwnedProcess, processController: ProcessController): Promise<void> {
  const inspection = await processController.inspect(identity.pid);
  if (!processIdentityIsCurrent(identity, inspection)) throw operationFailure("Forge refused to restart because the server process identity changed and ownership is not proven.", "ownership_changed");
  await processController.signal(identity.pid, "SIGTERM");
}

async function waitForProcessExit(identity: OwnedProcess, processController: ProcessController, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + SELF_UPDATE_TIMEOUTS.restart;
  while (Date.now() < deadline) {
    const inspection = await processController.inspect(identity.pid);
    if (!inspection) return;
    if (!processIdentityIsCurrent(identity, inspection)) throw operationFailure("Forge refused to continue because the server PID was reused.", "ownership_changed");
    await sleep(100);
  }
  throw operationFailure("Forge did not stop the previous server within the time limit.", "shutdown_timeout");
}

function healthProbeAddress(config: ForgeConfig): string {
  if (config.tailscaleExposure !== "serve") return config.reachableAddress;
  const host = config.bindAddress.includes(":") ? `[${config.bindAddress}]` : config.bindAddress;
  return `http://${host}:${config.port}`;
}

async function waitForReachable(config: ForgeConfig, fetchFunction: typeof fetch, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  const address = healthProbeAddress(config);
  const deadline = Date.now() + SELF_UPDATE_TIMEOUTS.restart;
  while (Date.now() < deadline) {
    try {
      const response = await fetchFunction(`${address}/health`, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      const redirectedToAuthentication = response.status >= 300
        && response.status < 400
        && (response.headers.get("location") ?? "").startsWith("/auth");
      if (response.ok || redirectedToAuthentication) return;
    } catch {
      // The replacement can still be binding to the configured address.
    }
    await sleep(250);
  }
  throw operationFailure(`Forge did not become reachable at ${address} after restart.`, "restart_timeout", 503);
}

async function spawnDirectReplacement(input: {
  payload: SelfUpdatePayload;
  spawnProcess: SelfUpdateSpawner;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  await mkdir(input.payload.config.runtimeRoot, { recursive: true });
  const log = await open(join(input.payload.config.runtimeRoot, SELF_UPDATE_SERVER_LOG_FILENAME), "a", 0o600);
  let child: ChildProcess | undefined;
  try {
    child = input.spawnProcess(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: input.payload.workingDirectory,
      detached: true,
      env: environmentForConfig(input.payload.config, input.environment),
      stdio: ["ignore", log.fd, log.fd],
    });
    await waitForSpawn(child);
    child.unref();
  } finally {
    await log.close();
  }
}

async function runRegistryRestart(input: { payload: SelfUpdatePayload; runCommand: SelfUpdateCommand; environment: NodeJS.ProcessEnv }): Promise<void> {
  let result: CommandRunResult;
  try {
    result = await input.runCommand({
      taskId: null,
      stepId: null,
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "restart"],
      cwd: input.payload.workingDirectory,
      env: environmentForConfig(input.payload.config, input.environment),
      timeout: SELF_UPDATE_TIMEOUTS.restart,
    });
  } catch (error: unknown) {
    throw operationFailure(`Forge CLI restart failed: ${errorText(error)}`, "restart_failed", 503);
  }
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure("Forge CLI restart", result);
}

async function currentRunnerIdentity(
  processController: ProcessController,
  now: () => Date,
  provided: SelfUpdatePayload["serverIdentity"] | undefined,
): Promise<SelfUpdatePayload["serverIdentity"] | undefined> {
  if (provided) return provided;
  const inspection = await processController.inspect(process.pid);
  return inspection ? capturedIdentityFromInspection(inspection, "self-update-runner", now().toISOString()) : undefined;
}

async function claimRunner(
  store: SelfUpdateStore,
  operationId: string,
  processController: ProcessController,
  now: () => Date,
  providedIdentity: SelfUpdatePayload["serverIdentity"] | undefined,
): Promise<boolean> {
  const identity = await currentRunnerIdentity(processController, now, providedIdentity);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await store.acquireRunnerClaim(operationId, identity, now().toISOString())) return true;
    const claim = await store.readRunnerClaim();
    if (!claim) continue;
    const liveness = await inspectRunnerClaim(claim, processController);
    if (liveness !== "absent") return false;
    await store.releaseRunnerClaim(claim.operationId);
  }
  return false;
}

export async function runSelfUpdateOperation(options: SelfUpdateRunnerOptions): Promise<void> {
  const store = options.store ?? (options.config ? new SelfUpdateStore(options.config.runtimeRoot) : undefined);
  if (!store) throw operationFailure("Forge could not locate the update runtime.", "runtime_invalid", 503);
  const payload = await store.readPayload();
  if (!payload || payload.operationId !== options.operationId) throw operationFailure("Forge could not read the update operation.", "operation_invalid", 503);
  const config = options.config ?? payload.config;
  const processController = options.processController ?? defaultProcessController;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const runGit = options.runGit ?? makeGitCommand(runCommand);
  const spawnProcess = options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const fetchFunction = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? process.env;
  const status = await store.readStatus();
  if (!status || status.operationId !== options.operationId || !ACTIVE_OPERATION_STATUSES.has(status.status)) return;
  if (!await claimRunner(store, options.operationId, processController, now, options.runnerIdentity)) return;
  try {
    const claimedStatus = await store.readStatus();
    if (!claimedStatus || claimedStatus.operationId !== options.operationId || claimedStatus.status === "failed" || claimedStatus.status === "succeeded") return;
    await updateOperationStatus(store, options.operationId, now, { status: "preparing", message: "Forge is checking the update." });
    await assertServerOwnership(payload, processController, payload.ownership === "registry");
    await prepareSelfUpdate({
      cwd: payload.workingDirectory,
      runGit,
      runCommand,
      onRevisionSelected: async (targetRevision) => {
        await updateOperationStatus(store, options.operationId, now, { targetRevision });
      },
    });
    await updateOperationStatus(store, options.operationId, now, { status: "restarting", message: "Forge prepared the update and is restarting." });
    await assertServerOwnership(payload, processController, payload.ownership === "registry");
    if (payload.ownership === "registry") {
      await runRegistryRestart({ payload: { ...payload, config }, runCommand, environment });
    } else {
      await signalDirectServer(payload.serverIdentity, processController);
      await waitForProcessExit(payload.serverIdentity, processController, sleep);
      await spawnDirectReplacement({ payload: { ...payload, config }, spawnProcess, environment });
      await waitForReachable(config, fetchFunction, sleep);
    }
    const completedStatus = await store.readStatus();
    if (completedStatus?.status === "failed") throw operationFailure(completedStatus.error ?? "Forge could not prove the replacement startup.", "restart_failed", 503);
    await updateOperationStatus(store, options.operationId, now, { status: "succeeded", message: "Forge restarted.", error: undefined });
  } catch (error: unknown) {
    await markOperationFailed(store, options.operationId, now, error);
    throw error;
  } finally {
    try {
      await store.cleanupOperation(options.operationId);
    } finally {
      await store.releaseRunnerClaim(options.operationId);
    }
  }
}

export async function runSelfUpdateFromEnvironment(operationId: string): Promise<void> {
  const runtimeRoot = process.env.FORGE_RUNTIME_ROOT;
  if (!runtimeRoot) throw operationFailure("Forge could not locate the update runtime.", "runtime_invalid", 503);
  const store = new SelfUpdateStore(runtimeRoot);
  const payload = await store.readPayload();
  if (!payload) throw operationFailure("Forge could not read the update operation.", "operation_invalid", 503);
  await runSelfUpdateOperation({ operationId, store, config: payload.config });
}

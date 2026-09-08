import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

import type { UpdateRestartResponse } from "../../http/contracts/update.js";
import type { ForgeConfig } from "../config.js";
import { runCommand as defaultRunCommand } from "../command-runner.js";
import { defaultProcessController, type ProcessController } from "../process-manager.js";
import { inspectUpdateAvailability, readCurrentRevision, type GitCommand, type UpdateAvailability } from "./update.js";
import {
  CapturedProcessIdentitySchema,
  SELF_UPDATE_LOG_FILENAME,
  SELF_UPDATE_TIMEOUTS,
  UpdateOperationStatusSchema,
  type SelfUpdateCommand,
  type SelfUpdatePayload,
  type SelfUpdateSpawner,
  type UpdateOperationStatus,
} from "./self-update-contracts.js";
import {
  activeOperationStatus,
  environmentForConfig,
  errorText,
  makeGitCommand,
  markOperationFailed,
  operationFailure,
  waitForSpawn,
} from "./update-execution.js";
import { SelfUpdateStore } from "./self-update-store.js";
import {
  captureOwnership as captureProcessOwnership,
  capturedIdentityFromInspection,
  inspectCapturedProcess,
  inspectRunnerClaim,
  type ProcessLiveness,
} from "./process-ownership.js";

export {
  SELF_UPDATE_LOCK_FILENAME,
  SELF_UPDATE_LOG_FILENAME,
  SELF_UPDATE_OPERATION_FILENAME,
  SELF_UPDATE_RUNNER_CLAIM_FILENAME,
  SELF_UPDATE_SERVER_LOG_FILENAME,
  SELF_UPDATE_STATUS_FILENAME,
  SELF_UPDATE_TIMEOUTS,
  SelfUpdateFailure,
  type SelfUpdatePayload,
  type SelfUpdateOwnership,
} from "./self-update-contracts.js";
export { SelfUpdateStore, type SelfUpdateStoreOptions } from "./self-update-store.js";
export { runSelfUpdateFromEnvironment, runSelfUpdateOperation, type SelfUpdateRunnerOptions } from "./update-execution.js";
export type { SelfUpdateCommand, SelfUpdateSpawner } from "./self-update-contracts.js";

export interface UpdateObservation extends UpdateAvailability {
  currentRevision?: string;
  instanceId: string;
  operation?: UpdateOperationStatus;
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

function normalizedRevision(value: string): string {
  const revision = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw operationFailure("Forge accepted only a full commit revision.", "revision_invalid", 400);
  return revision;
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
    if (operation && activeOperationStatus(operation.status) && operationExpired) {
      const lock = await this.store.readLock();
      if (lock?.operationId === operation.operationId) {
        await this.recoverStaleOperation(operation, lock);
        operation = await readStatusForView(this.store, this.now);
      }
    }
    const observed = operation && activeOperationStatus(operation.status)
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
    if (existing && (activeOperationStatus(existing.status) || lock)) {
      if (lock?.operationId === existing.operationId) {
        if (!await this.recoverStaleOperation(existing, lock)) return { accepted: true, operation: existing };
      } else if (lock) {
        throw operationFailure("Forge already has an update operation in progress.", "update_in_progress", 409);
      } else if (activeOperationStatus(existing.status)) {
        if (!await this.recoverStaleOperation(existing, undefined)) throw operationFailure("Forge already has an update operation in progress.", "update_in_progress", 409);
      }
    }
    const remainingLock = await this.store.readLock();
    if (remainingLock) throw operationFailure("Forge already has an update operation in progress.", "update_in_progress", 409);

    const operationId = randomUUID();
    if (!await this.store.acquireLock(operationId)) throw operationFailure("Forge already has an update operation in progress.", "update_in_progress", 409);
    try {
      const ownership = await captureProcessOwnership({ config: this.config, processController: this.processController, now: this.now, argv: this.argv, execArgv: this.execArgv, environment: this.environment, failure: operationFailure });
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
    if (!status || status.operationId !== operationId || !activeOperationStatus(status.status)) return;
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
        child = this.spawnProcess(process.execPath, ["--import", "tsx", "src/platform/updates/self-update-runner.ts", "--operation", operationId], {
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

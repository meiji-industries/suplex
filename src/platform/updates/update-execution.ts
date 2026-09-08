// Self-update owns detached process startup rather than the normal command runner.
// eslint-disable-next-line no-restricted-imports
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import type { ForgeConfig } from "../config.js";
import {
  runCommand as defaultRunCommand,
  type CommandRunResult,
} from "../command-runner.js";
import {
  defaultProcessController,
  processIdentityMatches,
  readProcessRegistry,
  type OwnedProcess,
  type ProcessController,
  type ProcessInspection,
} from "../process-manager.js";
import {
  FORGE_REPOSITORY,
  matchingRemote,
  readCurrentRevision,
  requiredCommitRevision,
  type GitCommand,
} from "./update.js";
import {
  SELF_UPDATE_SERVER_LOG_FILENAME,
  SELF_UPDATE_TIMEOUTS,
  SelfUpdateFailure,
  UpdateOperationStatusSchema,
  type SelfUpdateCommand,
  type SelfUpdatePayload,
  type SelfUpdateSpawner,
  type UpdateOperationStatus,
} from "./self-update-contracts.js";
import { SelfUpdateStore } from "./self-update-store.js";
import {
  capturedIdentityFromInspection,
  inspectRunnerClaim,
  sameCapturedIdentity,
} from "./process-ownership.js";

const MAX_STATUS_TEXT = 2_000;
const ACTIVE_OPERATION_STATUSES = new Set<UpdateOperationStatus["status"]>([
  "pending",
  "preparing",
  "restarting",
]);

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

export function activeOperationStatus(
  status: UpdateOperationStatus["status"],
): boolean {
  return ACTIVE_OPERATION_STATUSES.has(status);
}

export function bounded(value: string, maximum = MAX_STATUS_TEXT): string {
  const trimmed = value.trim();
  if (trimmed.length <= maximum) return trimmed;
  return trimmed.slice(trimmed.length - maximum);
}

export function errorText(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

export function operationFailure(
  message: string,
  code = "update_failed",
  statusCode: 400 | 409 | 503 = 409,
): SelfUpdateFailure {
  return new SelfUpdateFailure(bounded(message), code, statusCode);
}

export function commandFailure(
  label: string,
  result: CommandRunResult,
): SelfUpdateFailure {
  const details = bounded(
    [result.stderr, result.stdout].filter(Boolean).join("\n"),
  );
  return operationFailure(
    details ? `${label} failed: ${details}` : `${label} failed.`,
    result.timedOut ? "preparation_timeout" : "preparation_failed",
  );
}

export async function defaultGitCommand(
  args: readonly string[],
  cwd: string,
  execute: SelfUpdateCommand,
): Promise<string> {
  const result = await execute({
    taskId: null,
    stepId: null,
    command: "git",
    args,
    cwd,
    timeout: SELF_UPDATE_TIMEOUTS.git,
    expectNonZero: true,
  });
  if (result.exitCode !== 0 || result.timedOut)
    throw commandFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

export function makeGitCommand(execute: SelfUpdateCommand): GitCommand {
  return (args, cwd) => defaultGitCommand(args, cwd, execute);
}

export function environmentForConfig(
  config: ForgeConfig,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const reachableHost = new URL(config.reachableAddress).hostname.replace(
    /^\[|\]$/g,
    "",
  );
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

export async function markOperationFailed(
  store: SelfUpdateStore,
  operationId: string,
  now: () => Date,
  error: unknown,
): Promise<void> {
  try {
    const current = await store.readStatus();
    if (
      !current ||
      current.operationId !== operationId ||
      current.status === "succeeded" ||
      current.status === "failed"
    )
      return;
    await store.writeStatus(
      UpdateOperationStatusSchema.parse({
        ...current,
        status: "failed",
        updatedAt: now().toISOString(),
        message: "Forge could not complete the update.",
        error: errorText(error),
      }),
    );
  } catch {
    // A status write failure cannot be repaired safely by the old process.
  }
}

async function updateOperationStatus(
  store: SelfUpdateStore,
  operationId: string,
  now: () => Date,
  patch: Partial<
    Pick<
      UpdateOperationStatus,
      "status" | "targetRevision" | "message" | "error"
    >
  >,
): Promise<UpdateOperationStatus> {
  const current = await store.readStatus();
  if (!current || current.operationId !== operationId)
    throw operationFailure(
      "Forge could not find the active update operation.",
      "operation_missing",
    );
  const next = UpdateOperationStatusSchema.parse({
    ...current,
    ...patch,
    updatedAt: now().toISOString(),
  });
  await store.writeStatus(next);
  return next;
}

export async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  if (!child.pid)
    throw operationFailure(
      "Forge could not start the detached update helper.",
      "helper_spawn_failed",
      503,
    );
}

async function prepareSelfUpdate(input: {
  cwd: string;
  runGit: GitCommand;
  runCommand: SelfUpdateCommand;
  onRevisionSelected: (revision: string) => Promise<void>;
}): Promise<void> {
  const branch = (
    await input.runGit(["symbolic-ref", "--short", "HEAD"], input.cwd)
  ).trim();
  if (branch !== "main")
    throw operationFailure(
      "Forge can update only a checkout on the main branch.",
      "branch_invalid",
    );
  const remote = await matchingRemote(input.runGit, input.cwd);
  if (!remote)
    throw operationFailure(
      `Forge could not find the pinned GitHub remote ${FORGE_REPOSITORY}.`,
      "remote_invalid",
    );
  const head = await readCurrentRevision({
    cwd: input.cwd,
    runGit: input.runGit,
  });
  await input.runGit(
    [
      "fetch",
      "--no-tags",
      remote,
      "refs/heads/main:refs/remotes/" + remote + "/main",
    ],
    input.cwd,
  );
  const targetRevision = requiredCommitRevision(
    await input.runGit(
      ["rev-parse", "--verify", `refs/remotes/${remote}/main^{commit}`],
      input.cwd,
    ),
  );
  await input.onRevisionSelected(targetRevision);
  try {
    await input.runGit(
      ["merge-base", "--is-ancestor", head, targetRevision],
      input.cwd,
    );
  } catch {
    throw operationFailure(
      "Forge refused to update because the current commit is not an ancestor of the selected revision.",
      "checkout_diverged",
    );
  }
  try {
    await input.runGit(["merge", "--ff-only", targetRevision], input.cwd);
  } catch (error: unknown) {
    throw operationFailure(
      `Forge could not fast-forward to the selected revision. Git reported ${errorText(error)}`,
      "checkout_merge_failed",
    );
  }
  const mergedRevision = await readCurrentRevision({
    cwd: input.cwd,
    runGit: input.runGit,
  });
  if (mergedRevision !== targetRevision)
    throw operationFailure(
      "Forge could not prove that the checkout reached the selected revision.",
      "revision_unverified",
    );
  let result: CommandRunResult;
  try {
    result = await input.runCommand({
      taskId: null,
      stepId: null,
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd: input.cwd,
      timeout: SELF_UPDATE_TIMEOUTS.install,
    });
  } catch (error: unknown) {
    throw operationFailure(
      `pnpm install failed: ${errorText(error)}`,
      "preparation_failed",
    );
  }
  if (result.exitCode !== 0 || result.timedOut)
    throw commandFailure("pnpm install", result);
  try {
    result = await input.runCommand({
      taskId: null,
      stepId: null,
      command: "pnpm",
      args: ["run", "build"],
      cwd: input.cwd,
      timeout: SELF_UPDATE_TIMEOUTS.build,
    });
  } catch (error: unknown) {
    throw operationFailure(
      `pnpm run build failed: ${errorText(error)}`,
      "preparation_failed",
    );
  }
  if (result.exitCode !== 0 || result.timedOut)
    throw commandFailure("pnpm run build", result);
}

function processIdentityIsCurrent(
  identity: OwnedProcess,
  inspection: ProcessInspection | undefined,
): boolean {
  return (
    inspection !== undefined && processIdentityMatches(identity, inspection)
  );
}

async function assertServerOwnership(
  payload: SelfUpdatePayload,
  processController: ProcessController,
  requireRegistry: boolean,
): Promise<void> {
  if (requireRegistry) {
    const registryFilename = join(
      payload.config.runtimeRoot,
      "owned-processes.json",
    );
    let registry;
    try {
      registry = await readProcessRegistry(registryFilename);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw operationFailure(
          "Forge could not validate its owned-process registry.",
          "ownership_registry_invalid",
        );
    }
    if (!registry)
      throw operationFailure(
        "Forge refused to restart because server ownership changed.",
        "ownership_changed",
      );
    const servers = registry.processes.filter(
      (process) => process.name === "server",
    );
    const recorded = servers.length === 1 ? servers[0] : undefined;
    if (!recorded || !sameCapturedIdentity(recorded, payload.serverIdentity))
      throw operationFailure(
        "Forge refused to restart because the owned server registry changed.",
        "ownership_changed",
      );
  }
  const inspection = await processController.inspect(
    payload.serverIdentity.pid,
  );
  if (!processIdentityIsCurrent(payload.serverIdentity, inspection))
    throw operationFailure(
      "Forge refused to restart because the server process identity changed and ownership is not proven.",
      "ownership_changed",
    );
}

async function signalDirectServer(
  identity: OwnedProcess,
  processController: ProcessController,
): Promise<void> {
  const inspection = await processController.inspect(identity.pid);
  if (!processIdentityIsCurrent(identity, inspection))
    throw operationFailure(
      "Forge refused to restart because the server process identity changed and ownership is not proven.",
      "ownership_changed",
    );
  await processController.signal(identity.pid, "SIGTERM");
}
async function waitForProcessExit(
  identity: OwnedProcess,
  processController: ProcessController,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + SELF_UPDATE_TIMEOUTS.restart;
  while (Date.now() < deadline) {
    const inspection = await processController.inspect(identity.pid);
    if (!inspection) return;
    if (!processIdentityIsCurrent(identity, inspection))
      throw operationFailure(
        "Forge refused to continue because the server PID was reused.",
        "ownership_changed",
      );
    await sleep(100);
  }
  throw operationFailure(
    "Forge did not stop the previous server within the time limit.",
    "shutdown_timeout",
  );
}
function healthProbeAddress(config: ForgeConfig): string {
  if (config.tailscaleExposure !== "serve") return config.reachableAddress;
  const host = config.bindAddress.includes(":")
    ? `[${config.bindAddress}]`
    : config.bindAddress;
  return `http://${host}:${config.port}`;
}
async function waitForReachable(
  config: ForgeConfig,
  fetchFunction: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const address = healthProbeAddress(config);
  const deadline = Date.now() + SELF_UPDATE_TIMEOUTS.restart;
  while (Date.now() < deadline) {
    try {
      const response = await fetchFunction(`${address}/health`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      const redirectedToAuthentication =
        response.status >= 300 &&
        response.status < 400 &&
        (response.headers.get("location") ?? "").startsWith("/auth");
      if (response.ok || redirectedToAuthentication) return;
    } catch {
      /* The replacement can still be binding to the configured address. */
    }
    await sleep(250);
  }
  throw operationFailure(
    `Forge did not become reachable at ${address} after restart.`,
    "restart_timeout",
    503,
  );
}
async function spawnDirectReplacement(input: {
  payload: SelfUpdatePayload;
  spawnProcess: SelfUpdateSpawner;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  await mkdir(input.payload.config.runtimeRoot, { recursive: true });
  const log = await open(
    join(input.payload.config.runtimeRoot, SELF_UPDATE_SERVER_LOG_FILENAME),
    "a",
    0o600,
  );
  let child: ChildProcess | undefined;
  try {
    child = input.spawnProcess(
      process.execPath,
      ["--import", "tsx", "src/server.ts"],
      {
        cwd: input.payload.workingDirectory,
        detached: true,
        env: environmentForConfig(input.payload.config, input.environment),
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    await waitForSpawn(child);
    child.unref();
  } finally {
    await log.close();
  }
}
async function runRegistryRestart(input: {
  payload: SelfUpdatePayload;
  runCommand: SelfUpdateCommand;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
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
    throw operationFailure(
      `Forge CLI restart failed: ${errorText(error)}`,
      "restart_failed",
      503,
    );
  }
  if (result.exitCode !== 0 || result.timedOut)
    throw commandFailure("Forge CLI restart", result);
}
async function currentRunnerIdentity(
  processController: ProcessController,
  now: () => Date,
  provided: SelfUpdatePayload["serverIdentity"] | undefined,
): Promise<SelfUpdatePayload["serverIdentity"] | undefined> {
  if (provided) return provided;
  const inspection = await processController.inspect(process.pid);
  return inspection
    ? capturedIdentityFromInspection(
        inspection,
        "self-update-runner",
        now().toISOString(),
      )
    : undefined;
}
async function claimRunner(
  store: SelfUpdateStore,
  operationId: string,
  processController: ProcessController,
  now: () => Date,
  providedIdentity: SelfUpdatePayload["serverIdentity"] | undefined,
): Promise<boolean> {
  const identity = await currentRunnerIdentity(
    processController,
    now,
    providedIdentity,
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (
      await store.acquireRunnerClaim(operationId, identity, now().toISOString())
    )
      return true;
    const claim = await store.readRunnerClaim();
    if (!claim) continue;
    const liveness = await inspectRunnerClaim(claim, processController);
    if (liveness !== "absent") return false;
    await store.releaseRunnerClaim(claim.operationId);
  }
  return false;
}

export async function runSelfUpdateOperation(
  options: SelfUpdateRunnerOptions,
): Promise<void> {
  const store =
    options.store ??
    (options.config
      ? new SelfUpdateStore(options.config.runtimeRoot)
      : undefined);
  if (!store)
    throw operationFailure(
      "Forge could not locate the update runtime.",
      "runtime_invalid",
      503,
    );
  const payload = await store.readPayload();
  if (!payload || payload.operationId !== options.operationId)
    throw operationFailure(
      "Forge could not read the update operation.",
      "operation_invalid",
      503,
    );
  const config = options.config ?? payload.config;
  const processController =
    options.processController ?? defaultProcessController;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const runGit = options.runGit ?? makeGitCommand(runCommand);
  const spawnProcess =
    options.spawn ??
    ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const fetchFunction = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? process.env;
  const status = await store.readStatus();
  if (
    !status ||
    status.operationId !== options.operationId ||
    !activeOperationStatus(status.status)
  )
    return;
  if (
    !(await claimRunner(
      store,
      options.operationId,
      processController,
      now,
      options.runnerIdentity,
    ))
  )
    return;
  try {
    const claimedStatus = await store.readStatus();
    if (
      !claimedStatus ||
      claimedStatus.operationId !== options.operationId ||
      claimedStatus.status === "failed" ||
      claimedStatus.status === "succeeded"
    )
      return;
    await updateOperationStatus(store, options.operationId, now, {
      status: "preparing",
      message: "Forge is checking the update.",
    });
    await assertServerOwnership(
      payload,
      processController,
      payload.ownership === "registry",
    );
    await prepareSelfUpdate({
      cwd: payload.workingDirectory,
      runGit,
      runCommand,
      onRevisionSelected: async (targetRevision) => {
        await updateOperationStatus(store, options.operationId, now, {
          targetRevision,
        });
      },
    });
    await updateOperationStatus(store, options.operationId, now, {
      status: "restarting",
      message: "Forge prepared the update and is restarting.",
    });
    await assertServerOwnership(
      payload,
      processController,
      payload.ownership === "registry",
    );
    if (payload.ownership === "registry")
      await runRegistryRestart({
        payload: { ...payload, config },
        runCommand,
        environment,
      });
    else {
      await signalDirectServer(payload.serverIdentity, processController);
      await waitForProcessExit(
        payload.serverIdentity,
        processController,
        sleep,
      );
      await spawnDirectReplacement({
        payload: { ...payload, config },
        spawnProcess,
        environment,
      });
      await waitForReachable(config, fetchFunction, sleep);
    }
    const completedStatus = await store.readStatus();
    if (completedStatus?.status === "failed")
      throw operationFailure(
        completedStatus.error ??
          "Forge could not prove the replacement startup.",
        "restart_failed",
        503,
      );
    await updateOperationStatus(store, options.operationId, now, {
      status: "succeeded",
      message: "Forge restarted.",
      error: undefined,
    });
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

export async function runSelfUpdateFromEnvironment(
  operationId: string,
): Promise<void> {
  const runtimeRoot = process.env.FORGE_RUNTIME_ROOT;
  if (!runtimeRoot)
    throw operationFailure(
      "Forge could not locate the update runtime.",
      "runtime_invalid",
      503,
    );
  const store = new SelfUpdateStore(runtimeRoot);
  const payload = await store.readPayload();
  if (!payload)
    throw operationFailure(
      "Forge could not read the update operation.",
      "operation_invalid",
      503,
    );
  await runSelfUpdateOperation({ operationId, store, config: payload.config });
}

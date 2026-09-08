import { z } from "zod";
import type { CommandRunResult, RunCommandInput } from "../command-runner.js";
// Self-update owns detached process startup rather than the normal command runner.
// eslint-disable-next-line no-restricted-imports
import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  UpdateOperationStatusSchema,
  UPDATE_OPERATION_TIMEOUT_MS,
  type UpdateOperationStatus,
} from "../../http/contracts/update.js";
import { GIT_TIMEOUT_MS } from "./update.js";

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

export const CapturedProcessIdentitySchema = z
  .object({
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
  })
  .strict();

export const SelfUpdatePayloadSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    targetRevision: z.string().regex(/^[0-9a-f]{40}$/),
    ownership: z.enum(["direct", "registry"]),
    serverIdentity: CapturedProcessIdentitySchema,
    workingDirectory: z.string().min(1),
    config: z
      .object({
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
      })
      .strict(),
  })
  .strict();

export const UpdateLockSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    helper: CapturedProcessIdentitySchema.optional(),
  })
  .strict();

export const UpdateRunnerClaimSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    pid: z.number().int().positive(),
    startedAt: z.string().min(1),
    identity: CapturedProcessIdentitySchema.optional(),
  })
  .strict();

export type SelfUpdatePayload = z.infer<typeof SelfUpdatePayloadSchema>;
export type SelfUpdateOwnership = SelfUpdatePayload["ownership"];
export type SelfUpdateLock = z.infer<typeof UpdateLockSchema>;
export type SelfUpdateRunnerClaim = z.infer<typeof UpdateRunnerClaimSchema>;
export type { UpdateOperationStatus };
export { UpdateOperationStatusSchema };

export class SelfUpdateFailure extends Error {
  readonly code: string;
  readonly statusCode: 400 | 409 | 503;
  readonly publicMessage: string;

  constructor(
    publicMessage: string,
    code = "update_failed",
    statusCode: 400 | 409 | 503 = 409,
  ) {
    super(publicMessage);
    this.name = "SelfUpdateFailure";
    this.code = code;
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

export type SelfUpdateCommand = (
  input: RunCommandInput,
) => Promise<CommandRunResult>;
export type SelfUpdateSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

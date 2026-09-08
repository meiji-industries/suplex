import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";

import {
  SELF_UPDATE_LOCK_FILENAME,
  SELF_UPDATE_OPERATION_FILENAME,
  SELF_UPDATE_RUNNER_CLAIM_FILENAME,
  SELF_UPDATE_STATUS_FILENAME,
} from "./self-update-contracts.js";
import type { SelfUpdateLock, SelfUpdatePayload, SelfUpdateRunnerClaim, UpdateOperationStatus } from "./self-update-contracts.js";
import { SelfUpdatePayloadSchema, UpdateLockSchema, UpdateOperationStatusSchema, UpdateRunnerClaimSchema } from "./self-update-contracts.js";

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

  async readLock(): Promise<SelfUpdateLock | undefined> {
    return readJson(lockPath(this.runtimeRoot), UpdateLockSchema);
  }

  async readRunnerClaim(): Promise<SelfUpdateRunnerClaim | undefined> {
    return readJson(runnerClaimPath(this.runtimeRoot), UpdateRunnerClaimSchema);
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
    } finally { await handle?.close(); }
  }

  async recordHelper(operationId: string, helper: SelfUpdatePayload["serverIdentity"]): Promise<boolean> {
    const lock = await this.readLock();
    if (!lock || lock.operationId !== operationId) return false;
    await writeJsonAtomically(lockPath(this.runtimeRoot), { ...lock, helper });
    return true;
  }

  async acquireRunnerClaim(operationId: string, identity: SelfUpdatePayload["serverIdentity"] | undefined, startedAt: string): Promise<boolean> {
    await mkdir(this.runtimeRoot, { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(runnerClaimPath(this.runtimeRoot), "wx", 0o600);
      const claim = { version: 1 as const, operationId, pid: identity?.pid ?? process.pid, startedAt: identity?.startedAt ?? startedAt, ...(identity ? { identity } : {}) };
      await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally { await handle?.close(); }
  }

  async releaseRunnerClaim(operationId: string): Promise<void> { const claim = await this.readRunnerClaim(); if (claim?.operationId === operationId) await rm(runnerClaimPath(this.runtimeRoot), { force: true }); }
  async releaseLock(operationId?: string): Promise<void> { if (!operationId) { await rm(lockPath(this.runtimeRoot), { force: true }); return; } const lock = await this.readLock(); if (lock?.operationId === operationId) await rm(lockPath(this.runtimeRoot), { force: true }); }
  async removePayload(operationId?: string): Promise<void> { if (!operationId) { await rm(operationPath(this.runtimeRoot), { force: true }); return; } const payload = await this.readPayload(); if (payload?.operationId === operationId) await rm(operationPath(this.runtimeRoot), { force: true }); }
  async cleanupOperation(operationId: string): Promise<void> { await this.removePayload(operationId); await this.releaseLock(operationId); }
}

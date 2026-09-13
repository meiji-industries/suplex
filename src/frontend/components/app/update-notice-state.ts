import { z } from "zod";

import type { UpdateOperationStatus, UpdateResponse } from "../../../http/contracts/update.js";

const OwnedUpdateAttemptSchema = z.object({
  operationId: z.string().min(1),
  targetRevision: z.string().min(1),
  previousInstanceId: z.string().min(1).optional(),
}).strict();

const UpdateNoticeMemorySchema = z.object({
  dismissedRevision: z.string().min(1).optional(),
  dismissedFailureId: z.string().min(1).optional(),
  ownedAttempt: OwnedUpdateAttemptSchema.optional(),
}).strict();

export type OwnedUpdateAttempt = z.infer<typeof OwnedUpdateAttemptSchema>;
export type UpdateNoticeMemory = z.infer<typeof UpdateNoticeMemorySchema>;
export type UpdateNoticeStorage = Pick<Storage, "getItem" | "setItem">;
export type UpdateNoticeStorageOwner = { readonly localStorage: UpdateNoticeStorage };

export type UpdateNoticeState =
  | { kind: "available"; revision: string }
  | { kind: "progress"; message: string }
  | { kind: "failure"; failureId: string; message: string };

export type LocalUpdateFailure = { failureId: string; targetRevision: string; message: string };

function storageKey(userId: string): string {
  return `forge.updateNotice.${encodeURIComponent(userId)}`;
}

function operationIsPending(status: UpdateOperationStatus["status"]): boolean {
  return status === "pending" || status === "preparing" || status === "restarting";
}

function operationProgress(operation: UpdateOperationStatus): string {
  if (operation.status === "preparing") return "Preparing the update…";
  if (operation.status === "restarting") return "Restarting…";
  return "Starting the update…";
}

export function readUpdateNoticeMemory(storage: UpdateNoticeStorage, userId: string): UpdateNoticeMemory {
  try {
    const stored = storage.getItem(storageKey(userId));
    return stored ? UpdateNoticeMemorySchema.parse(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

export function readStoredUpdateNoticeMemory(owner: UpdateNoticeStorageOwner, userId: string): UpdateNoticeMemory {
  try {
    return readUpdateNoticeMemory(owner.localStorage, userId);
  } catch {
    return {};
  }
}

export function writeUpdateNoticeMemory(storage: UpdateNoticeStorage, userId: string, memory: UpdateNoticeMemory): void {
  try {
    storage.setItem(storageKey(userId), JSON.stringify(memory));
  } catch {
    // Browser storage can be disabled.
  }
}

export function writeStoredUpdateNoticeMemory(owner: UpdateNoticeStorageOwner, userId: string, memory: UpdateNoticeMemory): void {
  try {
    writeUpdateNoticeMemory(owner.localStorage, userId, memory);
  } catch {
    // Browser storage can be disabled.
  }
}

export function replacementIsProven(update: UpdateResponse, attempt: OwnedUpdateAttempt): boolean {
  return Boolean(
    attempt.previousInstanceId
    && update.instanceId
    && update.instanceId !== attempt.previousInstanceId
    && update.currentRevision === attempt.targetRevision,
  );
}

export function reconcileOwnedAttempt(update: UpdateResponse, attempt: OwnedUpdateAttempt): OwnedUpdateAttempt {
  const operation = update.operation;
  if (!operation || operation.operationId !== attempt.operationId || operation.targetRevision === attempt.targetRevision) return attempt;
  return { ...attempt, targetRevision: operation.targetRevision };
}

export function dismissUpdateRevision(memory: UpdateNoticeMemory, revision: string): UpdateNoticeMemory {
  return { ...memory, dismissedRevision: revision };
}

export function dismissUpdateFailure(memory: UpdateNoticeMemory, failureId: string): UpdateNoticeMemory {
  return { ...memory, dismissedFailureId: failureId };
}

export function selectUpdateNotice(
  update: UpdateResponse,
  memory: UpdateNoticeMemory,
  localFailure?: LocalUpdateFailure,
): UpdateNoticeState | undefined {
  const localFailureSuperseded = localFailure && (
    update.currentRevision === localFailure.targetRevision
    || Boolean(update.available && update.revision && update.revision !== localFailure.targetRevision)
  );
  if (localFailure && !localFailureSuperseded && memory.dismissedFailureId !== localFailure.failureId) {
    return { kind: "failure", failureId: localFailure.failureId, message: localFailure.message };
  }

  const operation = update.operation;
  const operationSuperseded = operation && update.currentRevision === operation.targetRevision;
  const ownedOperationDismissed = operation
    && memory.ownedAttempt?.operationId === operation.operationId
    && memory.dismissedFailureId === operation.operationId;
  if (operation && ownedOperationDismissed && operationIsPending(operation.status)) return undefined;
  if (operation && !operationSuperseded && operationIsPending(operation.status)) {
    return { kind: "progress", message: operationProgress(operation) };
  }

  const ownedFailure = operation?.status === "failed"
    && memory.ownedAttempt?.operationId === operation.operationId
    && !operationSuperseded
    && (!update.available || update.revision === operation.targetRevision)
    && memory.dismissedFailureId !== operation.operationId;
  if (operation && ownedFailure) {
    return {
      kind: "failure",
      failureId: operation.operationId,
      message: "Forge could not restart.",
    };
  }

  if (update.available && update.revision && memory.dismissedRevision !== update.revision) {
    return { kind: "available", revision: update.revision };
  }
  return undefined;
}

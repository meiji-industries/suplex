import { expect, test } from "vitest";

import type { UpdateResponse } from "../src/http/contracts/update.js";
import {
  dismissUpdateFailure,
  dismissUpdateRevision,
  readStoredUpdateNoticeMemory,
  readUpdateNoticeMemory,
  reconcileOwnedAttempt,
  replacementIsProven,
  selectUpdateNotice,
  writeUpdateNoticeMemory,
  type UpdateNoticeStorage,
} from "../src/frontend/components/app/update-notice-state.js";

class MemoryStorage implements UpdateNoticeStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const failedOperation = {
  operationId: "11111111-1111-4111-8111-111111111111",
  status: "failed" as const,
  targetRevision: "b".repeat(40),
  acceptedAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:01:00.000Z",
  error: "The helper exited.",
};

test("a historical failure does not become a current failure notice when its target is running", () => {
  const update: UpdateResponse = {
    available: false,
    currentRevision: failedOperation.targetRevision,
    operation: failedOperation,
  };

  expect(selectUpdateNotice(update, { ownedAttempt: { operationId: failedOperation.operationId, targetRevision: failedOperation.targetRevision } })).toBeUndefined();
});

test("proof that the target is running suppresses a local confirmation timeout", () => {
  const update: UpdateResponse = {
    available: false,
    currentRevision: failedOperation.targetRevision,
    operation: { ...failedOperation, status: "restarting" },
  };

  expect(selectUpdateNotice(
    update,
    { ownedAttempt: { operationId: failedOperation.operationId, targetRevision: failedOperation.targetRevision } },
    { failureId: failedOperation.operationId, targetRevision: failedOperation.targetRevision, message: "Forge could not confirm the restart." },
  )).toBeUndefined();
});

test("dismissing one available revision does not dismiss a newer revision", () => {
  const dismissed = dismissUpdateRevision({}, "a".repeat(40));
  expect(selectUpdateNotice({ available: true, revision: "a".repeat(40) }, dismissed)).toBeUndefined();
  expect(selectUpdateNotice({ available: true, revision: "b".repeat(40) }, dismissed)).toEqual({ kind: "available", revision: "b".repeat(40) });
});

test("only the person who requested a genuine failed operation sees its fresh failure", () => {
  const update: UpdateResponse = {
    available: true,
    revision: failedOperation.targetRevision,
    currentRevision: "a".repeat(40),
    operation: failedOperation,
  };

  expect(selectUpdateNotice(update, {})).toEqual({ kind: "available", revision: failedOperation.targetRevision });
  expect(selectUpdateNotice(update, { ownedAttempt: { operationId: failedOperation.operationId, targetRevision: failedOperation.targetRevision } })).toEqual({
    kind: "failure",
    failureId: failedOperation.operationId,
    message: "Forge could not restart.",
  });
});

test("an owned failure for an older target does not attach to a newly available revision", () => {
  const newRevision = "c".repeat(40);
  const update: UpdateResponse = {
    available: true,
    revision: newRevision,
    currentRevision: "a".repeat(40),
    operation: failedOperation,
  };

  expect(selectUpdateNotice(update, { ownedAttempt: { operationId: failedOperation.operationId, targetRevision: failedOperation.targetRevision } })).toEqual({
    kind: "available",
    revision: newRevision,
  });
});

test("failure dismissal survives a remount and stays scoped to the requesting user", () => {
  const storage = new MemoryStorage();
  const owned = { ownedAttempt: { operationId: failedOperation.operationId, targetRevision: failedOperation.targetRevision } };
  writeUpdateNoticeMemory(storage, "user-1", dismissUpdateFailure(owned, failedOperation.operationId));

  const update: UpdateResponse = {
    available: true,
    revision: failedOperation.targetRevision,
    currentRevision: "a".repeat(40),
    operation: failedOperation,
  };
  expect(selectUpdateNotice(update, readUpdateNoticeMemory(storage, "user-1"))).toEqual({ kind: "available", revision: failedOperation.targetRevision });
  expect(readUpdateNoticeMemory(storage, "user-2")).toEqual({});
});

test("dismissing a confirmation timeout hides progress without discarding restart ownership", () => {
  const owned = { ownedAttempt: { operationId: failedOperation.operationId, targetRevision: failedOperation.targetRevision } };
  const dismissed = dismissUpdateFailure(owned, failedOperation.operationId);
  const update: UpdateResponse = {
    available: true,
    revision: failedOperation.targetRevision,
    currentRevision: "a".repeat(40),
    operation: { ...failedOperation, status: "restarting" },
  };

  expect(dismissed.ownedAttempt).toEqual(owned.ownedAttempt);
  expect(selectUpdateNotice(update, dismissed)).toBeUndefined();
});

test("no update observation does not claim Forge is current and does not show a notice", () => {
  expect(selectUpdateNotice({ available: false }, {})).toBeUndefined();
});

test("replacement proof does not depend on operation metadata", () => {
  const attempt = {
    operationId: failedOperation.operationId,
    targetRevision: failedOperation.targetRevision,
    previousInstanceId: "old-instance",
  };
  expect(replacementIsProven({ available: false, currentRevision: failedOperation.targetRevision, instanceId: "new-instance" }, attempt)).toBe(true);
  expect(replacementIsProven({ available: false, currentRevision: failedOperation.targetRevision, instanceId: "old-instance" }, attempt)).toBe(false);
});

test("an owned attempt follows the server-selected target for the same operation", () => {
  const selectedRevision = "c".repeat(40);
  const attempt = {
    operationId: failedOperation.operationId,
    targetRevision: failedOperation.targetRevision,
    previousInstanceId: "old-instance",
  };
  const update: UpdateResponse = {
    available: true,
    revision: selectedRevision,
    operation: { ...failedOperation, status: "preparing", targetRevision: selectedRevision },
  };

  expect(reconcileOwnedAttempt(update, attempt)).toEqual({ ...attempt, targetRevision: selectedRevision });
  expect(reconcileOwnedAttempt({ ...update, operation: { ...update.operation!, operationId: "another-operation" } }, attempt)).toEqual(attempt);
});

test("a disabled browser storage getter does not prevent rendering", () => {
  const owner = {
    get localStorage(): UpdateNoticeStorage {
      throw new Error("storage denied");
    },
  };
  expect(readStoredUpdateNoticeMemory(owner, "user-1")).toEqual({});
});

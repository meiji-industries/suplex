import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { AgentFailure } from "../src/codex-lead.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { cancelOperation, claimOperation, operationKey, settleOperation } from "../src/operation-claims.js";

test("operation claims acquire once and compare-and-set terminal results", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-claims-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  try {
    const key = operationKey(["push", "task_1", "forge/task_1", "a".repeat(40)]);
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push" })).toEqual({ status: "acquired" });
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push" })).toEqual({ status: "in_progress" });
    expect(settleOperation(database, key, "settled", { pushed: true })).toEqual({ applied: true });
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push" })).toEqual({ status: "settled", result: { pushed: true } });
    expect(settleOperation(database, key, "failed", { message: "late failure" })).toEqual({ applied: false, status: "settled", result: { pushed: true } });
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push" })).toEqual({ status: "settled", result: { pushed: true } });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed and cancelled claims remain terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-cancel-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  try {
    const cancellation = { status: "failed", reasonCode: "cancelled", summary: "Cancelled before the turn started" };
    const cancelled = operationKey(["turn", "task_1", "developer_1"]);
    cancelOperation(database, { key: cancelled, taskId: "task_1", kind: "turn" });
    expect(claimOperation(database, { key: cancelled, taskId: "task_1", kind: "turn" })).toEqual({ status: "failed", result: cancellation });
    expect(settleOperation(database, cancelled, "settled", { done: true })).toEqual({ applied: false, status: "failed", result: cancellation });

    const settled = operationKey(["turn", "task_1", "developer_2"]);
    claimOperation(database, { key: settled, taskId: "task_1", kind: "turn" });
    settleOperation(database, settled, "settled", { done: true });
    cancelOperation(database, { key: settled, taskId: "task_1", kind: "turn" });
    expect(claimOperation(database, { key: settled, taskId: "task_1", kind: "turn" })).toEqual({ status: "settled", result: { done: true } });

    const failed = operationKey(["turn", "task_1", "developer_3"]);
    claimOperation(database, { key: failed, taskId: "task_1", kind: "turn" });
    settleOperation(database, failed, "failed", { message: "first failure" });
    cancelOperation(database, { key: failed, taskId: "task_1", kind: "turn" });
    expect(claimOperation(database, { key: failed, taskId: "task_1", kind: "turn" })).toEqual({ status: "failed", result: { message: "first failure" } });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("supervised turn claims execute one callback and replay the settled result", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-race-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const context = createActivityContext(database, config);
    const input = { taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_1" };
    const result = { developerExecutionId: "developer_1", evidenceArtifactId: null };
    let callbackCalls = 0;
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = context.runSupervised(input, async () => {
      callbackCalls += 1;
      signalStarted();
      await gate;
      return result;
    });
    await started;

    await expect(context.runSupervised(input, async () => {
      callbackCalls += 1;
      return result;
    })).rejects.toMatchObject({ type: "operation-in-progress", nonRetryable: false });
    expect(callbackCalls).toBe(1);

    release();
    const completed = await first;
    await expect(context.runSupervised(input, async () => {
      callbackCalls += 1;
      return result;
    })).resolves.toEqual(completed);
    expect(callbackCalls).toBe(1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("supervised turn claims replay failed and cancelled outcomes without callbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-terminal-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const context = createActivityContext(database, config);
    const failedInput = { taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_failed" };
    let failedCalls = 0;
    const failed = await context.runSupervised(failedInput, async () => {
      failedCalls += 1;
      throw new AgentFailure("builder-failed", "Builder failed");
    });
    await expect(context.runSupervised(failedInput, async () => {
      failedCalls += 1;
      return { developerExecutionId: "developer_failed", evidenceArtifactId: null };
    })).resolves.toEqual(failed);
    expect(failedCalls).toBe(1);

    const cancelledInput = { ...failedInput, developerTurnExecutionId: "developer_cancelled" };
    cancelOperation(database, { key: operationKey(["turn", cancelledInput.taskId, cancelledInput.developerTurnExecutionId]), taskId: cancelledInput.taskId, kind: "turn" });
    let cancelledCalls = 0;
    await expect(context.runSupervised(cancelledInput, async () => {
      cancelledCalls += 1;
      return { developerExecutionId: "developer_cancelled", evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "failed", reasonCode: "cancelled" });
    expect(cancelledCalls).toBe(0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

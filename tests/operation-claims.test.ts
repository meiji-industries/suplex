import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { AgentFailure } from "../src/codex-lead.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { cancelOperation, claimOperation, operationKey, recoverOperation, settleOperation } from "../src/operation-claims.js";

test("operation claims fence recovery and preserve terminal results", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-claims-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  try {
    const key = operationKey(["push", "task_1", "origin", "refs/heads/forge/task_1", "a".repeat(40)]);
    const coordinates = { identity: { remote: "origin", ref: "refs/heads/forge/task_1", commit: "a".repeat(40) }, authority: { remoteCommit: null } };
    const first = claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates, ownerToken: "worker-a" });
    expect(first).toMatchObject({ status: "acquired", ownership: { ownerToken: "worker-a", generation: 1 }, coordinates });
    if (first.status !== "acquired") throw new Error("Expected acquired claim");
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates, ownerToken: "worker-a" })).toEqual({ status: "in_progress" });
    const recoverable = claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates, ownerToken: "worker-b" });
    expect(recoverable).toMatchObject({ status: "recoverable", previousOwnership: first.ownership });
    if (recoverable.status !== "recoverable") throw new Error("Expected recoverable claim");
    const recovered = recoverOperation(database, key, recoverable.previousOwnership, "worker-b");
    expect(recovered).toEqual({ ownerToken: "worker-b", generation: 2 });
    expect(recoverOperation(database, key, recoverable.previousOwnership, "worker-c")).toBeNull();
    expect(settleOperation(database, key, first.ownership, "failed", { summary: "stale" })).toEqual({ applied: false, status: "in_progress", result: null });
    expect(settleOperation(database, key, recovered!, "settled", { pushed: true })).toEqual({ applied: true });
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates })).toEqual({ status: "settled", result: { pushed: true } });
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates: { ...coordinates, identity: { ...coordinates.identity, remote: "other" } } })).toEqual({ status: "failed", result: { reasonCode: "operation-identity-drift", summary: "Operation recovery identity changed" } });
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates })).toEqual({ status: "settled", result: { pushed: true } });
    expect(settleOperation(database, key, recovered!, "failed", { summary: "late failure" })).toEqual({ applied: false, status: "settled", result: { pushed: true } });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed and cancelled claims remain terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-cancel-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  const coordinates = { identity: { taskId: "task_1", executionId: "developer" }, authority: { table: "forge_herdr_turns" } };
  try {
    const cancellation = { status: "failed", reasonCode: "cancelled", summary: "Cancelled before the turn started" };
    const cancelled = operationKey(["turn", "task_1", "developer_1"]);
    cancelOperation(database, { key: cancelled, taskId: "task_1", kind: "turn" });
    expect(claimOperation(database, { key: cancelled, taskId: "task_1", kind: "turn", coordinates, allowLegacyTerminal: true })).toEqual({ status: "failed", result: cancellation });
    expect(settleOperation(database, cancelled, { ownerToken: "none", generation: 1 }, "settled", { done: true })).toEqual({ applied: false, status: "failed", result: cancellation });

    const settled = operationKey(["turn", "task_1", "developer_2"]);
    const settledClaim = claimOperation(database, { key: settled, taskId: "task_1", kind: "turn", coordinates: { ...coordinates, identity: { ...coordinates.identity, executionId: "developer_2" } } });
    if (settledClaim.status !== "acquired") throw new Error("Expected acquired claim");
    settleOperation(database, settled, settledClaim.ownership, "settled", { done: true });
    cancelOperation(database, { key: settled, taskId: "task_1", kind: "turn" });
    expect(claimOperation(database, { key: settled, taskId: "task_1", kind: "turn", coordinates: settledClaim.coordinates })).toEqual({ status: "settled", result: { done: true } });

    const failed = operationKey(["turn", "task_1", "developer_3"]);
    const failedClaim = claimOperation(database, { key: failed, taskId: "task_1", kind: "turn", coordinates: { ...coordinates, identity: { ...coordinates.identity, executionId: "developer_3" } } });
    if (failedClaim.status !== "acquired") throw new Error("Expected acquired claim");
    settleOperation(database, failed, failedClaim.ownership, "failed", { summary: "first failure" });
    cancelOperation(database, { key: failed, taskId: "task_1", kind: "turn" });
    expect(claimOperation(database, { key: failed, taskId: "task_1", kind: "turn", coordinates: failedClaim.coordinates })).toEqual({ status: "failed", result: { summary: "first failure" } });
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

test("legacy null-coordinate turn without Herdr authority fails closed for manual recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-legacy-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: "task_legacy", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_legacy" };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const now = new Date().toISOString();
    database.authQuery((db) => db.prepare("INSERT INTO forge_operation_claims (operation_key, task_id, kind, status, created_at, updated_at) VALUES (?, ?, 'turn', 'claimed', ?, ?)").run(key, input.taskId, now, now));
    let serviceCalls = 0;
    await expect(createActivityContext(database, config).runSupervised(input, async () => {
      serviceCalls += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "failed", reasonCode: "operation-recovery-manual" });
    expect(serviceCalls).toBe(0);
    expect(database.authQuery((db) => db.prepare("SELECT status, coordinates_json AS coordinatesJson, generation FROM forge_operation_claims WHERE operation_key = ?").get(key))).toMatchObject({ status: "failed", coordinatesJson: expect.any(String), generation: 2 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { name: "turn", promptKind: "implementation" },
  { name: "repair", promptKind: "delivery-repair" },
])("abandoned $name claim dispatches exactly once after modern ledger absence", async ({ name, promptKind }) => {
  const root = await mkdtemp(join(tmpdir(), `forge-operation-${name}-before-`));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: `task_${name}`, companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: `developer_${name}` };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer" }, authority: { table: "forge_herdr_turns" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: "crashed-worker" });
    let externalDispatches = 0;
    await expect(createActivityContext(database, config).runSupervised(input, async () => {
      externalDispatches += 1;
      const now = new Date().toISOString();
      database.authQuery((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_start_offset, rollout_cursor_offset, correction_index, status, created_at, updated_at, finished_at) VALUES (?, ?, ?, 'builder', 'developer', ?, ?, ?, ?, 0, 0, 0, 'completed', ?, ?, ?)").run(`turn_${name}`, input.taskId, `session_${name}`, input.developerTurnExecutionId, promptKind, "a".repeat(64), `${name}-result.json`, now, now, now);
      });
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "completed" });
    expect(externalDispatches).toBe(1);
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_herdr_turns WHERE execution_id = ?").get(input.developerTurnExecutionId))).toEqual({ count: 1 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { name: "turn", promptKind: "implementation" },
  { name: "repair", promptKind: "delivery-repair" },
])("completed $name ledger settles an abandoned claim with zero new external dispatches", async ({ name, promptKind }) => {
  const root = await mkdtemp(join(tmpdir(), `forge-operation-${name}-after-`));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: `task_${name}_completed`, companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: `developer_${name}_completed` };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer" }, authority: { table: "forge_herdr_turns" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: "crashed-worker" });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_start_offset, rollout_cursor_offset, correction_index, status, created_at, updated_at, finished_at) VALUES (?, ?, ?, 'builder', 'developer', ?, ?, ?, ?, 0, 0, 0, 'completed', ?, ?, ?)").run(`turn_${name}_completed`, input.taskId, `session_${name}_completed`, input.developerTurnExecutionId, promptKind, "a".repeat(64), `${name}-completed-result.json`, now, now, now);
    });
    let serviceReentries = 0;
    let externalDispatches = 0;
    await expect(createActivityContext(database, config).runSupervised(input, async () => {
      serviceReentries += 1;
      const ledger = database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_turns WHERE ledger = 'developer' AND execution_id = ?").get(input.developerTurnExecutionId)) as { status: string } | undefined;
      if (ledger?.status !== "completed") externalDispatches += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "completed" });
    expect(serviceReentries).toBe(1);
    expect(externalDispatches).toBe(0);
    expect(database.authQuery((db) => db.prepare("SELECT status, generation FROM forge_operation_claims WHERE operation_key = ?").get(key))).toEqual({ status: "settled", generation: 2 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

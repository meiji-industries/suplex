import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { AgentFailure } from "../src/codex-lead.js";
import { ForgeDatabase } from "../src/database.js";
import { createCiActivities } from "../src/engine/activities/ci.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { cancelOperation, claimOperation, operationKey, recoverOperation, settleOperation } from "../src/operation-claims.js";

const localHostIdentity = createHash("sha256").update(hostname()).digest("hex");
const deadOwnerToken = `${localHostIdentity}:2147483647:crashed-worker`;
const liveOtherOwnerToken = `${localHostIdentity}:${process.pid}:other-worker`;

test("operation claims fence recovery and preserve terminal results", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-claims-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  try {
    const key = operationKey(["push", "task_1", "origin", "refs/heads/forge/task_1", "a".repeat(40)]);
    const coordinates = { identity: { remote: "origin", ref: "refs/heads/forge/task_1", commit: "a".repeat(40) }, authority: { remoteCommit: null } };
    const first = claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates, ownerToken: deadOwnerToken });
    expect(first).toMatchObject({ status: "acquired", ownership: { ownerToken: deadOwnerToken, generation: 1 }, coordinates });
    if (first.status !== "acquired") throw new Error("Expected acquired claim");
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates, ownerToken: deadOwnerToken })).toEqual({ status: "in_progress" });
    const recoverable = claimOperation(database, { key, taskId: "task_1", kind: "push", coordinates, ownerToken: liveOtherOwnerToken });
    expect(recoverable).toMatchObject({ status: "recoverable", previousOwnership: first.ownership });
    if (recoverable.status !== "recoverable") throw new Error("Expected recoverable claim");
    const recovered = recoverOperation(database, key, recoverable.previousOwnership, liveOtherOwnerToken);
    expect(recovered).toEqual({ ownerToken: liveOtherOwnerToken, generation: 2 });
    expect(recoverOperation(database, key, recoverable.previousOwnership, `${process.pid}:worker-c`)).toBeNull();
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

test("a live local owner prevents identity collision and keeps settlement authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-live-owner-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  try {
    const key = operationKey(["push", "task_live", "branch", "a".repeat(40)]);
    const coordinates = { identity: { ref: "refs/heads/branch", commit: "a".repeat(40) }, authority: { remoteCommit: null } };
    const first = claimOperation(database, { key, taskId: "task_live", kind: "push", coordinates, ownerToken: `${localHostIdentity}:${process.pid}:worker-a` });
    expect(first).toMatchObject({ status: "acquired" });
    if (first.status !== "acquired") throw new Error("Expected acquired claim");
    const differentIdentity = { ...coordinates, identity: { ...coordinates.identity, ref: "refs/heads/other" } };
    expect(claimOperation(database, { key, taskId: "task_live", kind: "push", coordinates: differentIdentity, ownerToken: `${localHostIdentity}:${process.pid}:worker-b` })).toEqual({ status: "in_progress" });
    expect(database.authQuery((db) => db.prepare("SELECT status, owner_token AS ownerToken, generation FROM forge_operation_claims WHERE operation_key = ?").get(key))).toEqual({ status: "claimed", ownerToken: first.ownership.ownerToken, generation: 1 });
    expect(settleOperation(database, key, first.ownership, "settled", { pushed: true })).toEqual({ applied: true });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a foreign or unverifiable owner fails closed without recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-foreign-owner-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  try {
    const key = operationKey(["merge", "task_foreign", "a".repeat(40)]);
    const coordinates = { identity: { repository: "acme/forge", ref: "refs/heads/task" }, authority: { priorHead: "a".repeat(40) } };
    expect(claimOperation(database, { key, taskId: "task_foreign", kind: "merge", coordinates, ownerToken: `foreign-host:${process.pid}:worker-a` })).toMatchObject({ status: "acquired" });
    expect(claimOperation(database, { key, taskId: "task_foreign", kind: "merge", coordinates })).toEqual({ status: "failed", result: { reasonCode: "operation-owner-unverifiable", summary: "Operation owner identity could not be verified; manual recovery is required" } });
    expect(database.authQuery((db) => db.prepare("SELECT status, generation FROM forge_operation_claims WHERE operation_key = ?").get(key))).toEqual({ status: "claimed", generation: 1 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dead-owner identity drift terminalizes with owner and generation fencing", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-dead-owner-drift-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  try {
    const key = operationKey(["push", "task_dead", "branch", "a".repeat(40)]);
    const coordinates = { identity: { ref: "refs/heads/branch", commit: "a".repeat(40) }, authority: { remoteCommit: null } };
    expect(claimOperation(database, { key, taskId: "task_dead", kind: "push", coordinates, ownerToken: deadOwnerToken })).toMatchObject({ status: "acquired" });
    const differentIdentity = { ...coordinates, identity: { ...coordinates.identity, ref: "refs/heads/other" } };
    expect(claimOperation(database, { key, taskId: "task_dead", kind: "push", coordinates: differentIdentity })).toEqual({ status: "failed", result: { reasonCode: "operation-identity-drift", summary: "Operation recovery identity changed" } });
    expect(database.authQuery((db) => db.prepare("SELECT status, generation FROM forge_operation_claims WHERE operation_key = ?").get(key))).toEqual({ status: "failed", generation: 1 });
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
    const first = context.runSupervised(input, "implementation", async () => {
      callbackCalls += 1;
      signalStarted();
      await gate;
      return result;
    });
    await started;

    await expect(context.runSupervised(input, "implementation", async () => {
      callbackCalls += 1;
      return result;
    })).rejects.toMatchObject({ type: "operation-in-progress", nonRetryable: false });
    expect(callbackCalls).toBe(1);

    release();
    const completed = await first;
    await expect(context.runSupervised(input, "implementation", async () => {
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
    const failed = await context.runSupervised(failedInput, "implementation", async () => {
      failedCalls += 1;
      throw new AgentFailure("builder-failed", "Builder failed");
    });
    await expect(context.runSupervised(failedInput, "implementation", async () => {
      failedCalls += 1;
      return { developerExecutionId: "developer_failed", evidenceArtifactId: null };
    })).resolves.toEqual(failed);
    expect(failedCalls).toBe(1);

    const cancelledInput = { ...failedInput, developerTurnExecutionId: "developer_cancelled" };
    cancelOperation(database, { key: operationKey(["turn", cancelledInput.taskId, cancelledInput.developerTurnExecutionId]), taskId: cancelledInput.taskId, kind: "turn" });
    let cancelledCalls = 0;
    await expect(context.runSupervised(cancelledInput, "implementation", async () => {
      cancelledCalls += 1;
      return { developerExecutionId: "developer_cancelled", evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "failed", reasonCode: "cancelled" });
    expect(cancelledCalls).toBe(0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("supervised turn normalizes an unverifiable owner failure without dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-owner-failure-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: "task_owner_failure", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_owner_failure" };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind: "implementation" }, authority: { table: "forge_herdr_turns", promptKind: "implementation" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: `foreign-host:${process.pid}:worker` });
    let callbacks = 0;
    await expect(createActivityContext(database, config).runSupervised(input, "implementation", async () => {
      callbacks += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toEqual({ status: "failed", developerExecutionId: input.developerTurnExecutionId, reasonCode: "operation-owner-unverifiable", summary: "Operation owner identity could not be verified; manual recovery is required", evidenceArtifactId: null });
    expect(callbacks).toBe(0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("supervised turn normalizes dead-owner identity drift without dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-identity-failure-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: "task_identity_failure", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_identity_failure" };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const wrongCoordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind: "delivery-repair" }, authority: { table: "forge_herdr_turns", promptKind: "delivery-repair" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates: wrongCoordinates, ownerToken: deadOwnerToken });
    let callbacks = 0;
    await expect(createActivityContext(database, config).runSupervised(input, "implementation", async () => {
      callbacks += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toEqual({ status: "failed", developerExecutionId: input.developerTurnExecutionId, reasonCode: "operation-identity-drift", summary: "Operation recovery identity changed", evidenceArtifactId: null });
    expect(callbacks).toBe(0);
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
    await expect(createActivityContext(database, config).runSupervised(input, "implementation", async () => {
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
  { name: "turn" },
  { name: "repair" },
])("modern abandoned $name claim without exact ledger authority fails closed without dispatch", async ({ name }) => {
  const root = await mkdtemp(join(tmpdir(), `forge-operation-${name}-before-`));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const turnKind = name === "repair" ? "repair" as const : "implementation" as const;
    const promptKind = turnKind === "repair" ? "delivery-repair" : "implementation";
    const input = { taskId: `task_${name}`, companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: `developer_${name}`, turnKind };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind }, authority: { table: "forge_herdr_turns", promptKind } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: deadOwnerToken });
    let externalDispatches = 0;
    await expect(createActivityContext(database, config).runSupervised(input, promptKind, async () => {
      externalDispatches += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "failed", reasonCode: "operation-recovery-manual" });
    expect(externalDispatches).toBe(0);
    expect(database.authQuery((db) => db.prepare("SELECT status, generation FROM forge_operation_claims WHERE operation_key = ?").get(key))).toEqual({ status: "failed", generation: 2 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt-sent Herdr authority re-enters without a second external prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-prompt-sent-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: "task_prompt_sent", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_prompt_sent" };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind: "implementation" }, authority: { table: "forge_herdr_turns", promptKind: "implementation" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: deadOwnerToken });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_start_offset, rollout_cursor_offset, correction_index, status, prompt_sent_at, created_at, updated_at) VALUES ('turn_prompt_sent', ?, 'session_prompt_sent', 'builder', 'developer', ?, 'implementation', ?, 'prompt-sent-result.json', 0, 0, 0, 'waiting', ?, ?, ?)").run(input.taskId, input.developerTurnExecutionId, "a".repeat(64), now, now, now);
    });
    let serviceReentries = 0;
    let externalPrompts = 0;
    await expect(createActivityContext(database, config).runSupervised(input, "implementation", async () => {
      serviceReentries += 1;
      const row = database.authQuery((db) => db.prepare("SELECT prompt_sent_at AS promptSentAt FROM forge_herdr_turns WHERE execution_id = ?").get(input.developerTurnExecutionId)) as { promptSentAt: string | null } | undefined;
      if (!row?.promptSentAt) externalPrompts += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "completed" });
    expect(serviceReentries).toBe(1);
    expect(externalPrompts).toBe(0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("wrong prompt-kind ledger row fails closed without dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-wrong-prompt-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: "task_wrong_prompt", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_wrong_prompt" };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind: "implementation" }, authority: { table: "forge_herdr_turns", promptKind: "implementation" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: deadOwnerToken });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, prompt_sent_at, status, created_at, updated_at) VALUES ('turn_wrong_prompt', ?, 'session_wrong_prompt', 'builder', 'developer', ?, 'delivery-repair', ?, 'wrong-prompt-result.json', 0, ?, 'waiting', ?, ?)").run(input.taskId, input.developerTurnExecutionId, "a".repeat(64), now, now, now);
    });
    let callbacks = 0;
    await expect(createActivityContext(database, config).runSupervised(input, "implementation", async () => {
      callbacks += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toEqual({ status: "failed", developerExecutionId: input.developerTurnExecutionId, reasonCode: "operation-identity-drift", summary: "Developer turn recovery identity changed", evidenceArtifactId: null });
    expect(callbacks).toBe(0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["created", "dispatching", "waiting"])("matching %s turn without durable prompt evidence fails closed without redispatch", async (status) => {
  const root = await mkdtemp(join(tmpdir(), `forge-operation-turn-${status}-`));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: `task_${status}`, companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: `developer_${status}` };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind: "implementation" }, authority: { table: "forge_herdr_turns", promptKind: "implementation" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: deadOwnerToken });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_start_offset, rollout_cursor_offset, correction_index, status, created_at, updated_at) VALUES (?, ?, ?, 'builder', 'developer', ?, 'implementation', ?, ?, 0, 0, 0, ?, ?, ?)").run(`turn_${status}`, input.taskId, `session_${status}`, input.developerTurnExecutionId, "a".repeat(64), `${status}-result.json`, status, now, now);
    });
    let externalDispatches = 0;
    await expect(createActivityContext(database, config).runSupervised(input, "implementation", async () => {
      externalDispatches += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "failed", reasonCode: "operation-recovery-manual" });
    expect(externalDispatches).toBe(0);
    expect(database.authQuery((db) => db.prepare("SELECT status, generation FROM forge_operation_claims WHERE operation_key = ?").get(key))).toEqual({ status: "failed", generation: 2 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("correction-required row without its next correction fails before service re-entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-missing-correction-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: "task_missing_correction", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_missing_correction" };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind: "implementation" }, authority: { table: "forge_herdr_turns", promptKind: "implementation" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: deadOwnerToken });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, prompt_sent_at, status, created_at, updated_at) VALUES ('turn_missing_correction', ?, 'session_missing_correction', 'builder', 'developer', ?, 'implementation', ?, 'missing-correction.json', 0, ?, 'correction_required', ?, ?)").run(input.taskId, input.developerTurnExecutionId, "a".repeat(64), now, now, now);
    });
    let callbacks = 0;
    await expect(createActivityContext(database, config).runSupervised(input, "implementation", async () => {
      callbacks += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "failed", reasonCode: "operation-recovery-manual" });
    expect(callbacks).toBe(0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an ambiguous correction row blocks recovery despite an earlier prompt-sent row", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-turn-correction-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = { taskId: "task_correction", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: "developer_correction" };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind: "implementation" }, authority: { table: "forge_herdr_turns", promptKind: "implementation" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: deadOwnerToken });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      const insert = db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_start_offset, rollout_cursor_offset, correction_index, status, prompt_sent_at, created_at, updated_at) VALUES (?, ?, 'session_correction', 'builder', 'developer', ?, 'implementation', ?, ?, 0, 0, ?, ?, ?, ?, ?)");
      insert.run("turn_correction_0", input.taskId, input.developerTurnExecutionId, "a".repeat(64), "correction-0.json", 0, "correction_required", now, now, now);
      insert.run("turn_correction_1", input.taskId, input.developerTurnExecutionId, "b".repeat(64), "correction-1.json", 1, "dispatching", null, now, now);
    });
    let externalDispatches = 0;
    await expect(createActivityContext(database, config).runSupervised(input, "implementation", async () => {
      externalDispatches += 1;
      return { developerExecutionId: input.developerTurnExecutionId, evidenceArtifactId: null };
    })).resolves.toMatchObject({ status: "failed", reasonCode: "operation-recovery-manual" });
    expect(externalDispatches).toBe(0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { name: "turn", promptKind: "implementation" },
  { name: "repair", promptKind: "delivery-repair" },
] as const)("completed $name ledger settles an abandoned claim with zero new external dispatches", async ({ name, promptKind }) => {
  const root = await mkdtemp(join(tmpdir(), `forge-operation-${name}-after-`));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const turnKind = name === "repair" ? "repair" as const : "implementation" as const;
    const input = { taskId: `task_${name}_completed`, companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: `developer_${name}_completed`, turnKind };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind }, authority: { table: "forge_herdr_turns", promptKind } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: deadOwnerToken });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_start_offset, rollout_cursor_offset, correction_index, status, prompt_sent_at, created_at, updated_at, finished_at) VALUES (?, ?, ?, 'builder', 'developer', ?, ?, ?, ?, 0, 0, 0, 'completed', ?, ?, ?, ?)").run(`turn_${name}_completed`, input.taskId, `session_${name}_completed`, input.developerTurnExecutionId, promptKind, "a".repeat(64), `${name}-completed-result.json`, now, now, now, now);
    });
    let serviceReentries = 0;
    let externalDispatches = 0;
    await expect(createActivityContext(database, config).runSupervised(input, promptKind, async () => {
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

test.each([
  { ledgerPromptKind: "ci-repair", expectedCode: "operation-recovery-manual" },
  { ledgerPromptKind: "delivery-repair", expectedCode: "operation-identity-drift" },
])("CI supervised recovery fails closed for $ledgerPromptKind ledger authority", async ({ ledgerPromptKind, expectedCode }) => {
  const root = await mkdtemp(join(tmpdir(), `forge-operation-ci-${ledgerPromptKind}-`));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const input = {
      taskId: "task_ci", companyId: "company_ci", workflowId: "workflow_ci", projectId: "project_ci", projectRevisionId: "revision_ci", planRevision: 1,
      ciRunId: "run_ci", ciAttemptId: "attempt_ci", repairPlanId: "plan_ci", repairPlanArtifactId: "plan_artifact", repairPlanEvidenceArtifactId: "plan_evidence",
      failedHeadSha: "a".repeat(40), priorDeveloperExecutionId: "developer_prior", priorDeveloperSessionRef: "session_prior", worktreePath: "/worktree",
      branchName: "forge/task-ci", priorCommit: "a".repeat(40), priorTree: "b".repeat(40), developerTurnExecutionId: "developer_ci_outer",
      developerAttempt: 1, turnKind: "repair" as const, roleProfiles: { integrator: "profile_ci" },
    };
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const coordinates = { identity: { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, executionId: input.developerTurnExecutionId, ledger: "developer", promptKind: "ci-repair" }, authority: { table: "forge_herdr_turns", promptKind: "ci-repair" } };
    claimOperation(database, { key, taskId: input.taskId, kind: "turn", coordinates, ownerToken: deadOwnerToken });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_ci', 'CI', 'codex', 'gpt-5.6-sol', 'medium', 'standard', 1, ?, ?)").run(now, now);
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, prompt_sent_at, status, created_at, updated_at) VALUES ('turn_ci', ?, 'session_ci', 'integrator', 'developer', ?, ?, ?, 'ci-result.json', 0, ?, 'waiting', ?, ?)").run(input.taskId, input.developerTurnExecutionId, ledgerPromptKind, "a".repeat(64), now, now, now);
    });
    let serviceCalls = 0;
    const context = createActivityContext(database, config, { developer: { runCiRepair: async () => {
      serviceCalls += 1;
      return { repairId: "repair", developerExecutionId: input.developerTurnExecutionId, developerSessionRef: "session", worktreePath: input.worktreePath, branchName: input.branchName, priorCommit: input.priorCommit, priorTree: input.priorTree, resultCommit: null, resultTree: null, deliveryArtifactId: "delivery", evidenceArtifactId: "evidence", summary: "unused", outcome: "blocked" as const };
    } } });
    await expect(createCiActivities(context).runCiRepair(input)).rejects.toMatchObject({ type: expectedCode, nonRetryable: true });
    expect(serviceCalls).toBe(0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

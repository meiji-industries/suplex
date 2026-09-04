import { describe, expect, test } from "vitest";

import {
  cancelDeliveryIntent,
  claimOrRecoverDeliveryOwner,
  completeDeliveryOperation,
  recordDeliveryObservation,
  scheduleDeliveryWake,
} from "../src/delivery-supervision.js";
import { recoverInterruptedOperation } from "../src/engine/runs.js";
import { buildInitialIssueWorkflowState, type IssueWorkflowInput } from "../src/engine/issue-contracts.js";
import { at } from "../src/issue-phases.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

const intent = (generation = 1) => ({
  taskId: "delivery-supervision",
  companyId: engineFixture.companyId,
  workflowId: "workflow-delivery-supervision",
  projectRevisionId: engineFixture.projectRevisionId,
  generation,
  repository: "acme/forge",
  branch: "forge/delivery-supervision",
  target: "merged",
  baseline: "a".repeat(40),
  objective: "Preserve the Builder worktree.",
});

async function fixture() {
  const value = await createEngineHarness();
  value.seedTask("delivery-supervision");
  return value;
}

describe("durable delivery supervision", () => {
  test("keeps a stable key across presentation revisions and rejects a double claim", async () => {
    const value = await fixture();
    const first = claimOrRecoverDeliveryOwner(value.database, intent(), { token: "first", now: new Date("2026-09-04T00:00:00.000Z"), liveness: "stopped" });
    const second = claimOrRecoverDeliveryOwner(value.database, intent(), { token: "second", now: new Date("2026-09-04T00:00:01.000Z"), liveness: "stopped" });
    expect(first).toMatchObject({ outcome: "owned", token: "first" });
    expect(second).toMatchObject({ outcome: "owned_elsewhere" });
    expect(value.database.authQuery((db) => db.prepare("SELECT operation_key AS key, delivery_generation AS generation FROM forge_provider_operations").get())).toEqual({ key: "delivery-owner:delivery-supervision:workflow-delivery-supervision:1", generation: 1 });
    await value.stop();
  });

  test("requires a stopped live observation before an expired owner can recover", async () => {
    const value = await fixture();
    claimOrRecoverDeliveryOwner(value.database, intent(), { token: "first", now: new Date("2026-09-04T00:00:00.000Z"), leaseMs: 10, liveness: "stopped" });
    expect(claimOrRecoverDeliveryOwner(value.database, intent(), { token: "live", now: new Date("2026-09-04T00:01:00.000Z"), liveness: "live" })).toMatchObject({ outcome: "owned_elsewhere" });
    expect(claimOrRecoverDeliveryOwner(value.database, intent(), { token: "unknown", now: new Date("2026-09-04T00:01:00.000Z"), liveness: "unknown" })).toMatchObject({ outcome: "owned_elsewhere" });
    expect(claimOrRecoverDeliveryOwner(value.database, intent(), { token: "recovered", now: new Date("2026-09-04T00:01:00.000Z"), liveness: "stopped" })).toMatchObject({ outcome: "recovered", token: "recovered" });
    await value.stop();
  });

  test("heartbeats, journals an observation, and keeps the wake through an engine restart", async () => {
    const value = await fixture();
    const owner = claimOrRecoverDeliveryOwner(value.database, intent(), { token: "owner", now: new Date("2026-09-04T00:00:00.000Z"), liveness: "stopped" });
    if (owner.outcome === "owned_elsewhere" || owner.outcome === "cancelled") throw new Error("owner was not claimed");
    const wakeAt = "2026-09-04T00:10:00.000Z";
    expect(recordDeliveryObservation(value.database, intent(), owner.token, { herdr: "stopped", worktree: { dirty: true } })).toBe(true);
    expect(scheduleDeliveryWake(value.database, intent(), owner.token, wakeAt)).toBe(true);
    await value.restart();
    expect(value.database.authQuery((db) => db.prepare("SELECT retry_at AS retryAt, heartbeat_at AS heartbeatAt, result_json AS resultJson FROM forge_provider_operations").get())).toMatchObject({ retryAt: wakeAt, heartbeatAt: expect.any(String), resultJson: expect.stringContaining("dirty") });
    await value.stop();
  });

  test("adopts one completion and fences duplicate or stale delayed results", async () => {
    const value = await fixture();
    const owner = claimOrRecoverDeliveryOwner(value.database, intent(), { token: "owner", liveness: "stopped" });
    if (owner.outcome === "owned_elsewhere" || owner.outcome === "cancelled") throw new Error("owner was not claimed");
    expect(completeDeliveryOperation(value.database, intent(), owner.token, { commit: "b".repeat(40) })).toBe("owned");
    expect(completeDeliveryOperation(value.database, intent(), owner.token, { commit: "c".repeat(40) })).toBe("owned_elsewhere");
    expect(completeDeliveryOperation(value.database, intent(2), owner.token, { commit: "d".repeat(40) })).toBe("owned_elsewhere");
    await value.stop();
  });

  test("cancellation fences a delayed result and removes the due wake", async () => {
    const value = await fixture();
    const owner = claimOrRecoverDeliveryOwner(value.database, intent(), { token: "owner", liveness: "stopped" });
    if (owner.outcome === "owned_elsewhere" || owner.outcome === "cancelled") throw new Error("owner was not claimed");
    expect(cancelDeliveryIntent(value.database, intent())).toBe(true);
    expect(completeDeliveryOperation(value.database, intent(), owner.token, { unexpected: "late" })).toBe("cancelled");
    expect(value.database.authQuery((db) => db.prepare("SELECT cancelled_at AS cancelledAt, retry_at AS retryAt FROM forge_provider_operations").get())).toEqual({ cancelledAt: expect.any(String), retryAt: null });
    await value.stop();
  });

  test("a task without a plan revision keeps one intent through UI revisions and pre-claim cancellation", async () => {
    const value = await fixture();
    const lifecycle = intent(0);
    expect(cancelDeliveryIntent(value.database, lifecycle)).toBe(true);
    expect(claimOrRecoverDeliveryOwner(value.database, lifecycle, { token: "revision-99", liveness: "stopped" })).toMatchObject({ outcome: "cancelled" });
    expect(completeDeliveryOperation(value.database, lifecycle, "revision-99", { delayed: true })).toBe("cancelled");
    expect(value.database.authQuery((db) => db.prepare("SELECT operation_key AS key, cancelled_at AS cancelledAt FROM forge_provider_operations").get())).toEqual({ key: "delivery-owner:delivery-supervision:workflow-delivery-supervision:0", cancelledAt: expect.any(String) });
    await value.stop();
  });

  test("a stale Builder execution resumes its preserved dirty delivery instead of parking a human", async () => {
    const value = await fixture();
    const input: IssueWorkflowInput = {
      workflowId: intent().workflowId,
      companyId: intent().companyId,
      projectId: engineFixture.projectId,
      issueId: intent().taskId,
      projectRevisionId: intent().projectRevisionId,
      briefArtifactId: engineFixture.briefArtifactId,
      imageArtifactIds: [],
      roleProfiles: engineFixture.roleProfiles,
      supplementalReview: false,
    };
    const state = {
      ...buildInitialIssueWorkflowState(input),
      ...at("development"),
      revision: 4,
      owner: "lead" as const,
      activeOperation: { commandId: "interrupted-builder", kind: "development" as const, startedRevision: 4 },
      developerExecutionId: "missing-builder",
      dirtyState: "dirty" as const,
      deliverySummary: "Keep the partial diff and complete the remaining objective.",
      lastEventId: `${input.workflowId}:4`,
    };
    const recovered = recoverInterruptedOperation(state, value.database);
    expect(recovered).toMatchObject({ step: "development", owner: "lead", blocker: null, dirtyState: "dirty", activeOperation: null, developerRecoveryStatus: "interrupted" });
    await value.stop();
  });
});

import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  cancelDeliveryIntent,
  claimOrRecoverDeliveryOwner,
  completeDeliveryOperation,
  recordDeliveryObservation,
  scheduleDeliveryWake,
} from "../src/delivery-supervision.js";
import { createDeliveryOwnerActivities } from "../src/engine/activities/release.js";
import { recoverInterruptedOperation } from "../src/engine/runs.js";
import { buildInitialIssueWorkflowState, type IssueWorkflowInput } from "../src/engine/issue-contracts.js";
import { at } from "../src/issue-phases.js";
import { createEngineHarness, engineFixture, ImmediateClock } from "./helpers/engine-harness.js";

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
const exec = promisify(execFile);

class PausedClock extends ImmediateClock {
  override async wait(_milliseconds: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }
}

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

  test("the production ownership activity keeps a live writer and schedules an unknown observation", async () => {
    const value = await fixture();
    try {
      claimOrRecoverDeliveryOwner(value.database, intent(), { token: "stale-builder", now: new Date("2026-09-04T00:00:00.000Z"), leaseMs: 1, liveness: "stopped" });
      const live = createDeliveryOwnerActivities(value.database, value.config, async () => ({ state: "live" as const }));
      await expect(live.claimDeliveryOwner({ ...intent(), token: "replacement" })).resolves.toMatchObject({ outcome: "owned_elsewhere" });
      const unknown = createDeliveryOwnerActivities(value.database, value.config, async () => ({ state: "unknown" as const }));
      const unknownResult = await unknown.claimDeliveryOwner({ ...intent(2), token: "unknown-builder" });
      expect(unknownResult).toMatchObject({ outcome: "owned_elsewhere", wakeAt: expect.any(String) });
      expect(value.database.authQuery((db) => db.prepare("SELECT owner_token AS ownerToken, retry_at AS retryAt FROM forge_provider_operations WHERE operation_key = ?").get("delivery-owner:delivery-supervision:workflow-delivery-supervision:2"))).toEqual({ ownerToken: null, retryAt: expect.any(String) });
    } finally {
      await value.stop();
    }
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

  test("the production receipt activity rejects a result that arrives after cancellation", async () => {
    const value = await fixture();
    try {
      const ownership = createDeliveryOwnerActivities(value.database, value.config, async () => ({ state: "stopped" as const }));
      const owner = await ownership.claimDeliveryOwner({ ...intent(), token: "owner" });
      if (owner.outcome === "owned_elsewhere" || owner.outcome === "cancelled") throw new Error("owner was not claimed");
      expect(await ownership.cancelDeliveryOwner(intent())).toBe(true);
      await expect(ownership.recordDeliveryOwnerReceipt({ ...intent(), token: "owner", receipt: { delayed: true } })).resolves.toBe(false);
      expect(value.database.authQuery((db) => db.prepare("SELECT result_json AS resultJson FROM forge_provider_operations WHERE operation_key = ?").get("delivery-owner:delivery-supervision:workflow-delivery-supervision:1"))).toMatchObject({ resultJson: expect.not.stringContaining("delayed") });
    } finally {
      await value.stop();
    }
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

  test("a stopped Builder resumes its dirty worktree through the production handler after restart", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "forge-delivery-owner-"));
    const inputs: Array<{ developerTurnExecutionId: string; resume?: { worktreePath: string; developerSessionRef: string; objective: string } }> = [];
    let calls = 0;
    let builderLive = false;
    const value = await createEngineHarness({
      projectIssueState: async (event) => event.state,
      readHerdrTurn: async () => builderLive ? ({ type: "owner.live" as const }) : ({ type: "owner.absent" as const }),
      runDeveloperExecutionSupervised: async (input) => {
        inputs.push(input);
        calls += 1;
        builderLive = true;
        return {
          status: "completed" as const,
          resultHash: engineFixture.sha256,
          result: {
            developerExecutionId: input.developerTurnExecutionId,
            developerSessionRef: "builder-session",
            branchName: "forge/delivery-supervision",
            targetBaseSha: engineFixture.base,
            currentStep: 1,
            resultCommit: null,
            resultTree: null,
            dirtyState: "dirty" as const,
            deliveryArtifactId: "delivery",
            evidenceArtifactId: "evidence",
            deliverySummary: "Keep the partial Builder work and finish verification.",
            outcome: "blocked" as const,
            steps: [{ number: 1, status: "incomplete" }],
            authorizedStepsNotCompleted: [1],
            blocker: null,
          },
        };
      },
    }, new PausedClock());
    try {
      await exec("git", ["init", "-b", "main"], { cwd: worktree });
      await exec("git", ["config", "user.email", "forge@test"], { cwd: worktree });
      await exec("git", ["config", "user.name", "Forge"], { cwd: worktree });
      await writeFile(join(worktree, "tracked.txt"), "base\n");
      await exec("git", ["add", "tracked.txt"], { cwd: worktree });
      await exec("git", ["commit", "-m", "base"], { cwd: worktree });
      await writeFile(join(worktree, "dirty.txt"), "partial Builder work\n");
      value.seedTask("delivery-supervision");
      const taskIntent = { ...intent(0), workflowId: value.workflowId("delivery-supervision") };
      value.activities.claimDeliveryOwner = (input) => createDeliveryOwnerActivities(value.database, value.config, async () => ({ state: "stopped" as const })).claimDeliveryOwner(input);
      value.activities.recordDeliveryOwnerReceipt = (input) => createDeliveryOwnerActivities(value.database, value.config, async () => ({ state: "stopped" as const })).recordDeliveryOwnerReceipt(input);
      claimOrRecoverDeliveryOwner(value.database, taskIntent, { token: "interrupted-builder", now: new Date("2026-09-04T00:00:00.000Z"), leaseMs: 1, liveness: "stopped" });
      const initial = {
        ...buildInitialIssueWorkflowState({ workflowId: taskIntent.workflowId, companyId: taskIntent.companyId, projectId: engineFixture.projectId, issueId: taskIntent.taskId, projectRevisionId: taskIntent.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false }),
        ...at("development"),
        revision: 4,
        owner: "lead" as const,
        activeOperation: { commandId: "interrupted-builder", kind: "development" as const, startedRevision: 4 },
        developerExecutionId: "interrupted-builder",
        developerSessionRef: "builder-session",
        developerAttempt: 1,
        worktreePath: worktree,
        branchName: "forge/delivery-supervision",
        targetBaseSha: engineFixture.base,
        dirtyState: "dirty" as const,
        deliverySummary: "Keep the partial Builder work and finish verification.",
        planRevision: 4,
        planApproved: true,
        leadSessionRef: "lead-session",
        leadOutputArtifactId: "plan-artifact",
        lastEventId: `${taskIntent.workflowId}:4`,
      };
      value.seedContinuation("delivery-supervision", initial);
      await value.restart();
      await value.settle(taskIntent.workflowId, () => inputs.length === 1);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ resume: { worktreePath: worktree, developerSessionRef: "builder-session", objective: "Keep the partial Builder work and finish verification." } });
      expect(await readFile(join(worktree, "dirty.txt"), "utf8")).toBe("partial Builder work\n");
      builderLive = false;
      await value.restart();
      await value.settle(taskIntent.workflowId, () => inputs.length === 2);
      expect(calls).toBe(2);
      expect(inputs[1]).toMatchObject({ resume: { worktreePath: worktree, developerSessionRef: "builder-session", objective: "Keep the partial Builder work and finish verification." } });
      expect(value.database.authQuery((db) => db.prepare("SELECT completed_at AS completedAt FROM forge_provider_operations WHERE operation_key = ?").get(`delivery-owner:delivery-supervision:${taskIntent.workflowId}:0`))).toEqual({ completedAt: null });
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await value.stop();
    }
  });
});

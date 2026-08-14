import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import proto from "@temporalio/proto";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { expect, test } from "vitest";

import type { CapacityRequestSnapshot, WorkflowCapacityState } from "../src/capacity-contracts.js";
import type { IssueActivities, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { cancelIssueUpdate, issueStateQuery, issueWorkflow, startPlanningUpdate } from "../src/temporal/workflows.js";

const requestedAt = "2026-08-12T00:00:00.000Z";
const durationKeys = new Set(["firstWorkflowTaskBackoff", "workflowTaskTimeout", "startToCloseTimeout", "scheduleToCloseTimeout", "scheduleToStartTimeout", "heartbeatTimeout", "initialInterval", "maximumInterval"]);

function sanitize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (durationKeys.has(key ?? "") && Object.keys(record).length === 0) return "0s";
  if ((typeof record.seconds === "string" || typeof record.seconds === "number") && (record.nanos === undefined || typeof record.nanos === "number")) {
    const nanos = typeof record.nanos === "number" ? record.nanos : 0;
    if (key === "eventTime") return new Date(Number(record.seconds) * 1_000 + nanos / 1_000_000).toISOString();
    return `${record.seconds}${nanos === 0 ? "" : `.${String(nanos).padStart(9, "0").replace(/0+$/, "")}`}s`;
  }
  return Object.fromEntries(Object.entries(record)
    .filter(([entryKey]) => entryKey !== "source" && entryKey !== "stackTrace")
    .map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)]));
}

function capacity(status: CapacityRequestSnapshot["status"], executionId: string | null = null, overrides: Partial<CapacityRequestSnapshot> = {}): CapacityRequestSnapshot {
  return {
    id: "capacity-test",
    logicalTurnKey: "workflow-capacity-test:1:lead_planning",
    companyId: "company-test",
    taskId: "issue-test",
    workflowId: "workflow-capacity-test",
    projectRevisionId: "revision-test",
    workflowRevision: 1,
    operation: "lead_planning",
    role: "analyst",
    profileId: "profile-test",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningLevel: "medium",
    servicePriority: "standard",
    laneKey: "codex:profile-test",
    requestedCapacity: 2,
    status,
    waitReason: status === "queued" ? "lane_full" : null,
    skipReason: null,
    sessionRef: null,
    worktreePath: null,
    executionKind: executionId ? "agent" : null,
    executionId,
    requestedAt,
    deadlineAt: "2026-08-12T02:00:00.000Z",
    acquiredAt: status === "active" || status === "released" ? requestedAt : null,
    heartbeatAt: status === "active" ? requestedAt : null,
    retryAt: null,
    cancelledAt: null,
    releasedAt: status === "released" ? requestedAt : null,
    updatedAt: requestedAt,
    rateLimitAttempts: 0,
    terminalReason: status === "released" ? "completed" : null,
    ...overrides,
  };
}

function publicState(value: CapacityRequestSnapshot): WorkflowCapacityState {
  return { requestId: value.id, logicalTurnKey: value.logicalTurnKey, workflowRevision: value.workflowRevision, operation: value.operation, role: value.role, profileId: value.profileId, laneKey: value.laneKey, status: value.status, position: value.status === "queued" ? 1 : null, reason: value.waitReason, requestedAt: value.requestedAt, retryAt: value.retryAt, rateLimitAttempts: value.rateLimitAttempts };
}

async function captureHistory(filename: string, history: Awaited<ReturnType<import("@temporalio/client").WorkflowHandle["fetchHistory"]>>): Promise<void> {
  if (!process.env.FORGE_CAPACITY_REPLAY_CAPTURE_DIR) return;
  const value = proto.temporal.api.history.v1.History.create(history);
  const json = proto.temporal.api.history.v1.History.toObject(value, { longs: String, enums: String, bytes: String, defaults: false, arrays: true, objects: true });
  await writeFile(join(process.env.FORGE_CAPACITY_REPLAY_CAPTURE_DIR, filename), `${JSON.stringify(sanitize(json), null, 2)}\n`);
}

test("time-skipping Workflow wait is durable and quiet before admission", async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `capacity-time-skip-${randomUUID()}`;
  const projected: IssueWorkflowState[] = [];
  let acquireCalls = 0;
  const activities: Partial<IssueActivities> = {
    async projectIssueState(event) { projected.push(event.state); return event.state; },
    async requestCapacity() { return capacity("queued"); },
    async tryAcquireCapacity() {
      acquireCalls += 1;
      const result = capacity(acquireCalls === 1 ? "queued" : "active", acquireCalls === 1 ? null : "agent-test");
      return { status: result.status, publicState: publicState(result) };
    },
    async runLeadPlanning() { return { leadSessionRef: "session-test", leadExecutionId: "agent-test", leadEvidenceArtifactId: "evidence-test", leadOutputArtifactId: "output-test", leadOutputKind: "plan", leadSummary: "Plan", materialCategories: [], material: false }; },
    async inspectCapacity() { return capacity("active", "agent-test"); },
    async finalizeCapacity() { return capacity("released", "agent-test"); },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: activities as IssueActivities });
  const startedAt = Date.now();
  try {
    const completed = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(issueWorkflow, { taskQueue, workflowId: "workflow-capacity-test", args: [{ workflowId: "workflow-capacity-test", companyId: "company-test", projectId: "project-test", issueId: "issue-test", projectRevisionId: "revision-test", briefArtifactId: "brief-test", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: { analyst: "profile-test" }, supplementalReview: false }] });
      const update = handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: 0, actorUserId: "user-test" }] });
      while (acquireCalls === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      await environment.sleep(5_000);
      const state = await update;
      return { state, history: await handle.fetchHistory() };
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(acquireCalls).toBe(2);
    expect(projected.some((state) => state.capacity?.status === "queued" && state.pendingAction === "Waiting for external capacity" && !state.allowedCommands.includes("retry_capacity"))).toBe(true);
    expect(completed.state).toMatchObject({ phase: "ready_for_development", capacity: null, allowedCommands: ["start_development", "cancel_issue", "revise_plan"] });
    if (process.env.FORGE_CAPACITY_REPLAY_CAPTURE_PATH) {
      const history = proto.temporal.api.history.v1.History.create(completed.history);
      const json = proto.temporal.api.history.v1.History.toObject(history, { longs: String, enums: String, bytes: String, defaults: false, arrays: true, objects: true });
      await writeFile(process.env.FORGE_CAPACITY_REPLAY_CAPTURE_PATH, `${JSON.stringify(sanitize(json), null, 2)}\n`);
    }
  } finally {
    await environment.teardown();
  }
}, 30_000);

test("queued cancellation wins the race and the waiting handler cannot overwrite it", async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `capacity-cancel-${randomUUID()}`;
  const activities: Partial<IssueActivities> = {
    async projectIssueState(event) { return event.state; },
    async requestCapacity() { return capacity("queued"); },
    async tryAcquireCapacity() { const result = capacity("queued"); return { status: "queued", publicState: publicState(result) }; },
    async cancelCapacity() { return capacity("cancelled"); },
    async inspectCapacity() { return capacity("cancelled"); },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: activities as IssueActivities });
  try {
    const completed = await worker.runUntil(async () => {
      const workflowId = "workflow-capacity-queued-cancel";
      const handle = await environment.client.workflow.start(issueWorkflow, { taskQueue, workflowId, args: [{ workflowId, companyId: "company-test", projectId: "project-test", issueId: "issue-queued-cancel", projectRevisionId: "revision-test", briefArtifactId: "brief-test", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: { analyst: "profile-test" }, supplementalReview: false }] });
      const planning = handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: 0, actorUserId: "user-test" }] });
      let waiting = await handle.query(issueStateQuery);
      while (waiting.capacity?.status !== "queued") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        waiting = await handle.query(issueStateQuery);
      }
      const state = await handle.executeUpdate(cancelIssueUpdate, { args: [{ expectedRevision: waiting.revision, actorUserId: "user-test" }] });
      await environment.sleep(5_000);
      await planning.catch(() => undefined);
      return { state, history: await handle.fetchHistory() };
    });
    expect(completed.state).toMatchObject({ phase: "cancelled", capacity: null, allowedCommands: ["continue_work"], pendingAction: "Issue cancelled" });
    await captureHistory("queued-cancellation.json", completed.history);
  } finally {
    await environment.teardown();
  }
}, 30_000);

test("rate-limit reset durably requeues and reacquires the same logical turn", async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `capacity-rate-limit-${randomUUID()}`;
  const retryAt = new Date((await environment.currentTimeMs()) + 60_000).toISOString();
  let runAttempts = 0;
  let acquireCalls = 0;
  let rateLimitCalls = 0;
  const requestIds: string[] = [];
  const activities: Partial<IssueActivities> = {
    async projectIssueState(event) { return event.state; },
    async requestCapacity() { return capacity("queued"); },
    async tryAcquireCapacity() {
      acquireCalls += 1;
      const result = capacity("active", acquireCalls === 1 ? "agent-rate-1" : "agent-rate-2");
      return { status: "active", publicState: publicState(result) };
    },
    async runLeadPlanning(input) {
      runAttempts += 1;
      requestIds.push(input.capacityRequestId ?? "missing");
      if (runAttempts === 1) throw ApplicationFailure.retryable("Provider rate limit", "rate-limited", { retryAt });
      return { leadSessionRef: "session-rate", leadExecutionId: "agent-rate-2", leadEvidenceArtifactId: "evidence-rate", leadOutputArtifactId: "output-rate", leadOutputKind: "plan", leadSummary: "Plan", materialCategories: [], material: false };
    },
    async inspectCapacity() { return capacity("active", acquireCalls === 1 ? "agent-rate-1" : "agent-rate-2"); },
    async rateLimitCapacity() { rateLimitCalls += 1; return capacity("rate_limited", "agent-rate-1", { retryAt, rateLimitAttempts: 1, waitReason: "rate_limit_reset" }); },
    async requeueCapacity() { return capacity("queued", null, { rateLimitAttempts: 1 }); },
    async finalizeCapacity() { return capacity("released", "agent-rate-2", { rateLimitAttempts: 1 }); },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: activities as IssueActivities });
  try {
    const completed = await worker.runUntil(async () => {
      const workflowId = "workflow-capacity-rate-limit";
      const handle = await environment.client.workflow.start(issueWorkflow, { taskQueue, workflowId, args: [{ workflowId, companyId: "company-test", projectId: "project-test", issueId: "issue-rate-limit", projectRevisionId: "revision-test", briefArtifactId: "brief-test", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: { analyst: "profile-test" }, supplementalReview: false }] });
      const state = await handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: 0, actorUserId: "user-test" }] });
      return { state, history: await handle.fetchHistory() };
    });
    expect(runAttempts).toBe(2);
    expect(rateLimitCalls).toBe(1);
    expect(acquireCalls).toBe(2);
    expect(new Set(requestIds)).toEqual(new Set(["capacity-test"]));
    expect(completed.state).toMatchObject({ phase: "ready_for_development", capacity: null });
    await captureHistory("rate-limit-reset-reacquire.json", completed.history);
  } finally {
    await environment.teardown();
  }
}, 30_000);

test("Activity retry preserves the capacity request for wrapper reattachment", async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `capacity-activity-retry-${randomUUID()}`;
  const requestIds: string[] = [];
  let runAttempts = 0;
  const activities: Partial<IssueActivities> = {
    async projectIssueState(event) { return event.state; },
    async requestCapacity() { return capacity("queued"); },
    async tryAcquireCapacity() { const result = capacity("active", "agent-retry"); return { status: "active", publicState: publicState(result) }; },
    async runLeadPlanning(input) {
      runAttempts += 1;
      requestIds.push(input.capacityRequestId ?? "missing");
      if (runAttempts === 1) throw new Error("simulated worker loss after durable launch");
      return { leadSessionRef: "session-retry", leadExecutionId: "agent-retry", leadEvidenceArtifactId: "evidence-retry", leadOutputArtifactId: "output-retry", leadOutputKind: "plan", leadSummary: "Plan", materialCategories: [], material: false };
    },
    async inspectCapacity() { return capacity("active", "agent-retry"); },
    async finalizeCapacity() { return capacity("released", "agent-retry"); },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: activities as IssueActivities });
  try {
    const completed = await worker.runUntil(async () => {
      const workflowId = "workflow-capacity-wrapper-retry";
      const handle = await environment.client.workflow.start(issueWorkflow, { taskQueue, workflowId, args: [{ workflowId, companyId: "company-test", projectId: "project-test", issueId: "issue-wrapper-retry", projectRevisionId: "revision-test", briefArtifactId: "brief-test", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: { analyst: "profile-test" }, supplementalReview: false }] });
      const state = await handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: 0, actorUserId: "user-test" }] });
      return { state, history: await handle.fetchHistory() };
    });
    expect(runAttempts).toBe(2);
    expect(requestIds).toEqual(["capacity-test", "capacity-test"]);
    expect(completed.state).toMatchObject({ phase: "ready_for_development", capacity: null });
    await captureHistory("worker-restart-wrapper-reattachment.json", completed.history);
  } finally {
    await environment.teardown();
  }
}, 30_000);

test.each(["ownership_ambiguous", "released"] as const)("a failed turn does not finalize a %s slot it no longer owns", async (capacityStatus) => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `capacity-ownership-race-${randomUUID()}`;
  let finalizeCalls = 0;
  const activities: Partial<IssueActivities> = {
    async projectIssueState(event) { return event.state; },
    async requestCapacity() { return capacity("queued"); },
    async tryAcquireCapacity() { const result = capacity("active", "agent-lost"); return { status: "active", publicState: publicState(result) }; },
    async runLeadPlanning() { throw ApplicationFailure.nonRetryable("Lead ownership is ambiguous", "ownership_ambiguous"); },
    async inspectCapacity() { return capacity(capacityStatus, "agent-lost", capacityStatus === "ownership_ambiguous" ? { terminalReason: "ownership_ambiguous", skipReason: "Worker restart could not prove ownership" } : {}); },
    async finalizeCapacity() {
      finalizeCalls += 1;
      throw ApplicationFailure.nonRetryable("Capacity request not-owner", "not-owner");
    },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: activities as IssueActivities });
  try {
    const state = await worker.runUntil(async () => {
      const workflowId = "workflow-capacity-ownership-race";
      const handle = await environment.client.workflow.start(issueWorkflow, { taskQueue, workflowId, args: [{ workflowId, companyId: "company-test", projectId: "project-test", issueId: "issue-ownership-race", projectRevisionId: "revision-test", briefArtifactId: "brief-test", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: { analyst: "profile-test" }, supplementalReview: false }] });
      return handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: 0, actorUserId: "user-test" }] });
    });
    expect(finalizeCalls).toBe(0);
    expect(state).toMatchObject({ phase: "failed", owner: "human" });
  } finally {
    await environment.teardown();
  }
}, 30_000);

test.each([
  ["ownership_ambiguous", "ownership-ambiguity-blocker.json"],
  ["exhausted", "bounded-capacity-exhaustion.json"],
] as const)("%s admission becomes one typed Workflow blocker", async (status, fixtureName) => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `capacity-blocker-${status}-${randomUUID()}`;
  const activities: Partial<IssueActivities> = {
    async projectIssueState(event) { return event.state; },
    async requestCapacity() { return capacity("queued"); },
    async tryAcquireCapacity() { const result = capacity(status); return { status, publicState: publicState(result) }; },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: activities as IssueActivities });
  try {
    const completed = await worker.runUntil(async () => {
      const workflowId = `workflow-capacity-${status.replace("_", "-")}`;
      const handle = await environment.client.workflow.start(issueWorkflow, { taskQueue, workflowId, args: [{ workflowId, companyId: "company-test", projectId: "project-test", issueId: `issue-${status.replace("_", "-")}`, projectRevisionId: "revision-test", briefArtifactId: "brief-test", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: { analyst: "profile-test" }, supplementalReview: false }] });
      const state = await handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: 0, actorUserId: "user-test" }] });
      return { state, history: await handle.fetchHistory() };
    });
    expect(completed.state).toMatchObject({ phase: "planning", owner: "human", allowedCommands: ["retry_capacity", "cancel_issue"], capacity: { status }, capacityBlocker: { category: status === "exhausted" ? "capacity_exhausted" : "ownership_ambiguous" } });
    if (process.env.FORGE_CAPACITY_REPLAY_CAPTURE_DIR) {
      const history = proto.temporal.api.history.v1.History.create(completed.history);
      const json = proto.temporal.api.history.v1.History.toObject(history, { longs: String, enums: String, bytes: String, defaults: false, arrays: true, objects: true });
      await writeFile(join(process.env.FORGE_CAPACITY_REPLAY_CAPTURE_DIR, fixtureName), `${JSON.stringify(sanitize(json), null, 2)}\n`);
    }
  } finally {
    await environment.teardown();
  }
}, 30_000);

import { expect, test } from "vitest";
import { activityContext } from "../src/engine/activity-context.js";
import { runExecution } from "../src/engine/registry.js";
import { createActivityCaller } from "../src/engine/activities.js";
import { ActivityFailure, ApplicationFailure, CancelledFailure, isCancellation } from "../src/engine/failures.js";
import { durableCommand, executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/engine/service.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema, type IssueProjectionEvent, type IssueWorkflowInput, type IssueWorkflowState } from "../src/engine/issue-contracts.js";
import type { LeadPlanningResult } from "../src/lead-contracts.js";
import { Wakeable, type IssueRun } from "../src/engine/runs.js";
import { createEngineHarness, engineFixture, ImmediateClock, type EngineHarness } from "./helpers/engine-harness.js";
import { withWorktreeCommands } from "../src/engine/workflow/state-transitions.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function commandReceiptCount(harness: EngineHarness, commandId: string): number {
  const row = harness.database.authQuery((db) => db.prepare("SELECT count(*) AS count FROM forge_engine_commands WHERE command_id = ?").get(commandId) as { count: number });
  return row.count;
}

function workflowInput(issueId: string, continuationState?: IssueWorkflowInput["continuationState"]): Omit<IssueWorkflowInput, "workflowId"> {
  return {
    companyId: engineFixture.companyId,
    projectId: engineFixture.projectId,
    issueId,
    projectRevisionId: engineFixture.projectRevisionId,
    briefArtifactId: engineFixture.briefArtifactId,
    briefSha256: engineFixture.sha256,
    imageArtifactIds: [],
    roleProfiles: engineFixture.roleProfiles,
    supplementalReview: false,
    ...(continuationState ? { continuationState } : {}),
  };
}

function persistContinuation(harness: EngineHarness, issueId: string, continuation: NonNullable<IssueWorkflowInput["continuationState"]>): void {
  const workflowId = harness.workflowId(issueId);
  const initial = IssueWorkflowStateSchema.parse(buildInitialIssueWorkflowState({ workflowId, ...workflowInput(issueId) }));
  for (let revision = 0; revision <= (continuation.revision ?? 0); revision += 1) {
    const state = revision === continuation.revision
      ? IssueWorkflowStateSchema.parse({ ...initial, ...continuation })
      : IssueWorkflowStateSchema.parse({ ...initial, revision, phase: revision === 0 ? "backlog" : "planning", owner: revision === 0 ? "human" : "lead", allowedCommands: revision === 0 ? ["start_planning"] : [], pendingAction: revision === 0 ? "Start planning" : "Lead planning", lastEventId: `${workflowId}:${revision}` });
    harness.database.projectIssueEvent({ schemaVersion: 1, runId: `seed-${issueId}`, eventId: state.lastEventId, state });
  }
}

function leadPlan(workflowId: string, issueId: string): LeadPlanningResult {
  return {
    leadExecutionId: "lead-plan",
    leadSessionRef: "lead-session",
    leadOutputArtifactId: "plan-artifact",
    leadEvidenceArtifactId: "plan-evidence",
    leadOutputArtifactSha256: engineFixture.sha256,
    leadOutputKind: "plan",
    leadSummary: "A material plan",
    materialCategories: ["security_permissions"],
    material: true,
    planSubject: {
      companyId: engineFixture.companyId,
      issueId,
      workflowId,
      originalPlanRevision: 1,
      outputId: "plan-output",
      outputRevision: 1,
      finalVersion: 1,
      artifactId: "plan-artifact",
      artifactSha256: engineFixture.sha256,
      leadSessionRef: "lead-session",
      leadExecutionId: "lead-plan",
      evidenceManifestArtifactId: "plan-evidence",
      evidenceManifestSha256: engineFixture.sha256,
    },
  };
}

test("durable command IDs are stable", () => {
  const input = { expectedRevision: 0, actorUserId: "member" };
  expect(durableCommand("workflow", "cancel", input).commandId).toBe(durableCommand("workflow", "cancel", input).commandId);
});

test("global command identity collision is rejected before another workflow effect", async () => {
  let effects = 0;
  const harness = await createEngineHarness({
    projectIssueState: async (event: IssueProjectionEvent) => event.state,
    crossWorkflowEffect: async () => { effects += 1; },
  } as never);
  for (const issueId of ["command-owner-a", "command-owner-b"]) harness.seedTask(issueId);
  try {
    const first = await startIssueWorkflow(harness.config, workflowInput("command-owner-a"));
    const second = await startIssueWorkflow(harness.config, workflowInput("command-owner-b"));
    const firstRun = harness.engine.run(first.workflowId), secondRun = harness.engine.run(second.workflowId);
    await Promise.all([firstRun.ready(), secondRun.ready()]);
    const commandId = "global-command-identity";
    const firstResult = IssueWorkflowStateSchema.parse({ ...firstRun.state, revision: 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "First workflow", lastEventId: `${first.workflowId}:1` });
    firstRun.commands.set("crossWorkflowCommand", (async () => {
      await runExecution.current().activity("projectIssueState", [{ schemaVersion: 1, runId: firstRun.runId, eventId: firstResult.lastEventId, state: firstResult }], { startToCloseTimeout: "1 minute" });
      return firstResult;
    }) as never);
    await firstRun.execute("crossWorkflowCommand", {}, commandId);
    secondRun.commands.set("crossWorkflowCommand", (async () => {
      await runExecution.current().activity("crossWorkflowEffect", [], { startToCloseTimeout: "1 minute" });
      return secondRun.state;
    }) as never);

    expect(() => secondRun.execute("crossWorkflowCommand", {}, commandId)).toThrow("another workflow or command");
    expect(effects).toBe(0);
    expect(commandReceiptCount(harness, commandId)).toBe(1);
  } finally {
    await harness.stop();
  }
});

test("command receipt inherits the exact decorated final projection", async () => {
  const harness = await createEngineHarness({ projectIssueState: async (event) => event.state });
  for (const issueId of ["decorated-result", "decorated-conflict", "decorated-mismatch"]) harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput("decorated-result"));
    const run = harness.engine.run(started.workflowId);
    await run.ready();
    const live = run.state;
    const nextRevision = live.revision + 1;
    const raw = IssueWorkflowStateSchema.parse({ ...live, revision: nextRevision, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Raw handler result", lastEventId: `${started.workflowId}:${nextRevision}`, branchName: "forge/decorated-result", worktreePath: "/worktrees/decorated-result", worktreeState: "present", developerExecutionId: "developer-decorated-result", targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40), resultTree: "c".repeat(40) });
    const decorated = withWorktreeCommands(IssueWorkflowStateSchema.parse({ ...raw, allowedCommands: ["cancel_issue"], pendingAction: "Decorated projection result" }));
    expect(decorated.allowedCommands).toEqual(["cancel_issue", "delete_worktree", "retry_target_base_reconciliation"]);
    run.commands.set("decoratedResultCommand", (async () => {
      await runExecution.current().activity("projectIssueState", [{ schemaVersion: 1, runId: run.runId, eventId: decorated.lastEventId, state: decorated }], { startToCloseTimeout: "1 minute" });
      return raw;
    }) as never);
    const result = await run.execute("decoratedResultCommand", {}, "decorated-result-command");
    expect(result).toEqual(decorated);
    const receipt = harness.database.authQuery((db) => db.prepare("SELECT result_json FROM forge_engine_commands WHERE command_id = ?").get("decorated-result-command") as { result_json: string });
    expect(IssueWorkflowStateSchema.parse(JSON.parse(receipt.result_json))).toEqual(decorated);
    expect(run.state).toEqual(decorated);

    const conflictStarted = await startIssueWorkflow(harness.config, workflowInput("decorated-conflict"));
    const conflictRun = harness.engine.run(conflictStarted.workflowId);
    await conflictRun.ready();
    const conflictRevision = conflictRun.state.revision + 1;
    const firstDecoration = IssueWorkflowStateSchema.parse({ ...conflictRun.state, revision: conflictRevision, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "First decoration", lastEventId: `${conflictStarted.workflowId}:${conflictRevision}` });
    const secondDecoration = IssueWorkflowStateSchema.parse({ ...firstDecoration, pendingAction: "Conflicting decoration" });
    conflictRun.commands.set("conflictingDecorationCommand", (async () => {
      const execution = runExecution.current();
      await execution.activity("projectIssueState", [{ schemaVersion: 1, runId: conflictRun.runId, eventId: firstDecoration.lastEventId, state: firstDecoration }], { startToCloseTimeout: "1 minute" });
      await execution.activity("projectIssueState", [{ schemaVersion: 1, runId: conflictRun.runId, eventId: secondDecoration.lastEventId, state: secondDecoration }], { startToCloseTimeout: "1 minute" });
      return secondDecoration;
    }) as never);
    await expect(conflictRun.execute("conflictingDecorationCommand", {}, "decorated-conflict-command")).rejects.toMatchObject({ code: "conflict" });
    expect(commandReceiptCount(harness, "decorated-conflict-command")).toBe(0);
    expect(harness.database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_projections WHERE workflow_id = ?").get(conflictStarted.workflowId))).toEqual({ revision: 0 });

    const mismatchStarted = await startIssueWorkflow(harness.config, workflowInput("decorated-mismatch"));
    const mismatchRun = harness.engine.run(mismatchStarted.workflowId);
    await mismatchRun.ready();
    const mismatchLive = mismatchRun.state;
    const mismatchRevision = mismatchLive.revision + 1;
    const mismatchRaw = IssueWorkflowStateSchema.parse({ ...mismatchLive, revision: mismatchRevision, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Raw mismatch", lastEventId: `${mismatchStarted.workflowId}:${mismatchRevision}`, branchName: "forge/decorated-mismatch", worktreePath: "/worktrees/decorated-mismatch", worktreeState: "present", developerExecutionId: "developer-decorated-mismatch", targetBaseSha: "d".repeat(40), resultCommit: "e".repeat(40), resultTree: "f".repeat(40) });
    const wrongIdentity = IssueWorkflowStateSchema.parse({ ...mismatchRaw, issueId: "different-task" });
    mismatchRun.commands.set("decoratedMismatchCommand", (async () => {
      await runExecution.current().activity("projectIssueState", [{ schemaVersion: 1, runId: mismatchRun.runId, eventId: wrongIdentity.lastEventId, state: wrongIdentity }], { startToCloseTimeout: "1 minute" });
      return mismatchRaw;
    }) as never);
    await expect(mismatchRun.execute("decoratedMismatchCommand", {}, "decorated-mismatch-command")).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(commandReceiptCount(harness, "decorated-mismatch-command")).toBe(0);
  } finally {
    await harness.stop();
  }
});

test("wake interrupts an engine wait", async () => {
  const wakeable = new Wakeable(); const controller = new AbortController(); let resolved = false;
  const waiting = wakeable.wait(60_000, controller.signal, { now: Date.now, wait: async (_ms, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new CancelledFailure()), { once: true })) }).then(() => { resolved = true; });
  wakeable.wake(); await waiting; expect(resolved).toBe(true);
});

test("real macrotask idle cancellation preserves workflow health and receipt", async () => {
  const idleWaitStarted = deferred<void>();
  let exerciseRealWait = false;
  const clock = new class extends ImmediateClock {
    override now(): number { return Date.now(); }
    override wait(milliseconds: number, signal: AbortSignal): Promise<void> {
      if (!exerciseRealWait) return super.wait(milliseconds, signal);
      idleWaitStarted.resolve(undefined);
      return new Promise<void>((resolve, reject) => {
        // The real macrotask is the behavior under test; the deferred signal avoids a timing guess.
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new CancelledFailure()); }, { once: true });
      });
    }
  }();
  const harness = await createEngineHarness({}, clock);
  const issueId = "real-clock-idle-cancel";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    exerciseRealWait = true;
    const run = harness.engine.run(started.workflowId);
    await idleWaitStarted.promise;
    const active = await queryIssueWorkflow(harness.config, started.workflowId);
    const commandId = "real-clock-idle-cancel-command";
    const cancelled = await executeIssueCommand(harness.config, started.workflowId, "cancel_issue", { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId, commandId });
    expect(cancelled).toMatchObject({ phase: "cancelled", revision: active.revision + 1 });
    expect(run.error).toBeUndefined();
    expect(run.state).toEqual(cancelled);
    expect(commandReceiptCount(harness, commandId)).toBe(1);
  } finally {
    await harness.stop();
  }
});

test("successful legacy interrupt releases the background wait barrier", async () => {
  const harness = await createEngineHarness();
  const issueId = "legacy-interrupt-release";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    const run = harness.engine.run(started.workflowId);
    await run.ready();
    run.interrupts.set("legacyCancel", { cancelActive: true, validate: (() => true) as never, run: (async () => "cancelled") as never });
    run.commands.set("legacyCancel", (async () => run.state) as never);
    run.commands.set("afterLegacyCancel", (async () => {
      await runExecution.current().wait(1);
      return run.state;
    }) as never);
    await run.execute("legacyCancel", {});
    await expect(run.execute("afterLegacyCancel", {})).resolves.toEqual(run.state);
    expect(run.error).toBeUndefined();
  } finally {
    await harness.stop();
  }
});

test("activity retries honor attempts and non-retryable types", async () => {
  let attempts = 0; const harness = await createEngineHarness();
  try {
    const caller = createActivityCaller(harness.database, { retrying() { attempts += 1; throw new Error("retry"); }, terminal() { attempts += 1; throw ApplicationFailure.nonRetryable("stop", "stop"); } }, async () => undefined);
    await expect(caller.call("retrying", [], { retry: { maximumAttempts: 3, initialInterval: 1 } }, new AbortController().signal, "workflow")).rejects.toThrow("failed");
    expect(attempts).toBe(3); attempts = 0;
    await expect(caller.call("terminal", [], { retry: { maximumAttempts: 3 } }, new AbortController().signal, "workflow")).rejects.toThrow("failed");
    expect(attempts).toBe(1);
    expect(isCancellation(new ActivityFailure("wrapped cancellation", new CancelledFailure()))).toBe(true);
  } finally { await harness.stop(); }
});

test("activity retry rechecks projection authority after backoff", async () => {
  const firstAttempt = deferred<void>(), releaseBackoff = deferred<void>();
  let effects = 0;
  const harness = await createEngineHarness();
  const issueId = "retry-authority", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId);
  try {
    await startIssueWorkflow(harness.config, workflowInput(issueId));
    const row = harness.database.authQuery((db) => db.prepare("SELECT p.last_run_id AS runId, s.state_json AS stateJson FROM forge_issue_projections p JOIN forge_workflow_snapshots s ON s.task_id = p.task_id AND s.revision = p.revision WHERE p.workflow_id = ?").get(workflowId) as { runId: string; stateJson: string });
    const state = IssueWorkflowStateSchema.parse(JSON.parse(row.stateJson));
    const authority: IssueProjectionEvent = { schemaVersion: 1, runId: row.runId, eventId: state.lastEventId, state };
    const caller = createActivityCaller(harness.database, { retryingEffect() { effects += 1; firstAttempt.resolve(undefined); throw new Error("retry after backoff"); } }, async () => releaseBackoff.promise);
    const operation = caller.call("retryingEffect", [], { retry: { maximumAttempts: 2, initialInterval: 1 } }, new AbortController().signal, workflowId, () => harness.database.observeIssueProjection(authority));
    await firstAttempt.promise;
    const superseding = IssueWorkflowStateSchema.parse({ ...state, revision: 1, phase: "cancelled", owner: "human", allowedCommands: [], pendingAction: "Superseded during retry backoff", lastEventId: `${workflowId}:1` });
    harness.database.projectIssueEvent({ schemaVersion: 1, runId: row.runId, eventId: superseding.lastEventId, state: superseding });
    releaseBackoff.resolve(undefined);

    await expect(operation).rejects.toMatchObject({ code: "not-durable" });
    expect(effects).toBe(1);
  } finally {
    releaseBackoff.resolve(undefined);
    await harness.stop();
  }
});

test("activity timeout aborts the activity signal and clears its ledger row", async () => {
  const harness = await createEngineHarness(); let aborted = false;
  try {
    const caller = createActivityCaller(harness.database, { hanging: async () => new Promise<void>((_resolve, reject) => { const signal = activityContext.current().signal; signal.addEventListener("abort", () => { aborted = true; reject(new CancelledFailure()); }, { once: true }); }) });
    await expect(caller.call("hanging", [], { startToCloseTimeout: 5 }, new AbortController().signal, "workflow")).rejects.toBeInstanceOf(CancelledFailure);
    expect(aborted).toBe(true);
    expect(harness.database.authQuery((db) => (db.prepare("SELECT count(*) count FROM forge_engine_activities").get() as { count: number }).count)).toBe(0);
  } finally { await harness.stop(); }
});

test("IssueEngine loads an unstarted run from its snapshot", async () => {
  const harness = await createEngineHarness({ projectIssueState: async (event) => event.state });
  try {
    const issueId = "lazy-run"; const workflowId = harness.workflowId(issueId); harness.seedTask(issueId, { autoApprovePlan: true });
    const now = new Date(harness.clock.now()).toISOString();
    harness.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('lazy-planner-agent', 'internal', 'Lazy Planner', 'planner', 'lazy-planner', 'profile', ?, ?)").run(now, now);
      db.prepare("UPDATE forge_tasks SET role_agents_json = ? WHERE id = ?").run(JSON.stringify({ planner: "lazy-planner-agent" }), issueId);
      db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES ('lazy-run-created', ?, 'task_created', ?, ?, ?)").run(engineFixture.actorUserId, engineFixture.companyId, JSON.stringify({ taskId: issueId }), now);
    });
    const state = buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, autoApprovePlan: false, pullRequestMode: "ready", deliveryTarget: "pull_request_ready", runProjectTests: false });
    harness.database.authQuery((db) => db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run(issueId, engineFixture.companyId, workflowId, JSON.stringify(state), new Date(harness.clock.now()).toISOString()));

    const run = harness.engine.run(workflowId);
    expect(run.state.issueId).toBe(issueId);
    expect(run.input.roleProfiles.planner).toBe("profile");
    expect(run.input.autoApprovePlanActorUserId).toBe(engineFixture.actorUserId);
    expect(harness.engine.run(workflowId)).toBe(run);

    const inactiveIssueId = "lazy-run-no-auto-approve"; const inactiveWorkflowId = harness.workflowId(inactiveIssueId); harness.seedTask(inactiveIssueId);
    harness.database.authQuery((db) => {
      db.prepare("UPDATE forge_tasks SET role_agents_json = ? WHERE id = ?").run(JSON.stringify({ planner: "lazy-planner-agent" }), inactiveIssueId);
      db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES ('lazy-run-no-auto-approve-created', ?, 'task_created', ?, ?, ?)").run(engineFixture.actorUserId, engineFixture.companyId, JSON.stringify({ taskId: inactiveIssueId }), now);
    });
    const inactiveState = buildInitialIssueWorkflowState({ workflowId: inactiveWorkflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: inactiveIssueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, autoApprovePlan: false, pullRequestMode: "ready", deliveryTarget: "pull_request_ready", runProjectTests: false });
    harness.database.authQuery((db) => db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run(inactiveIssueId, engineFixture.companyId, inactiveWorkflowId, JSON.stringify(inactiveState), now));
    expect(harness.engine.run(inactiveWorkflowId).input.autoApprovePlanActorUserId).toBeUndefined();
  } finally { await harness.stop(); }
});


test("IssueEngine rejects a high-revision snapshot without exact projection authority", async () => {
  const harness = await createEngineHarness();
  const issueId = "unbacked-high-revision";
  const workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId);
  try {
    const initial = buildInitialIssueWorkflowState({ workflowId, ...workflowInput(issueId) });
    const unbacked = IssueWorkflowStateSchema.parse({ ...initial, revision: 3, phase: "planning", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Unbacked continuation", lastEventId: `${workflowId}:3` });
    harness.database.authQuery((db) => db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(issueId, engineFixture.companyId, workflowId, unbacked.revision, JSON.stringify(unbacked), new Date(harness.clock.now()).toISOString()));

    expect(() => harness.engine.run(workflowId)).toThrow("no exact persisted projection authority");
    expect(harness.database.authQuery((db) => (db.prepare("SELECT count(*) AS count FROM forge_issue_projections WHERE workflow_id = ?").get(workflowId) as { count: number }).count)).toBe(0);
  } finally {
    await harness.stop();
  }
});
test("issue cancellation interrupts held planning and late completion cannot resurrect it", async () => {
  const planning = deferred<LeadPlanningResult>();
  const planningStarted = deferred<void>();
  const planningAborted = deferred<void>();
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    runLeadPlanning: async () => {
      const signal = activityContext.current().signal;
      signal.addEventListener("abort", () => {
        planningAborted.resolve(undefined);
        planning.reject(new CancelledFailure());
      }, { once: true });
      planningStarted.resolve(undefined);
      return planning.promise;
    },
  });
  const issueId = "interrupt-planning";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    const planningCommand = executeIssueCommand(harness.config, started.workflowId, "start_planning", {
      expectedRevision: 0,
      actorUserId: engineFixture.actorUserId,
      commandId: "start-held-planning",
    });
    const planningRejected = planningCommand.then(
      () => { throw new Error("Held planning unexpectedly completed"); },
      (error) => { expect(error).toBeInstanceOf(CancelledFailure); },
    );
    await planningStarted.promise;
    const active = await queryIssueWorkflow(harness.config, started.workflowId);
    expect(active.phase).toBe("planning");

    const command = { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-held-planning" };
    const cancelled = await executeIssueCommand(harness.config, started.workflowId, "cancel_issue", command);
    await planningAborted.promise;
    await planningRejected;
    expect(cancelled).toMatchObject({ phase: "cancelled", activeOperation: null, pendingAction: "Issue cancelled" });

    planning.resolve(leadPlan(started.workflowId, issueId));
    await Promise.resolve();
    expect(await queryIssueWorkflow(harness.config, started.workflowId)).toMatchObject({ phase: "cancelled", revision: cancelled.revision });
    expect(await executeIssueCommand(harness.config, started.workflowId, "cancel_issue", command)).toEqual(cancelled);
    expect(commandReceiptCount(harness, command.commandId)).toBe(1);
  } finally {
    await harness.stop();
  }
});

test("Developer progress is durable before the held effect and terminal receipt rollback preserves it", async () => {
  const developer = deferred<void>();
  const developerStarted = deferred<void>();
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    runDeveloperExecutionSupervised: async () => {
      developerStarted.resolve(undefined);
      await developer.promise;
      return { status: "failed", developerExecutionId: "developer-held-exact", reasonCode: "injected", summary: "Developer failed", evidenceArtifactId: null };
    },
  });
  const issueId = "durable-held-development";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    const run = harness.engine.run(started.workflowId);
    await run.ready();
    let liveState = run.state;
    run.queries.set("issueState", (() => liveState) as never);
    const commandId = "held-development-atomic-receipt";
    const progress = IssueWorkflowStateSchema.parse({ ...run.state, revision: 1, phase: "development", owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "Developer execution", lastEventId: `${started.workflowId}:1`, developerExecutionId: "developer-held-exact", developerAttempt: 1, developerTurnKind: "implementation", developerRecoveryStatus: "starting", activeOperation: { commandId, kind: "development", startedRevision: 1 } });
    const terminal = IssueWorkflowStateSchema.parse({ ...progress, revision: 2, phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer failed", lastEventId: `${started.workflowId}:2`, developerRecoveryStatus: "failed", activeOperation: null });
    run.commands.set("heldDeveloperCommand", (async () => {
      liveState = progress;
      const context = runExecution.current();
      await context.activity("projectIssueState", [{ schemaVersion: 1, runId: run.runId, eventId: progress.lastEventId, state: progress }], { startToCloseTimeout: "1 minute" });
      await context.activity("runDeveloperExecutionSupervised", [], { startToCloseTimeout: "1 minute" });
      liveState = terminal;
      await context.activity("projectIssueState", [{ schemaVersion: 1, runId: run.runId, eventId: terminal.lastEventId, state: terminal }], { startToCloseTimeout: "1 minute" });
      return terminal;
    }) as never);

    const pending = run.execute("heldDeveloperCommand", {}, commandId);
    await developerStarted.promise;
    const durableProgress = harness.database.authQuery((db) => ({
      projection: db.prepare("SELECT * FROM forge_issue_projections WHERE task_id = ?").get(issueId),
      timeline: db.prepare("SELECT * FROM forge_issue_timeline WHERE task_id = ? ORDER BY stream_id").all(issueId),
      snapshots: db.prepare("SELECT * FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision").all(issueId),
    }));
    expect(durableProgress.projection).toMatchObject({ phase: "development", revision: 1, authoritative_revision: 1, last_event_id: progress.lastEventId });
    expect(IssueWorkflowStateSchema.parse(JSON.parse((durableProgress.snapshots as Array<{ revision: number; state_json: string }>).at(-1)!.state_json))).toMatchObject({ developerExecutionId: "developer-held-exact", activeOperation: { commandId, kind: "development", startedRevision: 1 } });
    expect(await queryIssueWorkflow(harness.config, started.workflowId)).toEqual(progress);
    expect(commandReceiptCount(harness, commandId)).toBe(0);

    harness.database.authQuery((db) => db.exec(`CREATE TRIGGER fail_held_developer_receipt
      BEFORE INSERT ON forge_engine_commands
      WHEN NEW.command_id = '${commandId}'
      BEGIN SELECT RAISE(ABORT, 'injected terminal receipt failure'); END`));
    developer.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: "write-failed" });
    expect(harness.database.authQuery((db) => ({
      projection: db.prepare("SELECT * FROM forge_issue_projections WHERE task_id = ?").get(issueId),
      timeline: db.prepare("SELECT * FROM forge_issue_timeline WHERE task_id = ? ORDER BY stream_id").all(issueId),
      snapshots: db.prepare("SELECT * FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision").all(issueId),
    }))).toEqual(durableProgress);
    expect(commandReceiptCount(harness, commandId)).toBe(0);
    expect(harness.engine.runs.has(started.workflowId)).toBe(false);
    expect(harness.engine.run(started.workflowId).state).toMatchObject({
      phase: "delivery_blocked",
      revision: 2,
      activeOperation: null,
      developerExecutionId: "developer-held-exact",
      developerRecoveryStatus: "interrupted",
      developerRecoveryReasonCode: "execution_not_live",
      pendingAction: "Developer execution was interrupted — retry is available",
    });
  } finally {
    developer.resolve(undefined);
    await harness.stop();
  }
});

test("worker restart makes an orphaned autonomous CI repair actionable", async () => {
  const harness = await createEngineHarness({ projectIssueState: async (event) => event.state });
  const issueId = "orphaned-autonomous-ci-repair", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId);
  const continuation = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    phase: "ci_repair_planning", revision: 1, owner: "lead", allowedCommands: [], pendingAction: "Looking into the CI failure", lastEventId: `${workflowId}:1`, activeOperation: null,
  });
  try {
    persistContinuation(harness, issueId, continuation);
    await startIssueWorkflow(harness.config, workflowInput(issueId, continuation));
    expect(await queryIssueWorkflow(harness.config, workflowId)).toMatchObject({
      phase: "ci_repair_required",
      owner: "human",
      allowedCommands: ["repair_ci", "reconcile_ci", "cancel_issue"],
      activeOperation: null,
      pendingAction: "CI repair was interrupted — retry is available",
    });
  } finally {
    await harness.stop();
  }
});

test("worker restart does not load an archived task", async () => {
  const harness = await createEngineHarness({ projectIssueState: async (event) => event.state });
  const issueId = "archived-run-is-not-loaded";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    await harness.engine.run(started.workflowId).ready();
    harness.database.authQuery((db) => db.prepare("UPDATE forge_tasks SET archived_at = ? WHERE id = ?").run("2026-08-31T00:00:00.000Z", issueId));

    await harness.restart();

    expect(harness.engine.runs.has(started.workflowId)).toBe(false);
  } finally {
    await harness.stop();
  }
});

test("durable projection replay failures do not falsify command success", async () => {
  let replayFailures = 0;
  const harness = await createEngineHarness({
    projectIssueState: async (event) => {
      if (event.state.revision === 0) return event.state;
      replayFailures += 1;
      throw new Error("injected durable projection replay failure");
    },
    runLeadPlanning: async (input) => leadPlan(input.workflowId, input.taskId),
  });
  const issueId = "best-effort-projection-replay";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    const command = { expectedRevision: 0, actorUserId: engineFixture.actorUserId, commandId: "best-effort-projection-replay" };
    const result = await executeIssueCommand(harness.config, started.workflowId, "start_planning", command);
    expect(result).toMatchObject({ phase: "approval" });
    expect(replayFailures).toBeGreaterThanOrEqual(2);
    expect(commandReceiptCount(harness, command.commandId)).toBe(1);
    expect(harness.database.authQuery((db) => db.prepare("SELECT phase, revision, authoritative_revision FROM forge_issue_projections WHERE workflow_id = ?").get(started.workflowId))).toEqual({ phase: "approval", revision: result.revision, authoritative_revision: result.revision });
  } finally {
    await harness.stop();
  }
});

test("superseded terminal commit evicts the stale run and reloads durable authority", async () => {
  const effect = deferred<void>();
  const effectStarted = deferred<void>();
  const harness = await createEngineHarness({
    projectIssueState: async (event: IssueProjectionEvent) => event.state,
    heldEffect: async () => {
      effectStarted.resolve(undefined);
      await effect.promise;
    },
  } as never);
  const issueId = "superseded-held-command";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    const run = harness.engine.run(started.workflowId);
    await run.ready();
    let liveState = run.state;
    run.queries.set("issueState", (() => liveState) as never);
    const commandId = "superseded-held-command";
    const progress = IssueWorkflowStateSchema.parse({ ...run.state, revision: 1, phase: "development", owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "Held external effect", lastEventId: `${started.workflowId}:1`, activeOperation: { commandId, kind: "development", startedRevision: 1 } });
    const staleResult = IssueWorkflowStateSchema.parse({ ...progress, revision: 2, phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Stale handler result", lastEventId: `${started.workflowId}:2`, activeOperation: null });
    run.commands.set("supersededHeldCommand", (async () => {
      liveState = progress;
      const context = runExecution.current();
      await context.activity("projectIssueState", [{ schemaVersion: 1, runId: run.runId, eventId: progress.lastEventId, state: progress }], { startToCloseTimeout: "1 minute" });
      await context.activity("heldEffect", [], { startToCloseTimeout: "1 minute" });
      liveState = staleResult;
      return staleResult;
    }) as never);
    const pending = run.execute("supersededHeldCommand", {}, commandId);
    await effectStarted.promise;
    expect(await queryIssueWorkflow(harness.config, started.workflowId)).toEqual(progress);

    const externalProgress = IssueWorkflowStateSchema.parse({ ...progress, revision: 2, phase: "delivery_blocked", owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "External progress", lastEventId: `${started.workflowId}:2`, activeOperation: null });
    const superseding = IssueWorkflowStateSchema.parse({ ...externalProgress, revision: 3, phase: "cancelled", owner: "human", allowedCommands: [], pendingAction: "Externally superseded", lastEventId: `${started.workflowId}:3` });
    harness.database.projectIssueEvent({ schemaVersion: 1, runId: run.runId, eventId: externalProgress.lastEventId, state: externalProgress });
    harness.database.projectIssueEvent({ schemaVersion: 1, runId: run.runId, eventId: superseding.lastEventId, state: superseding });
    const durableAuthority = harness.database.authQuery((db) => ({
      projection: db.prepare("SELECT * FROM forge_issue_projections WHERE task_id = ?").get(issueId),
      timeline: db.prepare("SELECT * FROM forge_issue_timeline WHERE task_id = ? ORDER BY stream_id").all(issueId),
      snapshots: db.prepare("SELECT * FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision").all(issueId),
    }));
    effect.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: "not-durable" });
    expect(commandReceiptCount(harness, commandId)).toBe(0);
    expect(harness.database.authQuery((db) => ({
      projection: db.prepare("SELECT * FROM forge_issue_projections WHERE task_id = ?").get(issueId),
      timeline: db.prepare("SELECT * FROM forge_issue_timeline WHERE task_id = ? ORDER BY stream_id").all(issueId),
      snapshots: db.prepare("SELECT * FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision").all(issueId),
    }))).toEqual(durableAuthority);
    expect(harness.engine.runs.has(started.workflowId)).toBe(false);
    const reloaded = harness.engine.run(started.workflowId);
    expect(reloaded).not.toBe(run);
    expect(reloaded.state).toMatchObject({ phase: "cancelled", revision: 4, pendingAction: "Externally superseded", activeOperation: null });
  } finally {
    effect.resolve(undefined);
    await harness.stop();
  }
});

test("production auto-start fences supersession before the Developer activity", async () => {
  let activityInvocations = 0, interposed = false, autoCommandId = "", supersedingRevision = -1;
  let originalRun: IssueRun | undefined;
  let harness!: EngineHarness;
  harness = await createEngineHarness({
    projectIssueState: async (event) => {
      if (!interposed && event.state.phase === "development" && event.state.activeOperation) {
        interposed = true;
        autoCommandId = event.state.activeOperation.commandId;
        supersedingRevision = event.state.revision + 1;
        originalRun = harness.engine.runs.get(event.state.workflowId);
        const superseding = IssueWorkflowStateSchema.parse({ ...event.state, revision: supersedingRevision, phase: "cancelled", owner: "human", allowedCommands: [], pendingAction: "Cancelled before Developer dispatch", lastEventId: `${event.state.workflowId}:${supersedingRevision}`, activeOperation: null });
        harness.database.projectIssueEvent({ schemaVersion: 1, runId: event.runId, eventId: superseding.lastEventId, state: superseding });
      }
      return event.state;
    },
    runDeveloperExecutionSupervised: async (input) => {
      activityInvocations += 1;
      return { status: "failed", developerExecutionId: input.developerTurnExecutionId, reasonCode: "unexpected-invocation", summary: "Developer should not have started", evidenceArtifactId: null };
    },
  });
  const issueId = "production-pre-effect-authority", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId);
  const ready = {
    phase: "ready_for_development" as const,
    revision: 1,
    owner: "lead" as const,
    allowedCommands: ["start_development" as const, "cancel_issue" as const],
    pendingAction: "Start development",
    lastEventId: `${workflowId}:1`,
    continuationCount: 0,
    lastSummaryHash: null,
    blocker: null,
    stateChangedAt: "2026-08-29T00:00:00.000Z",
    planRevision: 1,
    planMaterial: true,
    planApproved: true,
    leadSessionRef: "lead-session",
    leadOutputArtifactId: "plan-artifact",
  };
  try {
    persistContinuation(harness, issueId, ready);
    await startIssueWorkflow(harness.config, workflowInput(issueId, ready));
    harness.engine.run(workflowId).wakeable.wake();
    for (let attempt = 0; attempt < 2_000 && harness.engine.runs.has(workflowId); attempt += 1) await Promise.resolve();
    expect(interposed).toBe(true);
    expect(activityInvocations).toBe(0);
    expect(originalRun?.error).toMatchObject({ code: "not-durable" });
    expect(commandReceiptCount(harness, autoCommandId)).toBe(0);
    expect(harness.engine.runs.has(workflowId)).toBe(false);
    expect(harness.database.authQuery((db) => db.prepare("SELECT phase, revision FROM forge_issue_projections WHERE workflow_id = ?").get(workflowId))).toEqual({ phase: "cancelled", revision: supersedingRevision });
    const reloaded = harness.engine.run(workflowId);
    expect(reloaded).not.toBe(originalRun);
    expect(reloaded.state).toMatchObject({ phase: "cancelled", revision: supersedingRevision + 1, pendingAction: "Cancelled before Developer dispatch", activeOperation: null });
  } finally {
    await harness.stop();
  }
});

test("cancelling a held production Developer turn prevents late resurrection", async () => {
  const developerStarted = deferred<void>(), releaseDeveloper = deferred<void>();
  let developerCalls = 0;
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    runDeveloperExecutionSupervised: async (input) => {
      developerCalls += 1;
      developerStarted.resolve(undefined);
      const signal = activityContext.current().signal;
      await Promise.race([
        releaseDeveloper.promise,
        new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new CancelledFailure()), { once: true })),
      ]);
      return { status: "completed", resultHash: engineFixture.sha256, result: { developerExecutionId: input.developerTurnExecutionId, developerSessionRef: "developer-session", branchName: "forge/issue/cancel-held-developer", targetBaseSha: engineFixture.base, currentStep: null, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, dirtyState: "clean", deliveryArtifactId: "delivery", evidenceArtifactId: "developer-evidence", deliverySummary: "Late completion", outcome: "completed" } };
    },
    cancelDeveloperExecution: async (input) => ({ status: "cancelled_confirmed", executionId: input.executionId, exitCode: null, exitSignal: null, evidenceArtifactId: null }),
  });
  const issueId = "cancel-held-developer", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId);
  const ready = { phase: "ready_for_development" as const, revision: 1, owner: "lead" as const, allowedCommands: ["start_development" as const, "cancel_issue" as const], pendingAction: "Start development", lastEventId: `${workflowId}:1`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: "2026-08-29T00:00:00.000Z", planRevision: 1, planMaterial: true, planApproved: true, leadSessionRef: "lead-session", leadOutputArtifactId: "plan-artifact" };
  try {
    persistContinuation(harness, issueId, ready);
    await startIssueWorkflow(harness.config, workflowInput(issueId, ready));
    harness.engine.run(workflowId).wakeable.wake();
    await developerStarted.promise;
    const active = await queryIssueWorkflow(harness.config, workflowId);
    expect(active.phase).toBe("development");
    const cancelled = await executeIssueCommand(harness.config, workflowId, "cancel_issue", { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-held-developer" });
    expect(cancelled.phase).toBe("cancelled");
    releaseDeveloper.resolve(undefined);
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
    expect(await queryIssueWorkflow(harness.config, workflowId)).toMatchObject({ phase: "cancelled", revision: cancelled.revision });
    const settledRun = harness.engine.run(workflowId);
    expect(settledRun.error).toBeUndefined();
    expect(settledRun.state.allowedCommands).not.toContain("start_development");
    expect(developerCalls).toBe(1);
  } finally {
    releaseDeveloper.resolve(undefined);
    await harness.stop();
  }
});

test("cancelling explicit repair delivery preserves a complete receipt chain", async () => {
  const repairStarted = deferred<void>(), releaseRepair = deferred<void>();
  let repairCalls = 0;
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    runDeveloperRepairSupervised: async (input) => {
      repairCalls += 1;
      repairStarted.resolve(undefined);
      const signal = activityContext.current().signal;
      await Promise.race([
        releaseRepair.promise,
        new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new CancelledFailure()), { once: true })),
      ]);
      return { status: "failed", developerExecutionId: input.developerTurnExecutionId, reasonCode: "late-repair", summary: "Late repair", evidenceArtifactId: null };
    },
    cancelDeveloperExecution: async (input) => ({ status: "cancelled_confirmed", executionId: input.executionId, exitCode: null, exitSignal: null, evidenceArtifactId: null }),
  });
  const issueId = "cancel-held-repair", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId);
  const continuation = IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }), phase: "repair_required", revision: 1, owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Repair delivery", lastEventId: `${workflowId}:1`, planRevision: 1, leadSessionRef: "lead-session", developerExecutionId: "developer-original", developerSessionRef: "developer-session", branchName: "forge/issue/cancel-held-repair", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "developer-evidence", deliveryReviewId: "review", deliveryBlockingFindings: [{ findingId: "blocking-1", severity: "blocking", rationale: "Fix it", evidenceRef: "review", disposition: "open", repairInstruction: "Repair" }] });
  try {
    persistContinuation(harness, issueId, continuation);
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId, continuation));
    const current = await queryIssueWorkflow(harness.config, workflowId);
    const repair = executeIssueCommand(harness.config, workflowId, "repair_delivery", { expectedRevision: current.revision, actorUserId: engineFixture.actorUserId, commandId: "repair-held" });
    await repairStarted.promise;
    const active = await queryIssueWorkflow(harness.config, workflowId);
    const cancelled = await executeIssueCommand(harness.config, workflowId, "cancel_issue", { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-held-repair" });
    await expect(repair).rejects.toBeInstanceOf(CancelledFailure);
    expect(cancelled.phase).toBe("cancelled");
    releaseRepair.resolve(undefined);
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
    expect(await queryIssueWorkflow(harness.config, workflowId)).toMatchObject({ phase: "cancelled", revision: cancelled.revision });
    expect(harness.engine.run(workflowId).error).toBeUndefined();
    expect(commandReceiptCount(harness, "repair-held")).toBe(0);
    expect(commandReceiptCount(harness, "cancel-held-repair")).toBe(1);
    expect(repairCalls).toBe(1);
    void started;
  } finally {
    releaseRepair.resolve(undefined);
    await harness.stop();
  }
});

test("reviewed delivery authority is durable before remote branch push", async () => {
  const pushStarted = deferred<void>(), releasePush = deferred<void>();
  const reviewedCommit = "e".repeat(40), reviewedTree = "f".repeat(40);
  let pushCalls = 0;
  let pushedAuthority: IssueWorkflowState | undefined;
  let harness!: EngineHarness;
  harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    reviewDelivery: async (input) => ({ outcome: "completed", attemptId: "held-review-attempt", correctionAttempts: 0, subject: { ...input.subject, subjectCommit: reviewedCommit, subjectTree: reviewedTree }, review: { reviewId: "held-review", leadExecutionId: "lead-review", leadSessionRef: "lead-session", opinionArtifactId: "review-opinion", evidenceArtifactId: "review-evidence", opinion: "approved", summary: "Approved exact delivery", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" } } }),
    pushDeliveryBranch: async (input) => {
      pushCalls += 1;
      const row = harness.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1").get(input.workflowId) as { state_json: string });
      pushedAuthority = IssueWorkflowStateSchema.parse(JSON.parse(row.state_json));
      pushStarted.resolve(undefined);
      await releasePush.promise;
      return { repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha };
    },
  });
  const issueId = "held-reviewed-push", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId, { deliveryTarget: "remote_branch" });
  const continuation = IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }), phase: "delivery_ready", revision: 1, owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Review delivery", lastEventId: `${workflowId}:1`, planRevision: 1, leadSessionRef: "lead-session", leadOutputArtifactId: "plan-artifact", developerExecutionId: "developer", developerSessionRef: "developer-session", branchName: "forge/issue/held-reviewed-push", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery-artifact", developerEvidenceArtifactId: "developer-evidence" });
  try {
    persistContinuation(harness, issueId, continuation);
    await startIssueWorkflow(harness.config, { ...workflowInput(issueId, continuation), deliveryTarget: "remote_branch" });
    harness.engine.run(workflowId).wakeable.wake();
    await pushStarted.promise;
    expect(pushCalls).toBe(1);
    expect(pushedAuthority).toMatchObject({ phase: "delivery_reviewed", deliveryReviewId: "held-review", deliveryReviewOutcome: "approved", resultCommit: reviewedCommit, resultTree: reviewedTree, pendingAction: "Opening the pull request" });
    expect(harness.database.authQuery((db) => db.prepare("SELECT phase, revision, authoritative_revision FROM forge_issue_projections WHERE workflow_id = ?").get(workflowId))).toEqual({ phase: "delivery_reviewed", revision: pushedAuthority!.revision, authoritative_revision: pushedAuthority!.revision });
    releasePush.resolve(undefined);
    await expect(harness.settle(workflowId, (state) => state.phase === "done")).resolves.toMatchObject({ phase: "done", pendingAction: "Done — branch pushed", resultCommit: reviewedCommit });
  } finally {
    releasePush.resolve(undefined);
    await harness.stop();
  }
});

test("cancelling a held production review prevents late review resurrection", async () => {
  const reviewStarted = deferred<void>(), releaseReview = deferred<void>();
  let reviewCalls = 0, pushCalls = 0, reviewAborted = false;
  const reviewedCommit = "e".repeat(40), reviewedTree = "f".repeat(40);
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    reviewDelivery: async (input) => {
      reviewCalls += 1;
      const signal = activityContext.current().signal;
      const cancelled = new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { reviewAborted = true; reject(new CancelledFailure()); }, { once: true }));
      reviewStarted.resolve(undefined);
      await Promise.race([releaseReview.promise, cancelled]);
      return { outcome: "completed", attemptId: "cancelled-review-attempt", correctionAttempts: 0, subject: { ...input.subject, subjectCommit: reviewedCommit, subjectTree: reviewedTree }, review: { reviewId: "late-review", leadExecutionId: "lead-review", leadSessionRef: "lead-session", opinionArtifactId: "review-opinion", evidenceArtifactId: "review-evidence", opinion: "approved", summary: "Late review", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" } } };
    },
    pushDeliveryBranch: async (input) => { pushCalls += 1; return { repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }; },
  });
  const issueId = "cancel-held-review", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId, { deliveryTarget: "remote_branch" });
  const continuation = IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }), phase: "delivery_ready", revision: 1, owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Review delivery", lastEventId: `${workflowId}:1`, planRevision: 1, leadSessionRef: "lead-session", leadOutputArtifactId: "plan-artifact", developerExecutionId: "developer", developerSessionRef: "developer-session", branchName: "forge/issue/cancel-held-review", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery-artifact", developerEvidenceArtifactId: "developer-evidence" });
  try {
    persistContinuation(harness, issueId, continuation);
    await startIssueWorkflow(harness.config, { ...workflowInput(issueId, continuation), deliveryTarget: "remote_branch" });
    harness.engine.run(workflowId).wakeable.wake();
    await reviewStarted.promise;
    const active = await queryIssueWorkflow(harness.config, workflowId);
    expect(active.phase).toBe("reviewing_delivery");
    const cancelled = await executeIssueCommand(harness.config, workflowId, "cancel_issue", { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-held-review" });
    expect(cancelled.phase).toBe("cancelled");
    expect(reviewAborted).toBe(true);
    releaseReview.resolve(undefined);
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
    expect(await queryIssueWorkflow(harness.config, workflowId)).toMatchObject({ phase: "cancelled", revision: cancelled.revision });
    const settledRun = harness.engine.run(workflowId);
    expect(settledRun.error).toBeUndefined();
    expect(settledRun.state.allowedCommands).not.toContain("review_delivery");
    expect(reviewCalls).toBe(1);
    expect(pushCalls).toBe(0);
  } finally {
    releaseReview.resolve(undefined);
    await harness.stop();
  }
});

test("target-base no-drift authority is durable before acceptance activity", async () => {
  const acceptanceStarted = deferred<void>(), releaseAcceptance = deferred<void>();
  let acceptanceAuthority: IssueWorkflowState | undefined;
  let harness!: EngineHarness;
  harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    reconcileTargetBase: async (input) => ({ outcome: "no_drift", checkId: `base-${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree }),
    acceptDelivery: async (input) => {
      const row = harness.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1").get(input.workflowId) as { state_json: string });
      acceptanceAuthority = IssueWorkflowStateSchema.parse(JSON.parse(row.state_json));
      acceptanceStarted.resolve(undefined);
      await releaseAcceptance.promise;
      throw ApplicationFailure.nonRetryable("Injected acceptance stop", "injected-acceptance-stop");
    },
  });
  const issueId = "held-acceptance-authority", workflowId = harness.workflowId(issueId);
  harness.seedTask(issueId, { deliveryTarget: "merged" });
  const continuation = IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }), phase: "accepted", revision: 1, owner: "human", allowedCommands: ["accept_delivery", "request_delivery_changes", "cancel_issue"], pendingAction: "Member acceptance required", lastEventId: `${workflowId}:1`, planRevision: 1, leadSessionRef: "lead-session", developerExecutionId: "developer", developerSessionRef: "developer-session", branchName: "forge/issue/held-acceptance", baseBranch: "main", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "developer-evidence", deliveryReviewId: "delivery-review", finalReviewId: "final-review", finalReviewOutcome: "approved", releaseId: "release", releaseRepository: "acme/forge", pullRequestNumber: 42, pullRequestUrl: "https://github.test/42", expectedHeadSha: engineFixture.commit, expectedHeadTree: engineFixture.tree, ciRunId: "ci-run" });
  try {
    persistContinuation(harness, issueId, continuation);
    const started = await startIssueWorkflow(harness.config, { ...workflowInput(issueId, continuation), pullRequestMode: "auto_merge", deliveryTarget: "merged" });
    const current = await queryIssueWorkflow(harness.config, started.workflowId);
    const command = { expectedRevision: current.revision, actorUserId: engineFixture.actorUserId, commandId: "held-acceptance" };
    const pending = executeIssueCommand(harness.config, started.workflowId, "accept_delivery", command);
    await acceptanceStarted.promise;
    expect(acceptanceAuthority).toMatchObject({ phase: "accepted", revision: current.revision + 1, targetBaseCheckId: "base-pre_acceptance", targetBaseCheckpoint: "pre_acceptance", targetBaseOutcome: "no_drift" });
    expect(harness.database.authQuery((db) => db.prepare("SELECT revision, event_hash, authoritative_revision, authoritative_event_hash FROM forge_issue_projections WHERE workflow_id = ?").get(workflowId))).toMatchObject({ revision: current.revision + 1, authoritative_revision: current.revision + 1, event_hash: expect.any(String), authoritative_event_hash: expect.any(String) });
    releaseAcceptance.resolve(undefined);
    await expect(pending).resolves.toMatchObject({ phase: "accepted", lastHandlerError: { command: "accept_delivery" } });
  } finally {
    releaseAcceptance.resolve(undefined);
    await harness.stop();
  }
});

test("development cancellation checks authority before interrupting held work", async () => {
  const held = deferred<void>();
  const heldStarted = deferred<void>();
  let cancellationCalls = 0, failCancellation = true;
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    runDeveloperExecutionSupervised: async () => {
      heldStarted.resolve(undefined);
      const signal = activityContext.current().signal;
      await Promise.race([
        held.promise,
        new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new CancelledFailure()), { once: true })),
      ]);
      return { status: "failed", developerExecutionId: "interrupt-execution", reasonCode: "cancelled", summary: "Cancelled", evidenceArtifactId: null };
    },
    cancelDeveloperExecution: async () => {
      cancellationCalls += 1;
      if (failCancellation) {
        failCancellation = false;
        throw new Error("Injected cancellation hook failure");
      }
      return { status: "cancelled_confirmed", executionId: "interrupt-execution", exitCode: null, exitSignal: null, evidenceArtifactId: null };
    },
  });
  const issueId = "interrupt-development";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    const run = harness.engine.run(started.workflowId);
    await run.ready();
    let liveState = run.state;
    run.queries.set("issueState", (() => liveState) as never);
    const activeCommandId = "active-held-development", cancelCommandId = "cancel-held-development", retryCancelCommandId = "cancel-held-development-retry";
    const progress = IssueWorkflowStateSchema.parse({ ...liveState, revision: 1, phase: "development", owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "Developer execution", lastEventId: `${started.workflowId}:1`, developerExecutionId: "interrupt-execution", developerRecoveryStatus: "starting", activeOperation: { commandId: activeCommandId, kind: "development", startedRevision: 1 } });
    const cancelled = IssueWorkflowStateSchema.parse({ ...progress, revision: 2, phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer turn cancelled", lastEventId: `${started.workflowId}:2`, developerRecoveryStatus: "cancelled", activeOperation: null });
    run.commands.set("activeHeldDevelopment", (async () => {
      liveState = progress;
      const context = runExecution.current();
      await context.activity("projectIssueState", [{ schemaVersion: 1, runId: run.runId, eventId: progress.lastEventId, state: progress }], { startToCloseTimeout: "1 minute" });
      await context.activity("runDeveloperExecutionSupervised", [], { startToCloseTimeout: "1 minute" });
      return progress;
    }) as never);
    run.interrupts.set("cancelHeldDevelopment", {
      cancelActive: true,
      validate: (() => true) as never,
      run: (async () => runExecution.current().activity("cancelDeveloperExecution", [], { startToCloseTimeout: "1 minute" })) as never,
    });
    run.commands.set("cancelHeldDevelopment", (async () => {
      liveState = cancelled;
      const context = runExecution.current();
      await context.activity("projectIssueState", [{ schemaVersion: 1, runId: run.runId, eventId: cancelled.lastEventId, state: cancelled }], { startToCloseTimeout: "1 minute" });
      return cancelled;
    }) as never);

    const active = run.execute("activeHeldDevelopment", {}, activeCommandId);
    await heldStarted.promise;
    const failedCancellation = run.execute("cancelHeldDevelopment", {}, cancelCommandId);
    await expect(active).rejects.toBeInstanceOf(CancelledFailure);
    await expect(failedCancellation).rejects.toMatchObject({ cause: { message: "Injected cancellation hook failure" } });
    await expect(run.execute("cancelHeldDevelopment", {}, retryCancelCommandId)).resolves.toEqual(cancelled);
    expect(cancellationCalls).toBe(2);
    expect(commandReceiptCount(harness, activeCommandId)).toBe(0);
    expect(commandReceiptCount(harness, cancelCommandId)).toBe(0);
    expect(commandReceiptCount(harness, retryCancelCommandId)).toBe(1);
    expect(harness.database.authQuery((db) => db.prepare("SELECT phase, revision FROM forge_issue_projections WHERE workflow_id = ?").get(started.workflowId))).toEqual({ phase: "delivery_blocked", revision: 2 });
    await expect(run.execute("cancelHeldDevelopment", {}, retryCancelCommandId)).resolves.toEqual(cancelled);
  } finally {
    held.resolve(undefined);
    await harness.stop();
  }
});

test("cancellation interrupts coalesce by target across command IDs and types", async () => {
  const releaseInterrupts = deferred<void>();
  const bothTargetsInterrupted = deferred<void>();
  const cancellationCalls: string[] = [];
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    cancelDeveloperExecution: async (input) => {
      cancellationCalls.push(input.executionId);
      if (cancellationCalls.length >= 2) bothTargetsInterrupted.resolve(undefined);
      await releaseInterrupts.promise;
      return { status: "cancelled_confirmed", executionId: input.executionId, exitCode: null, exitSignal: null, evidenceArtifactId: null };
    },
  });
  const activeInput = (issueId: string, executionId: string) => {
    const workflowId = harness.workflowId(issueId);
    return workflowInput(issueId, {
      ...buildInitialIssueWorkflowState({ workflowId, ...workflowInput(issueId) }),
      phase: "development" as const,
      revision: 3,
      owner: "lead" as const,
      allowedCommands: ["cancel_development" as const, "cancel_issue" as const],
      pendingAction: "Developer execution",
      lastEventId: `${workflowId}:3`,
      planRevision: 1,
      planMaterial: true,
      planApproved: true,
      developerExecutionId: executionId,
      developerAttempt: 1,
      developerRecoveryStatus: "active" as const,
    });
  };
  const firstIssueId = "interrupt-target-a";
  const secondIssueId = "interrupt-target-b";
  harness.seedTask(firstIssueId);
  harness.seedTask(secondIssueId);
  try {
    const firstInput = activeInput(firstIssueId, "developer-target-a"), secondInput = activeInput(secondIssueId, "developer-target-b");
    persistContinuation(harness, firstIssueId, firstInput.continuationState!);
    persistContinuation(harness, secondIssueId, secondInput.continuationState!);
    const firstRun = await startIssueWorkflow(harness.config, firstInput);
    const secondRun = await startIssueWorkflow(harness.config, secondInput);
    const firstActive = await queryIssueWorkflow(harness.config, firstRun.workflowId);
    const secondActive = await queryIssueWorkflow(harness.config, secondRun.workflowId);
    const firstCommand = { expectedRevision: firstActive.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-target-a-first" };
    const duplicateCommand = { ...firstCommand, commandId: "cancel-target-a-duplicate" };
    const issueCommand = { ...firstCommand, commandId: "cancel-target-a-issue" };
    const distinctCommand = { expectedRevision: secondActive.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-target-b" };

    const firstCancellation = executeIssueCommand(harness.config, firstRun.workflowId, "cancel_development", firstCommand);
    const duplicateCancellation = executeIssueCommand(harness.config, firstRun.workflowId, "cancel_development", duplicateCommand);
    const issueCancellation = executeIssueCommand(harness.config, firstRun.workflowId, "cancel_issue", issueCommand);
    const distinctCancellation = executeIssueCommand(harness.config, secondRun.workflowId, "cancel_development", distinctCommand);
    await bothTargetsInterrupted.promise;
    releaseInterrupts.resolve(undefined);
    const [firstResult, duplicateResult, issueResult, distinctResult] = await Promise.all([firstCancellation, duplicateCancellation, issueCancellation, distinctCancellation]);

    expect([...cancellationCalls].sort()).toEqual(["developer-target-a", "developer-target-b"]);
    expect(firstResult).toMatchObject({ phase: "delivery_blocked", developerRecoveryStatus: "cancelled" });
    expect(duplicateResult).toMatchObject({ phase: "delivery_blocked", developerRecoveryStatus: "cancelled", lastHandlerError: { reason: "Developer cancellation was superseded by another command" } });
    expect(duplicateResult.revision).toBeGreaterThan(firstResult.revision);
    expect(issueResult).toMatchObject({ phase: "cancelled" });
    expect(distinctResult).toMatchObject({ phase: "delivery_blocked", developerRecoveryStatus: "cancelled" });
    expect(await executeIssueCommand(harness.config, firstRun.workflowId, "cancel_development", firstCommand)).toEqual(firstResult);
    expect(await executeIssueCommand(harness.config, firstRun.workflowId, "cancel_development", duplicateCommand)).toEqual(duplicateResult);
    expect(await executeIssueCommand(harness.config, firstRun.workflowId, "cancel_issue", issueCommand)).toEqual(issueResult);
    expect(await executeIssueCommand(harness.config, secondRun.workflowId, "cancel_development", distinctCommand)).toEqual(distinctResult);
    expect(cancellationCalls).toHaveLength(2);
    for (const command of [firstCommand, duplicateCommand, issueCommand, distinctCommand]) expect(commandReceiptCount(harness, command.commandId)).toBe(1);
  } finally {
    releaseInterrupts.resolve(undefined);
    await harness.stop();
  }
});

test("concurrent duplicate planner notes interrupt once and mutate state only after the active turn", async () => {
  const planning = deferred<LeadPlanningResult>();
  const planningStarted = deferred<void>();
  const noteForwarded = deferred<void>();
  const projections: unknown[] = [];
  const harness = await createEngineHarness({
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    runLeadPlanning: async () => { planningStarted.resolve(undefined); return planning.promise; },
    recordPlannerNote: async (input) => {
      noteForwarded.resolve(undefined);
      return { noteId: `planner_note_${input.commandId}`, createdAt: "2026-08-29T00:00:00.000Z" };
    },
  });
  const issueId = "interrupt-note";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    const planningCommand = executeIssueCommand(harness.config, started.workflowId, "start_planning", {
      expectedRevision: 0,
      actorUserId: engineFixture.actorUserId,
      commandId: "start-held-note",
    });
    await planningStarted.promise;
    const active = structuredClone(await queryIssueWorkflow(harness.config, started.workflowId));
    const projectionCount = projections.length;
    const command = { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId, commandId: "duplicate-live-note", note: "Cover the cancellation race." };

    const first = executeIssueCommand(harness.config, started.workflowId, "send_planner_note", command);
    const second = executeIssueCommand(harness.config, started.workflowId, "send_planner_note", command);
    let notesSettled = false;
    const notes = Promise.all([first, second]).then((results) => { notesSettled = true; return results; });
    await noteForwarded.promise;
    expect(notesSettled).toBe(false);
    expect(harness.calls.get("recordPlannerNote")).toBe(1);
    expect(await queryIssueWorkflow(harness.config, started.workflowId)).toEqual(active);
    expect(projections).toHaveLength(projectionCount);

    planning.resolve(leadPlan(started.workflowId, issueId));
    const planned = await planningCommand;
    const [firstResult, secondResult] = await notes;
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toMatchObject({ phase: "approval", revision: planned.revision + 1, processedCommandIds: expect.arrayContaining([command.commandId]) });
    expect(harness.calls.get("recordPlannerNote")).toBe(1);
    expect(commandReceiptCount(harness, command.commandId)).toBe(1);
    await harness.restart();
    const durableAfterRestart = harness.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1").get(started.workflowId) as { state_json: string });
    expect(IssueWorkflowStateSchema.parse(JSON.parse(durableAfterRestart.state_json))).toMatchObject({ phase: firstResult.phase, revision: firstResult.revision + 1, processedCommandIds: expect.arrayContaining([command.commandId]) });
    expect(await executeIssueCommand(harness.config, started.workflowId, "send_planner_note", command)).toEqual(firstResult);
    expect(harness.calls.get("recordPlannerNote")).toBe(1);
  } finally {
    await harness.stop();
  }
});

test("concurrent duplicate commands recheck the durable receipt inside the serialized lane", async () => {
  let planningCalls = 0;
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    runLeadPlanning: async (input) => {
      planningCalls += 1;
      return leadPlan(input.workflowId, input.taskId);
    },
  });
  const issueId = "duplicate-serialized-command";
  harness.seedTask(issueId);
  try {
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId));
    const command = { expectedRevision: 0, actorUserId: engineFixture.actorUserId, commandId: "duplicate-start-planning" };
    const [first, second] = await Promise.all([
      executeIssueCommand(harness.config, started.workflowId, "start_planning", command),
      executeIssueCommand(harness.config, started.workflowId, "start_planning", command),
    ]);
    expect(first).toEqual(second);
    expect(first.phase).toBe("approval");
    expect(planningCalls).toBe(1);
    expect(commandReceiptCount(harness, command.commandId)).toBe(1);
    expect(() => harness.engine.run(started.workflowId).execute("cancelIssue", command, command.commandId)).toThrow("Issue command identity already belongs to another workflow or command");
  } finally {
    await harness.stop();
  }
});

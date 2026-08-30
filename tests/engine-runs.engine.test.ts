import { expect, test } from "vitest";
import { activityContext } from "../src/engine/activity-context.js";
import { createActivityCaller } from "../src/engine/activities.js";
import { ApplicationFailure, CancelledFailure } from "../src/engine/failures.js";
import { durableCommand, executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/engine/service.js";
import { buildInitialIssueWorkflowState, type DeveloperTurnActivityOutcome, type IssueWorkflowInput, type LeadPlanningResult, type WorkflowDeveloperExecutionResult } from "../src/engine/issue-contracts.js";
import { Wakeable } from "../src/engine/runs.js";
import { createEngineHarness, engineFixture, type EngineHarness } from "./helpers/engine-harness.js";

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

type DeveloperActivityResult = DeveloperTurnActivityOutcome<WorkflowDeveloperExecutionResult>;
function developerResult(executionId: string): DeveloperActivityResult {
  return {
    status: "completed",
    resultHash: engineFixture.sha256,
    result: {
      developerExecutionId: executionId,
      developerSessionRef: "developer-session",
      branchName: "forge/issue/interrupt-development",
      targetBaseSha: engineFixture.base,
      currentStep: null,
      resultCommit: engineFixture.commit,
      resultTree: engineFixture.tree,
      dirtyState: "clean",
      deliveryArtifactId: "delivery-artifact",
      evidenceArtifactId: "developer-evidence",
      deliverySummary: "Late completion",
      outcome: "completed",
    },
  };
}

test("durable command IDs are stable", () => {
  const input = { expectedRevision: 0, actorUserId: "member" };
  expect(durableCommand("workflow", "cancel", input).commandId).toBe(durableCommand("workflow", "cancel", input).commandId);
});

test("wake interrupts an engine wait", async () => {
  const wakeable = new Wakeable(); const controller = new AbortController(); let resolved = false;
  const waiting = wakeable.wait(60_000, controller.signal, { now: Date.now, wait: async (_ms, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new CancelledFailure()), { once: true })) }).then(() => { resolved = true; });
  wakeable.wake(); await waiting; expect(resolved).toBe(true);
});

test("activity retries honor attempts and non-retryable types", async () => {
  let attempts = 0; const harness = await createEngineHarness();
  try {
    const caller = createActivityCaller(harness.database, { retrying() { attempts += 1; throw new Error("retry"); }, terminal() { attempts += 1; throw ApplicationFailure.nonRetryable("stop", "stop"); } }, async () => undefined);
    await expect(caller.call("retrying", [], { retry: { maximumAttempts: 3, initialInterval: 1 } }, new AbortController().signal, "workflow")).rejects.toThrow("failed");
    expect(attempts).toBe(3); attempts = 0;
    await expect(caller.call("terminal", [], { retry: { maximumAttempts: 3 } }, new AbortController().signal, "workflow")).rejects.toThrow("failed");
    expect(attempts).toBe(1);
  } finally { await harness.stop(); }
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
    const planningRejected = expect(planningCommand).rejects.toBeInstanceOf(CancelledFailure);
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

test("development cancellation invokes the cancel hook before held completion", async () => {
  const development = deferred<DeveloperActivityResult>();
  const developmentStarted = deferred<void>();
  const cancellationSent = deferred<void>();
  let cancellationCalls = 0;
  const harness = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    runDeveloperExecutionSupervised: async () => {
      developmentStarted.resolve(undefined);
      return development.promise;
    },
    cancelDeveloperExecution: async (input) => {
      cancellationCalls += 1;
      cancellationSent.resolve(undefined);
      return { status: "cancelled_confirmed", executionId: input.executionId, exitCode: null, exitSignal: null, evidenceArtifactId: null };
    },
  });
  const issueId = "interrupt-development";
  const workflowId = harness.workflowId(issueId);
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
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId, ready));
    const developmentCommand = executeIssueCommand(harness.config, started.workflowId, "start_development", {
      expectedRevision: 1,
      actorUserId: engineFixture.actorUserId,
      commandId: "start-held-development",
    });
    await developmentStarted.promise;
    await developmentCommand;
    const active = await queryIssueWorkflow(harness.config, started.workflowId);
    expect(active).toMatchObject({ phase: "development", developerRecoveryStatus: "starting" });

    const command = { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-held-development" };
    const cancellation = executeIssueCommand(harness.config, started.workflowId, "cancel_development", command);
    await cancellationSent.promise;
    const cancelled = await cancellation;
    expect(cancelled).toMatchObject({ phase: "delivery_blocked", developerRecoveryStatus: "cancelled", activeOperation: null });
    expect(cancellationCalls).toBe(1);

    const executionId = active.developerExecutionId;
    if (!executionId) throw new Error("The held development turn did not record its execution ID");
    development.resolve(developerResult(executionId));
    for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
    expect(await queryIssueWorkflow(harness.config, started.workflowId)).toMatchObject({ phase: "delivery_blocked", developerRecoveryStatus: "cancelled", revision: cancelled.revision });
    expect(await executeIssueCommand(harness.config, started.workflowId, "cancel_development", command)).toEqual(cancelled);
    expect(cancellationCalls).toBe(1);
    expect(commandReceiptCount(harness, command.commandId)).toBe(1);
  } finally {
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
    const firstRun = await startIssueWorkflow(harness.config, activeInput(firstIssueId, "developer-target-a"));
    const secondRun = await startIssueWorkflow(harness.config, activeInput(secondIssueId, "developer-target-b"));
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
    expect(firstResult).toMatchObject({ phase: "approval", revision: planned.revision, processedCommandIds: expect.arrayContaining([command.commandId]) });
    expect(harness.calls.get("recordPlannerNote")).toBe(1);
    expect(commandReceiptCount(harness, command.commandId)).toBe(1);
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
  } finally {
    await harness.stop();
  }
});

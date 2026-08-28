import { expect, test } from "vitest";
import { isDeepStrictEqual } from "node:util";

import { executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { createTemporalHarness, type TemporalHarness } from "./helpers/temporal-harness.js";

const base = "a".repeat(40);
const firstCommit = "b".repeat(40);
const secondCommit = "c".repeat(40);

function continuation(h: TemporalHarness, issueId: string) {
  return {
    phase: "ready_for_development" as const, revision: 1, owner: "lead" as const,
    allowedCommands: ["start_development" as const, "cancel_issue" as const], pendingAction: "Start development",
    lastEventId: `${issueId}:1`, continuationCount: 0, lastSummaryHash: null, blocker: null,
    stateChangedAt: new Date().toISOString(), planRevision: 1, planMaterial: true, planApproved: true,
    leadSessionRef: "lead-session", leadOutputArtifactId: h.artifacts.integrationLeadOutputArtifactId,
  };
}

function result(input: { developerTurnExecutionId: string }, commit: string, remaining: number[], outcome: "blocked" | "completed") {
  return {
    status: "completed" as const, resultHash: "d".repeat(64), result: {
      developerExecutionId: input.developerTurnExecutionId, developerSessionRef: "developer-session",
      branchName: "forge/issue/continuation", targetBaseSha: base, currentStep: 1,
      resultCommit: commit, resultTree: "e".repeat(40), dirtyState: "clean" as const,
      deliveryArtifactId: "developer-delivery", evidenceArtifactId: "developer-evidence",
      deliverySummary: "Developer made committed progress.", outcome,
      steps: [{ number: 1, status: "completed" }, ...remaining.map((number) => ({ number, status: "incomplete" }))],
      authorizedStepsNotCompleted: remaining, blocker: outcome === "blocked" ? null : undefined,
    },
  };
}

async function waitForPhase(h: TemporalHarness, workflowId: string, phase: string, settled = (_state: Awaited<ReturnType<typeof queryIssueWorkflow>>) => true) {
  let state = await queryIssueWorkflow(h.config, workflowId);
  for (let attempt = 0; attempt < 120 && (state.phase !== phase || !settled(state)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await queryIssueWorkflow(h.config, workflowId);
  }
  return state;
}

async function settleContinuationState(h: TemporalHarness, workflowId: string) {
  const deadline = Date.now() + 30_000;
  let previous = await queryIssueWorkflow(h.config, workflowId);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const current = await queryIssueWorkflow(h.config, workflowId);
    if (current.phase === "delivery_ready" && current.activeOperation === null && isDeepStrictEqual(current, previous)) return current;
    previous = current;
  }
  throw new Error(`Timed out waiting for ${workflowId} to settle in delivery_ready`);
}

async function start(h: TemporalHarness, issueId: string) {
  return startIssueWorkflow(h.config, {
    companyId: "issue-company", projectId: "issue-project", issueId, projectRevisionId: "issue-revision",
    briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [],
    roleProfiles: h.issueRoleProfiles, supplementalReview: false, continuationState: continuation(h, issueId),
  });
}

test("partial Developer delivery automatically continues on the same session", { timeout: 120_000 }, async () => {
  const h = createTemporalHarness();
  const inputs: any[] = [];
  const projected: any[] = [];
  h.activityOverrides.set("projectIssueState", async (event) => {
    projected.push(event.state);
    if (event.state.phase === "delivery_ready") await new Promise((resolve) => setTimeout(resolve, 600));
    return event.state;
  });
  h.activityOverrides.set("runDeveloperExecutionSupervised", async (input) => {
    inputs.push(input);
    return inputs.length === 1 ? result(input, firstCommit, [2, 3, 4, 5, 6, 7, 8], "blocked") : result(input, secondCommit, [], "completed");
  });
  await h.start();
  try {
    const started = await start(h, "developer-continuation-complete");
    const settled = await settleContinuationState(h, started.workflowId);
    expect(projected).toContainEqual(expect.objectContaining({ phase: "delivery_ready", developerContinuation: null }));
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ continuation: { remainingSteps: [2, 3, 4, 5, 6, 7, 8], previousCommit: firstCommit } });
    expect(settled).toMatchObject({ developerContinuation: null });
  } finally { await h.stop(); }
});

test("a repeated partial delivery stops after no progress and retry preserves the continuation", { timeout: 120_000 }, async () => {
  const h = createTemporalHarness();
  const inputs: any[] = [];
  h.activityOverrides.set("projectIssueState", async (event) => {
    if (event.state.phase === "delivery_ready") await new Promise((resolve) => setTimeout(resolve, 600));
    return event.state;
  });
  h.activityOverrides.set("runDeveloperExecutionSupervised", async (input) => {
    inputs.push(input);
    if (inputs.length === 1) return result(input, firstCommit, [2, 3], "blocked");
    if (inputs.length === 2) return result(input, firstCommit, [2, 3], "blocked");
    return result(input, secondCommit, [], "completed");
  });
  await h.start();
  try {
    const started = await start(h, "developer-continuation-stalled");
    const blocked = await waitForPhase(h, started.workflowId, "delivery_blocked");
    expect(blocked).toMatchObject({ pendingAction: expect.stringMatching(/^Automatic continuation is not making progress/), blocker: { actions: expect.arrayContaining([expect.objectContaining({ label: "Resume Developer turn" })]) } });
    expect(inputs).toHaveLength(2);
    expect(await queryIssueWorkflow(h.config, started.workflowId)).toEqual(blocked);
    const retry = executeIssueCommand(h.config, started.workflowId, "retry_development", { expectedRevision: blocked.revision, actorUserId: "issue-admin" });
    const settled = await settleContinuationState(h, started.workflowId);
    await retry;
    expect(inputs).toHaveLength(3);
    expect(inputs[2]).toMatchObject({ continuation: { remainingSteps: [2, 3], previousCommit: firstCommit } });
    expect(settled).toMatchObject({ developerContinuation: null });
  } finally { await h.stop(); }
});

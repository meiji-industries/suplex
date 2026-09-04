import { expect, test } from "vitest";


import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState, type IssueWorkflowState } from "../src/engine/issue-contracts.js";
import { runExecution } from "../src/engine/registry.js";
import { createAcquireExternalTurn, createGuarded } from "../src/engine/workflow/runtime.js";

test("simple capacity admission preserves the current pending action", async () => {
  let state: IssueWorkflowState = {
    ...buildInitialIssueWorkflowState({
      workflowId: "workflow-simple-capacity",
      companyId: "company-simple-capacity",
      projectId: "project-simple-capacity",
      issueId: "task-simple-capacity",
      projectRevisionId: "revision-simple-capacity",
      briefArtifactId: "brief-simple-capacity",
      briefSha256: "a".repeat(64),
      imageArtifactIds: [],
      requestHash: "b".repeat(64),
      roleProfiles: {},
      supplementalReview: false,
    }),
    ...at("planning"),
    owner: "lead",
    pendingAction: "The Planner writes the plan",
  };
  const projected: IssueWorkflowState[] = [];
  const acquireExternalTurn = createAcquireExternalTurn(
    {
      get: () => state,
      set: (next) => {
        state = next;
      },
    },
    {
      projectState: async (next) => {
        projected.push(next);
        return next;
      },
    },
  );

  await expect(acquireExternalTurn(
    { operation: "lead_planning", role: "planner" },
    async (capacityRequestId) => capacityRequestId,
    () => undefined,
  )).resolves.toBeUndefined();

  expect(state).toMatchObject({
    revision: 1,
    lastEventId: "workflow-simple-capacity:1",
    pendingAction: "The Planner writes the plan",
  });
  expect(projected).toEqual([state]);
});

test("a driver phase guard rejects without projecting its provisional claim", async () => {
  let state: IssueWorkflowState = buildInitialIssueWorkflowState({
    workflowId: "workflow-driver-guard",
    companyId: "company-driver-guard",
    projectId: "project-driver-guard",
    issueId: "task-driver-guard",
    projectRevisionId: "revision-driver-guard",
    briefArtifactId: "brief-driver-guard",
    briefSha256: "a".repeat(64),
    imageArtifactIds: [],
    requestHash: "b".repeat(64),
    roleProfiles: {},
    supplementalReview: false,
  });
  const claimed = { ...state, revision: 1, lastEventId: "workflow-driver-guard:1", processedCommandIds: ["driver-command"] };
  state = claimed;
  const projected: IssueWorkflowState[] = [];
  const guarded = createGuarded(
    { get: () => state, set: (next) => { state = next; } },
    { project: async (next) => { projected.push(next); return next; } },
  )(async (_input: { actorUserId: string }) => { throw new Error("The command is not available in the current phase"); }, "test");
  const execution = {
    workflowId: state.workflowId,
    runId: "run",
    signal: new AbortController().signal,
    commands: new Map(),
    queries: new Map(),
    interrupts: new Map(),
    acceptedInterrupt: undefined,
    interruptResult: undefined,
    activity: async () => undefined,
    wait: async () => undefined,
    now: () => 0,
    wake: () => undefined,
    autoActionsHalted: () => false,
  };

  await expect(runExecution.run(execution, () => guarded({ actorUserId: "forge-driver" }))).rejects.toThrow("not available in the current phase");

  expect(state).toEqual(claimed);
  expect(projected).toEqual([]);
});

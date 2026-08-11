import { allHandlersFinished, condition, continueAsNew, defineQuery, defineUpdate, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";

import { ProbeWorkflowInputSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { IssueWorkflowInputSchema, IssueWorkflowStateSchema, RecordProgressInputSchema, StartPlanningInputSchema, type IssueActivities, type IssueWorkflowInput, type IssueWorkflowState, type RecordProgressInput, type StartPlanningInput } from "./issue-contracts.js";
import { assertContinuationStateWithinLimit, assertPayloadWithinLimit, WORKFLOW_HISTORY_EVENT_LIMIT } from "./policy.js";

const { recordProbeStarted } = proxyActivities<ProbeActivities>({
  startToCloseTimeout: "1 minute",
});

const { projectIssueState } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
});

export const probeStateQuery = defineQuery<ProbeWorkflowState>("probeState");

export async function probeWorkflow(input: ProbeWorkflowInput): Promise<ProbeWorkflowState> {
  const validatedInput = ProbeWorkflowInputSchema.parse(input);
  let state: ProbeWorkflowState = {
    workflowId: validatedInput.workflowId,
    probeId: validatedInput.probeId,
    companyId: validatedInput.companyId,
    status: "starting",
  };
  setHandler(probeStateQuery, () => state);
  state = await recordProbeStarted(validatedInput);
  await condition(() => false);
  return state;
}

export const issueStateQuery = defineQuery<IssueWorkflowState>("issueState");
export const startPlanningUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("startPlanning");
export const recordProgressUpdate = defineUpdate<IssueWorkflowState, [RecordProgressInput]>("recordProgress");

export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  const validatedInput = IssueWorkflowInputSchema.parse(input);
  assertPayloadWithinLimit("Issue Workflow input", validatedInput);
  const continuation = validatedInput.continuationState;
  const continueAfter = validatedInput.continueAsNewAfter ?? 0;
  let state: IssueWorkflowState = IssueWorkflowStateSchema.parse({
    workflowId: validatedInput.workflowId,
    companyId: validatedInput.companyId,
    projectId: validatedInput.projectId,
    issueId: validatedInput.issueId,
    projectRevisionId: validatedInput.projectRevisionId,
    phase: "backlog",
    revision: 0,
    owner: "human",
    allowedCommands: ["start_planning"],
    pendingAction: "Start planning",
    lastEventId: `${validatedInput.workflowId}:0`,
    lastSummaryHash: null,
    ...(continuation ?? {}),
    continuationCount: continuation ? continuation.continuationCount + 1 : 0,
  });
  let continuationRequested = false;
  const shouldContinueAsNew = (revision: number): boolean => {
    return (continueAfter > 0 && revision >= continueAfter) || workflowInfo().historyLength >= WORKFLOW_HISTORY_EVENT_LIMIT;
  };
  setHandler(issueStateQuery, () => state);
  setHandler(startPlanningUpdate, async (rawInput) => {
    assertPayloadWithinLimit("startPlanning command", rawInput);
    StartPlanningInputSchema.parse(rawInput);
    const next = IssueWorkflowStateSchema.parse({
      ...state,
      phase: "planning",
      revision: state.revision + 1,
      owner: "lead",
      allowedCommands: continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "Lead planning",
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      continuationCount: state.continuationCount,
      lastSummaryHash: state.lastSummaryHash,
    });
    state = next;
    assertPayloadWithinLimit("Issue Workflow result", next);
    await projectIssueState(next);
    return next;
  }, {
    validator(rawInput) {
      const command = StartPlanningInputSchema.parse(rawInput);
      if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
      if (state.phase !== "backlog") throw new Error("Planning can only start from Backlog");
    },
  });
  setHandler(recordProgressUpdate, async (rawInput) => {
    assertPayloadWithinLimit("recordProgress command", rawInput);
    const command = RecordProgressInputSchema.parse(rawInput);
    const next = IssueWorkflowStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      allowedCommands: continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "Lead planning",
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      continuationCount: state.continuationCount,
      lastSummaryHash: command.summaryHash,
    });
    state = next;
    assertPayloadWithinLimit("Issue Workflow result", next);
    if (shouldContinueAsNew(next.revision)) continuationRequested = true;
    await projectIssueState(next);
    return next;
  }, {
    validator(rawInput) {
      const command = RecordProgressInputSchema.parse(rawInput);
      if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
      if (state.phase !== "planning") throw new Error("Progress can only be recorded during Planning");
    },
  });
  assertPayloadWithinLimit("Issue Workflow result", state);
  await projectIssueState(state);
  await condition(() => continuationRequested && allHandlersFinished());
  if (continuationRequested) {
    assertContinuationStateWithinLimit(state);
    await continueAsNew<typeof issueWorkflow>({ ...validatedInput, continuationState: state, continueAsNewAfter: 0 });
  }
  await condition(() => false);
  return state;
}

import { condition, defineQuery, defineUpdate, proxyActivities, setHandler } from "@temporalio/workflow";

import { ProbeWorkflowInputSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { IssueWorkflowInputSchema, IssueWorkflowStateSchema, StartPlanningInputSchema, type IssueActivities, type IssueWorkflowInput, type IssueWorkflowState, type StartPlanningInput } from "./issue-contracts.js";

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

export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  const validatedInput = IssueWorkflowInputSchema.parse(input);
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
  });
  setHandler(issueStateQuery, () => state);
  setHandler(startPlanningUpdate, async (rawInput) => {
    StartPlanningInputSchema.parse(rawInput);
    const next = IssueWorkflowStateSchema.parse({
      ...state,
      phase: "planning",
      revision: state.revision + 1,
      owner: "lead",
      allowedCommands: [],
      pendingAction: "Lead planning",
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
    });
    state = next;
    await projectIssueState(next);
    return next;
  }, {
    validator(rawInput) {
      const command = StartPlanningInputSchema.parse(rawInput);
      if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
      if (state.phase !== "backlog") throw new Error("Planning can only start from Backlog");
    },
  });
  await projectIssueState(state);
  await condition(() => false);
  return state;
}

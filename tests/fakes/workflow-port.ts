import { initialStateFixture } from "../fixtures/issue-state.js";
import { IssueWorkflowStateSchema, type ContinueWorkCommand, type IssueWorkflowInput, type IssueWorkflowState, type PlanCommandInput, type PlanRevisionCommand, type RecordProgressInput, type ResolveDecisionBlockerInput, type StartPlanningInput } from "../../src/temporal/issue-contracts.js";
import type { IssueWorkflowPort } from "../../src/tasks.js";

interface WorkflowPortFakeOptions {
  companyId: string;
  projectId: string;
  projectRevisionId: string;
  projectState?: (state: IssueWorkflowState) => IssueWorkflowState;
}

export function createWorkflowPortFake(options: WorkflowPortFakeOptions): IssueWorkflowPort {
  const states = new Map<string, IssueWorkflowState>();
  const projectState = options.projectState ?? ((state: IssueWorkflowState): IssueWorkflowState => state);
  const nextState = (workflowId: string, input: StartPlanningInput | PlanCommandInput, update: Partial<IssueWorkflowState>): IssueWorkflowState => {
    const current = states.get(workflowId) ?? initialStateFixture();
    const state = IssueWorkflowStateSchema.parse({ ...current, ...update, workflowId, companyId: options.companyId, projectId: options.projectId, projectRevisionId: options.projectRevisionId, revision: input.expectedRevision + 1, lastEventId: `${workflowId}:${input.expectedRevision + 1}` });
    states.set(workflowId, state);
    return projectState(state);
  };
  const execute = async (command: string, workflowId: string, input: StartPlanningInput | PlanCommandInput): Promise<IssueWorkflowState> => {
    if (command === "start_planning") return nextState(workflowId, input, { phase: "approval", owner: "human", allowedCommands: ["request_supplemental_review", "approve_plan", "reject_plan"], pendingAction: "Approve final plan", planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: false });
    if (command === "request_supplemental_review") return nextState(workflowId, input, { phase: "approval", owner: "human", allowedCommands: ["approve_plan", "reject_plan"], pendingAction: "Approve final plan", planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: true });
    if (command === "approve_plan") return nextState(workflowId, input, { phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development"], pendingAction: "Start development", planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: true });
    return nextState(workflowId, input, {});
  };
  const start = async (input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string; existing?: boolean }> => {
    const workflowId = input.workflowId!;
    const state = IssueWorkflowStateSchema.parse({ ...initialStateFixture(), workflowId, companyId: input.companyId, projectId: input.projectId, issueId: input.issueId, projectRevisionId: input.projectRevisionId, requestHash: input.requestHash, lastEventId: `${workflowId}:0` });
    states.set(workflowId, projectState(state));
    return { workflowId, runId: "run" };
  };
  const transitionBespoke = async (workflowId: string, input: PlanRevisionCommand | ContinueWorkCommand | ResolveDecisionBlockerInput | RecordProgressInput): Promise<IssueWorkflowState> => {
    const current = states.get(workflowId) ?? initialStateFixture();
    const state = IssueWorkflowStateSchema.parse({ ...current, revision: input.expectedRevision + 1, lastEventId: `${workflowId}:${input.expectedRevision + 1}` });
    states.set(workflowId, state);
    return projectState(state);
  };
  return {
    start,
    execute: execute as IssueWorkflowPort["execute"],
    revisePlan: transitionBespoke,
    continueWork: transitionBespoke,
    resolveDecisionBlocker: transitionBespoke,
    recordProgress: transitionBespoke,
    query: async (workflowId) => states.get(workflowId) ?? initialStateFixture(),
    acceptPlanning: (workflowId, input) => execute("start_planning", workflowId, input),
    acceptDevelopment: (workflowId, input) => execute("start_development", workflowId, input),
  };
}

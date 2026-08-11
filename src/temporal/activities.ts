import type { ForgeDatabase } from "../database.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { IssueWorkflowStateSchema, type IssueActivities, type IssueWorkflowState } from "./issue-contracts.js";
import { StructuredLogger, activityLogContext } from "../logging.js";

export function createActivities(database: ForgeDatabase): ProbeActivities & IssueActivities {
  const logger = new StructuredLogger();
  return {
    async recordProbeStarted(input: ProbeWorkflowInput): Promise<ProbeWorkflowState> {
      const validatedInput = ProbeWorkflowInputSchema.parse(input);
      logger.child(activityLogContext()).info("Probe activity started", {
        companyId: validatedInput.companyId,
      });
      database.recordProbe({
        workflowId: validatedInput.workflowId,
        probeId: validatedInput.probeId,
        companyId: validatedInput.companyId,
        status: "running",
      });
      return ProbeWorkflowStateSchema.parse({
        ...validatedInput,
        status: "running",
      });
    },
    async projectIssueState(input: IssueWorkflowState): Promise<IssueWorkflowState> {
      const state = IssueWorkflowStateSchema.parse(input);
      database.projectIssueState({
        taskId: state.issueId,
        companyId: state.companyId,
        projectId: state.projectId,
        workflowId: state.workflowId,
        revision: state.revision,
        phase: state.phase,
        owner: state.owner,
        allowedCommands: state.allowedCommands,
        pendingAction: state.pendingAction,
        lastEventId: state.lastEventId,
      });
      return state;
    },
  };
}

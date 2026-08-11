import type { ForgeDatabase } from "../database.js";
import type { ForgeConfig } from "../config.js";
import { AgentService } from "../codex-lead.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { IssueWorkflowStateSchema, type IssueActivities, type IssueWorkflowState } from "./issue-contracts.js";
import { StructuredLogger, activityLogContext } from "../logging.js";

export interface ActivityOptions {
  agent?: Pick<AgentService, "runLeadPlanning">;
}

export function createActivities(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}): ProbeActivities & IssueActivities {
  const logger = new StructuredLogger();
  const agent = options.agent ?? new AgentService(database, config);
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
    async runLeadPlanning(input) {
      return agent.runLeadPlanning(input);
    },
  };
}

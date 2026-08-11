import type { ForgeDatabase } from "../database.js";
import type { ProbeActivities, ProbeWorkflowInput, ProbeWorkflowState } from "./contracts.js";

export function createActivities(database: ForgeDatabase): ProbeActivities {
  return {
    async recordProbeStarted(input: ProbeWorkflowInput): Promise<ProbeWorkflowState> {
      database.recordProbe({
        workflowId: input.workflowId,
        probeId: input.probeId,
        companyId: input.companyId,
        status: "running",
      });
      return {
        ...input,
        status: "running",
      };
    },
  };
}

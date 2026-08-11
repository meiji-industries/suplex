import { condition, defineQuery, proxyActivities, setHandler } from "@temporalio/workflow";

import type { ProbeActivities, ProbeWorkflowInput, ProbeWorkflowState } from "./contracts.js";

const { recordProbeStarted } = proxyActivities<ProbeActivities>({
  startToCloseTimeout: "1 minute",
});

export const probeStateQuery = defineQuery<ProbeWorkflowState>("probeState");

export async function probeWorkflow(input: ProbeWorkflowInput): Promise<ProbeWorkflowState> {
  let state: ProbeWorkflowState = {
    workflowId: input.workflowId,
    probeId: input.probeId,
    companyId: input.companyId,
    status: "starting",
  };
  setHandler(probeStateQuery, () => state);
  state = await recordProbeStarted(input);
  await condition(() => false);
  return state;
}

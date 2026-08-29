import { z } from "zod";

import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema } from "../schemas.js";

export { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema };

export type ProbeWorkflowInput = z.infer<typeof ProbeWorkflowInputSchema>;
export type ProbeWorkflowState = z.infer<typeof ProbeWorkflowStateSchema>;

export interface ProbeActivities {
  recordProbeStarted(input: ProbeWorkflowInput): Promise<ProbeWorkflowState>;
}

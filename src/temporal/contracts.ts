export interface ProbeWorkflowInput {
  workflowId: string;
  probeId: string;
  companyId: string;
}

export interface ProbeWorkflowState {
  workflowId: string;
  probeId: string;
  companyId: string;
  status: "starting" | "running";
}

export interface ProbeActivities {
  recordProbeStarted(input: ProbeWorkflowInput): Promise<ProbeWorkflowState>;
}

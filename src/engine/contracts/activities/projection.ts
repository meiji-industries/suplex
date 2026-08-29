import type { IssueProjectionEvent, IssueWorkflowState } from "../../issue-contracts.js";

export interface ProjectionActivities {
  projectIssueState(event: IssueProjectionEvent): Promise<IssueWorkflowState>;
}

export interface DeliveryBlockerActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  operation: "review" | "repair";
}

export interface DeliveryBlockerActivityResult {
  artifactId: string;
}

export interface DeliveryBlockerActivities {
  recordDeliveryBlocker(input: DeliveryBlockerActivityInput): Promise<DeliveryBlockerActivityResult>;
}

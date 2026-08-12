import { sleep } from "@temporalio/workflow";

import { issueWorkflow as productionIssueWorkflow } from "../../src/temporal/workflows.js";
import type { IssueWorkflowInput, IssueWorkflowState } from "../../src/temporal/issue-contracts.js";

export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  await sleep("1ms");
  return productionIssueWorkflow(input);
}

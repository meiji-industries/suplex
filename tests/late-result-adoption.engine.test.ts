import { expect, test } from "vitest";

import { IssueWorkflowStateSchema } from "../src/engine/issue-contracts.js";
import { at } from "../src/issue-phases.js";
import { adoptCiRepairResult } from "../src/engine/workflow/register-ci.js";

test("an adopted CI repair returns the current git revision to delivery review", () => {
  const state = IssueWorkflowStateSchema.parse({ workflowId: "workflow_1", companyId: "company_1", projectId: "project_1", issueId: "task_1", projectRevisionId: "revision_1", ...at("ci_repairing"), revision: 8, owner: "lead", allowedCommands: [], pendingAction: "The Builder repairs the failed CI job", lastEventId: "workflow_1:8", continuationCount: 0, lastSummaryHash: null, repairCycle: 0, blocker: null, developerTurnKind: "repair", developerExecutionId: "developer_old", ciRunId: "ci_1", ciAttemptId: "attempt_1", resultCommit: "a".repeat(40), resultTree: "b".repeat(40), branchName: "issue/task_1" });
  const adopted = adoptCiRepairResult(state, { developerExecutionId: "developer_repair", developerSessionRef: "session_repair", branchName: "issue/task_1", resultCommit: "c".repeat(40), resultTree: "d".repeat(40), deliveryArtifactId: null, evidenceArtifactId: null, summary: "Commit repairs the lint errors." });

  expect(adopted).toMatchObject({ step: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], resultCommit: "c".repeat(40), resultTree: "d".repeat(40), developerExecutionId: "developer_repair" });
  expect(adopted.revision).toBe(9);
});

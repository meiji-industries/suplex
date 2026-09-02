import { expect, test } from "vitest";

import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/engine/issue-contracts.js";
import { ISSUE_PHASES, ISSUE_STEPS, phaseOf } from "../src/issue-phases.js";

const initial = buildInitialIssueWorkflowState({
  workflowId: "workflow", companyId: "company", projectId: "project", issueId: "issue",
  projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64),
  imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false,
  repairCycleLimit: 2,
});

test("maps every engine step to a task phase", () => {
  for (const step of ISSUE_STEPS) expect(ISSUE_PHASES).toContain(phaseOf(step));
});

test("upgrades a legacy delivery blocker snapshot", () => {
  const parsed = IssueWorkflowStateSchema.parse({ ...initial, phase: "delivery_blocked", allowedCommands: ["retry_development", "cancel_issue"], owner: "human", step: undefined, blocker: null });
  expect(parsed).toMatchObject({ step: "development", phase: "building", blocker: { unblockOwner: "human" } });
});

test("upgrades a legacy step snapshot", () => {
  const parsed = IssueWorkflowStateSchema.parse({ ...initial, phase: "ci_waiting", step: undefined });
  expect(parsed).toMatchObject({ step: "ci_waiting", phase: "shipping" });
});

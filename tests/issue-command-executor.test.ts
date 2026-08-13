import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { issueCommandId } from "../src/temporal/service.js";

const workflowId = "workflow-test-installation-issue-command-parity";
const input = { expectedRevision: 7, actorUserId: "fixture-user" };

test("generic command IDs preserve the frozen wrapper digest inputs", () => {
  for (const [command, kind] of [
    ["start_planning", "start-planning"],
    ["approve_plan", "approvePlan"],
    ["review_delivery", "delivery review command"],
    ["cancel_issue", "cancelIssue"],
  ] as const) {
    const digest = createHash("sha256").update(JSON.stringify([workflowId, kind, input])).digest("hex");
    expect(issueCommandId(workflowId, command, input)).toBe(`command_${digest}`);
  }
});

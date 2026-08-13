import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { PlanDecisionForm, type DecisionCommandView } from "../src/frontend/components/app/plan-decision-form.js";
import type { PublicPlanDecisionSubject } from "../src/plan-governance.js";

const subject: PublicPlanDecisionSubject = { plan: { companyId: "company-1", issueId: "task-1", workflowId: "workflow-1", originalPlanRevision: 1, outputId: "output-1", outputRevision: 1, finalVersion: 1, artifactId: "artifact-1", artifactSha256: "a".repeat(64), leadExecutionId: "execution-1", evidenceManifestArtifactId: "manifest-1", evidenceManifestSha256: "b".repeat(64) }, materiality: { categories: ["user_visible_behavior"], artifactId: "artifact-2", artifactSha256: "c".repeat(64) }, expectedWorkflowRevision: 4 };
const command: DecisionCommandView = { endpoint: "approve-plan", expectedRevision: 4, subject };

test("plan decisions show three direct choices without a redundant selector or note", () => {
  const html = renderToStaticMarkup(createElement(PlanDecisionForm, { approveCommand: command, revisionCommand: { ...command, endpoint: "request-plan-revision" }, busy: false, onSubmit: async () => undefined }));

  expect(html).toContain(">Approve Plan<");
  expect(html).toContain(">Reject Plan<");
  expect(html).toContain(">Request Changes<");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("Decision note");
  expect(html).not.toContain("<textarea");
});

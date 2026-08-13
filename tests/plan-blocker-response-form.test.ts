import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { PlanBlockerResponseForm } from "../src/frontend/components/app/plan-blocker-response-form.js";
import { taskActionPayload } from "../src/frontend/lib/view-shared.js";
import { HttpPlanBlockerResponseBodySchema } from "../src/http/contracts/common.js";

const subject = { companyId: "company_1", issueId: "task_1", workflowId: "workflow_1", artifactId: "artifact_1", artifactSha256: "a".repeat(64), leadExecutionId: "agent_1", evidenceManifestArtifactId: "artifact_2", evidenceManifestSha256: "b".repeat(64), category: "human_decision" as const, resumePhase: "planning" as const };

test("plan blocker responses keep their strict workflow payload", () => {
  const payload = { subject, answer: "Use the recommended wording", expectedWorkflowRevision: 4, idempotencyKey: "response-1" };
  expect(HttpPlanBlockerResponseBodySchema.parse(taskActionPayload(4, undefined, payload))).toEqual(payload);
  expect(taskActionPayload(4, "Approve", { subject: { issueId: "task_1" } })).toEqual({ expectedRevision: 4, note: "Approve", subject: { issueId: "task_1" } });
});

test("legacy blockers with no recommendations show only a direct answer", () => {
  const html = renderToStaticMarkup(createElement(PlanBlockerResponseForm, {
    blocker: {
      subject,
      header: "Decision",
      question: "What should change?",
      evidence: "No recommendation was recorded.",
      nextAction: "Write an answer.",
      options: [],
    },
    expectedRevision: 1,
    busy: false,
    onSubmit: async () => undefined,
  }));

  expect(html).toContain(">Answer<");
  expect(html).toContain("<textarea");
  expect(html).toContain('aria-label="Send response"');
  expect(html).toContain('title="Send response"');
  expect(html).not.toContain(">Respond<");
  expect(html).not.toContain("Choose one");
  expect(html).not.toContain(">Other<");
  expect(html).not.toContain("No recommendation was recorded.");
});

test("structured blockers render three choices plus Other", () => {
  const html = renderToStaticMarkup(createElement(PlanBlockerResponseForm, {
    blocker: {
      subject,
      header: "README",
      question: "Which section should change?",
      evidence: "The brief leaves the section open.",
      nextAction: "Choose a section.",
      options: [{ label: "Overview (Recommended)", description: "Improve the introduction." }, { label: "Features", description: "Improve a feature description." }, { label: "Install", description: "Improve installation guidance." }],
    },
    expectedRevision: 1,
    busy: false,
    onSubmit: async () => undefined,
  }));

  expect(html.match(/role="radio"/g)).toHaveLength(4);
  expect(html).toContain("Overview (Recommended)");
  expect(html).toContain(">Other<");
  expect(html).not.toContain("<textarea");
});

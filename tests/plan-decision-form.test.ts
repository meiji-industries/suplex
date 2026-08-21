import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { PlanDecisionForm, type DecisionCommandView } from "../src/frontend/components/app/plan-decision-form.js";

const command: DecisionCommandView = { endpoint: "approve-plan", expectedRevision: 4 };

test("plan decisions show three direct choices without a redundant selector or note", () => {
  const html = renderToStaticMarkup(createElement(PlanDecisionForm, { approveCommand: command, revisionCommand: { ...command, endpoint: "request-plan-revision" }, busy: false, onSubmit: async () => undefined }));

  expect(html).toContain(">Approve Plan<");
  expect(html).toContain(">Reject Plan<");
  expect(html).toContain(">Request Changes<");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("Decision note");
  expect(html).not.toContain("<textarea");
});

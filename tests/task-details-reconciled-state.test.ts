import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { TaskDetailsPage } from "../src/frontend/views/task-details.js";

test("a GitHub-merged, green pull request does not render the retired acceptance state", () => {
  (globalThis as { window?: { location: { pathname: string; href: string } } }).window = { location: { pathname: "/tasks/task-1", href: "http://localhost/tasks/task-1" } };
  const task = {
    id: "task-1", title: "Merged task", description: "", images: [], roleAgents: {}, supplementalReview: false, autoApprovePlan: false,
    deliveryTarget: "merged", executionControls: { runProjectTests: true, visualEvidence: "off", supplementalReview: false }, deliveryReceipt: null, pullRequestMode: "auto_merge",
    workflowId: "workflow-1", projectRevisionId: "revision-1", phase: "done", revision: 4, owner: "lead", allowedCommands: [], commands: [], governance: {}, pendingAction: "Merged",
    createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:12.000Z", timeline: [], activity: [], agentInvocations: [], capacity: undefined,
    planHistory: [], planDecisionHistory: [], revisionHistory: [], developerExecutionHistory: [], deliveryReviewHistory: [],
    projection: { authoritativeRevision: 4, projectedRevision: 4, projectedAt: "2026-08-22T00:00:12.000Z", status: "current" }, reviewLineage: { currentReview: null, priorReviews: [], reviewAttempts: [], repairAttempts: [] }, targetBaseReconciliation: { status: null },
    githubPullRequest: { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "merged", isDraft: false, checks: { total: 1, pending: 0, failing: 0, successful: 1 }, mergeable: "MERGEABLE", observedAt: "2026-08-22T00:00:12.000Z", reviewDecision: "APPROVED", autoMergeEnabled: true },
  } as any;
  const html = renderToStaticMarkup(createElement(TaskDetailsPage, { task, project: undefined, companyId: "company-1", busy: false, error: "", isAdmin: true, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined, onResolveDecisionBlocker: async () => undefined, onMarkReady: async () => undefined, onMerge: async () => undefined, onDuplicate: async () => undefined, onUpdateDetails: async () => undefined, onRefresh: async () => undefined, onRescue: async () => ({ steps: [] }) }));
  expect(html).toContain("Done");
  expect(html).toContain("Merged");
  expect(html).not.toContain("Accepted");
  expect(html).not.toContain("Needs your call");
});

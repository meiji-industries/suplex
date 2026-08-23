import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { TaskDetailsPage } from "../src/frontend/views/task-details.js";
import { PullRequestCard } from "../src/frontend/components/app/pull-request-card.js";

test("draft pull requests render the primary ready action and icon-only refresh", () => {
  const draftTask = {
    id: "task-1", title: "Draft task", phase: "development", release: null,
    githubPullRequest: { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "open", isDraft: true, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, mergeable: null, observedAt: null, autoMergeEnabled: false },
  } as any;
  const draftHtml = renderToStaticMarkup(createElement(PullRequestCard, { task: draftTask, busy: false, onRefresh: async () => undefined, onMarkReady: async () => undefined }));
  expect(draftHtml).toContain("Ready for review");
  expect(draftHtml).toContain('data-variant="default"');
  expect(draftHtml).toContain('aria-label="Refresh"');
  expect(draftHtml).not.toContain(">Refresh<");
  const readyHtml = renderToStaticMarkup(createElement(PullRequestCard, { task: { ...draftTask, githubPullRequest: { ...draftTask.githubPullRequest, isDraft: false } }, busy: false, onRefresh: async () => undefined, onMarkReady: async () => undefined }));
  expect(readyHtml).not.toContain("Ready for review");
});

test("a GitHub-merged, green pull request does not render the retired acceptance state", () => {
  (globalThis as { window?: { location: { pathname: string; href: string } } }).window = { location: { pathname: "/tasks/task-1", href: "http://localhost/tasks/task-1" } };
  const task = {
    id: "task-1", title: "Merged task", description: "", images: [], roleAgents: {}, prompts: { overrides: [] }, supplementalReview: false, autoApprovePlan: false,
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

test("properties show the plan mode", () => {
  (globalThis as { window?: { location: { pathname: string; href: string } } }).window = { location: { pathname: "/tasks/task-1", href: "http://localhost/tasks/task-1" } };
  const task = {
    id: "task-1", title: "Mode task", description: "", images: [], roleAgents: {}, prompts: { overrides: [] }, supplementalReview: false, autoApprovePlan: false, deliveryTarget: "pull_request_draft", executionControls: { runProjectTests: true, visualEvidence: "off", supplementalReview: false }, deliveryReceipt: null, pullRequestMode: "draft",
    workflowId: "workflow-1", projectRevisionId: "revision-1", phase: "done", revision: 1, owner: "human", allowedCommands: [], commands: [], governance: {}, pendingAction: null, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:12.000Z", timeline: [], activity: [], agentInvocations: [], capacity: null,
    planMaterial: true, materialCategories: ["user_visible_behavior"], planHistory: [], planDecisionHistory: [], revisionHistory: [], developerExecutionHistory: [], deliveryReviewHistory: [], projection: { authoritativeRevision: 1, projectedRevision: 1, projectedAt: "2026-08-22T00:00:12.000Z", status: "current" }, reviewLineage: { currentReview: null, priorReviews: [], reviewAttempts: [], repairAttempts: [] }, targetBaseReconciliation: { status: null }, githubPullRequest: { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "merged", isDraft: false, checks: { total: 1, pending: 0, failing: 0, successful: 1 }, mergeable: "MERGEABLE", observedAt: "2026-08-22T00:00:12.000Z", reviewDecision: "APPROVED", autoMergeEnabled: true },
  } as any;
  const html = renderToStaticMarkup(createElement(TaskDetailsPage, { task, project: undefined, companyId: "company-1", busy: false, error: "", isAdmin: true, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined, onResolveDecisionBlocker: async () => undefined, onMarkReady: async () => undefined, onMerge: async () => undefined, onDuplicate: async () => undefined, onUpdateDetails: async () => undefined, onRefresh: async () => undefined, onRescue: async () => ({ steps: [] }) }));
  expect(html).toContain("Mode");
  expect(html).toContain("Non-Trivial");
  const trivialHtml = renderToStaticMarkup(createElement(TaskDetailsPage, { task: { ...task, planMaterial: false, materialCategories: [] }, project: undefined, companyId: "company-1", busy: false, error: "", isAdmin: true, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined, onResolveDecisionBlocker: async () => undefined, onMarkReady: async () => undefined, onMerge: async () => undefined, onDuplicate: async () => undefined, onUpdateDetails: async () => undefined, onRefresh: async () => undefined, onRescue: async () => ({ steps: [] }) }));
  expect(trivialHtml).toContain("Trivial");
});

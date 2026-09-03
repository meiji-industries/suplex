import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { TaskDetailsPage } from "../src/frontend/views/task-details.js";
import { PullRequestCard } from "../src/frontend/components/app/pull-request-card.js";
import { SystemHealthProvider } from "../src/frontend/components/app/system-health.js";
import type { ApiTask } from "../src/frontend/lib/view-shared.js";

function renderTaskDetails(props: Parameters<typeof TaskDetailsPage>[0]): string {
  return renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskDetailsPage, props) }));
}

test("pull request head branches hug their text while change stats remain right-aligned", () => {
  const task = {
    id: "task-1", title: "Pull request task", phase: "development", release: { title: "Pull request task", baseBranch: "main", headBranch: "work/readme-tweak-10-2c349f08" },
    githubPullRequest: { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "open", isDraft: false, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, mergeable: null, observedAt: null, autoMergeEnabled: false, changedFiles: 1, additions: 2, deletions: 0 },
  } as any;
  const html = renderToStaticMarkup(createElement(PullRequestCard, { task, busy: false, onRefresh: async () => undefined, onMarkReady: async () => undefined }));
  expect(html).toContain('<code class="min-w-0 truncate rounded bg-muted px-1.5" title="work/readme-tweak-10-2c349f08">');
  expect(html).not.toContain('min-w-0 flex-1 truncate rounded bg-muted px-1.5');
  expect(html).toContain('class="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums"');
});

test("pull request cards show the latest failing check separately from metadata", () => {
  const partialTask = {
    id: "task-1", title: "Pull request task", phase: "development", release: null,
    ci: { attempts: [{ checks: [{ name: "build / test", status: "completed", conclusion: "failure", detailsUrl: "https://github.com/acme/forge/runs/1", summary: null, startedAt: "2026-08-31T00:00:00.000Z", completedAt: "2026-08-31T00:02:00.000Z", selectedForEvaluation: true }] }] },
    githubPullRequest: { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "open", isDraft: false, checks: { total: 1, pending: 0, failing: 1, successful: 0 }, mergeable: "MERGEABLE", observedAt: null, autoMergeEnabled: false },
  };
  // This focused rendering fixture omits unrelated task fields.
  const task = partialTask as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(PullRequestCard, { task, busy: false, onRefresh: async () => undefined, onMarkReady: async () => undefined }));
  expect(html).toContain('href="https://github.com/acme/forge/runs/1"');
  expect(html).toContain("build / test");
  expect(html).toContain("Failing after 2m");
  expect(html).toContain("Mergeability mergeable · Auto-merge off · synced never");
  expect(html).not.toContain("Checks failing 1/1 ·");
});

test("pull request cards offer Fix CI only for actionable failing checks", () => {
  const task = {
    id: "task-1", title: "Pull request task", phase: "development", release: null, allowedCommands: ["repair_ci"],
    githubPullRequest: { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "open", isDraft: false, checks: { total: 1, pending: 0, failing: 1, successful: 0 }, mergeable: "MERGEABLE", observedAt: null, autoMergeEnabled: false },
  } as unknown as ApiTask;
  const props = { busy: false, onRefresh: async () => undefined, onMarkReady: async () => undefined, onRepairCi: async () => undefined };
  expect(renderToStaticMarkup(createElement(PullRequestCard, { task, ...props }))).toContain("Fix CI");
  const busyHtml = renderToStaticMarkup(createElement(PullRequestCard, { task, ...props, busy: true }));
  expect(busyHtml).toContain("Starting…");
  expect(busyHtml).toContain('disabled=""');
  expect(renderToStaticMarkup(createElement(PullRequestCard, { task: { ...task, githubPullRequest: { ...task.githubPullRequest!, checks: { ...task.githubPullRequest!.checks, failing: 0, successful: 1 } } }, ...props }))).not.toContain("Fix CI");
  expect(renderToStaticMarkup(createElement(PullRequestCard, { task: { ...task, allowedCommands: [] }, ...props }))).not.toContain("Fix CI");
});

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
  const html = renderTaskDetails({ task, project: undefined, companyId: "company-1", busy: false, error: "", isAdmin: true, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined, onResolveDecisionBlocker: async () => undefined, onMarkReady: async () => undefined, onMerge: async () => undefined, onDuplicate: async () => undefined, onUpdateDetails: async () => undefined, onRefresh: async () => undefined, onRescue: async () => ({ steps: [] }) });
  expect(html).toContain("Done");
  expect(html).toContain("Merged");
  expect(html).not.toContain("Accepted");
  expect(html).not.toContain("Your decision is necessary");
});

test("properties show the approval policy", () => {
  (globalThis as { window?: { location: { pathname: string; href: string } } }).window = { location: { pathname: "/tasks/task-1", href: "http://localhost/tasks/task-1" } };
  const task = {
    id: "task-1", title: "Mode task", description: "", images: [], roleAgents: {}, prompts: { overrides: [] }, supplementalReview: false, autoApprovePlan: false, deliveryTarget: "pull_request_draft", executionControls: { runProjectTests: true, visualEvidence: "off", supplementalReview: false }, deliveryReceipt: null, pullRequestMode: "draft",
    workflowId: "workflow-1", projectRevisionId: "revision-1", phase: "done", revision: 1, owner: "human", allowedCommands: [], commands: [], governance: {}, pendingAction: null, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:12.000Z", timeline: [], activity: [], agentInvocations: [], capacity: null,
    planHistory: [], planDecisionHistory: [], revisionHistory: [], developerExecutionHistory: [], deliveryReviewHistory: [], projection: { authoritativeRevision: 1, projectedRevision: 1, projectedAt: "2026-08-22T00:00:12.000Z", status: "current" }, reviewLineage: { currentReview: null, priorReviews: [], reviewAttempts: [], repairAttempts: [] }, targetBaseReconciliation: { status: null }, githubPullRequest: { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "merged", isDraft: false, checks: { total: 1, pending: 0, failing: 0, successful: 1 }, mergeable: "MERGEABLE", observedAt: "2026-08-22T00:00:12.000Z", reviewDecision: "APPROVED", autoMergeEnabled: true },
  } as any;
  const html = renderTaskDetails({ task, project: undefined, companyId: "company-1", busy: false, error: "", isAdmin: true, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined, onResolveDecisionBlocker: async () => undefined, onMarkReady: async () => undefined, onMerge: async () => undefined, onDuplicate: async () => undefined, onUpdateDetails: async () => undefined, onRefresh: async () => undefined, onRescue: async () => ({ steps: [] }) });
  expect(html).toContain("Approval");
  expect(html).toContain("required");
  const automaticHtml = renderTaskDetails({ task: { ...task, autoApprovePlan: true }, project: undefined, companyId: "company-1", busy: false, error: "", isAdmin: true, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined, onResolveDecisionBlocker: async () => undefined, onMarkReady: async () => undefined, onMerge: async () => undefined, onDuplicate: async () => undefined, onUpdateDetails: async () => undefined, onRefresh: async () => undefined, onRescue: async () => ({ steps: [] }) });
  expect(automaticHtml).toContain("auto");
});

test("properties show delivery and execution settings", () => {
  (globalThis as { window?: { location: { pathname: string; href: string } } }).window = { location: { pathname: "/tasks/task-1", href: "http://localhost/tasks/task-1" } };
  const task = {
    id: "task-1", title: "Settings task", description: "", images: [], roleAgents: {}, prompts: { overrides: [] }, supplementalReview: false, autoApprovePlan: false, deliveryTarget: "local_worktree", executionControls: { runProjectTests: true, visualEvidence: "off", supplementalReview: false }, deliveryReceipt: null, pullRequestMode: "draft",
    workflowId: "workflow-1", projectRevisionId: "revision-1", phase: "done", revision: 1, owner: "human", allowedCommands: [], commands: [], governance: {}, pendingAction: null, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:12.000Z", timeline: [], activity: [], agentInvocations: [], capacity: null,
    planHistory: [], planDecisionHistory: [], revisionHistory: [], developerExecutionHistory: [], deliveryReviewHistory: [], projection: { authoritativeRevision: 1, projectedRevision: 1, projectedAt: "2026-08-22T00:00:12.000Z", status: "current" }, reviewLineage: { currentReview: null, priorReviews: [], reviewAttempts: [], repairAttempts: [] }, targetBaseReconciliation: { status: null }, githubPullRequest: { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "merged", isDraft: false, checks: { total: 1, pending: 0, failing: 0, successful: 1 }, mergeable: "MERGEABLE", observedAt: "2026-08-22T00:00:12.000Z", reviewDecision: "APPROVED", autoMergeEnabled: true },
  } as any;
  const render = (overrides: Record<string, unknown> = {}) => renderTaskDetails({ task: { ...task, ...overrides }, project: undefined, companyId: "company-1", busy: false, error: "", isAdmin: true, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined, onResolveDecisionBlocker: async () => undefined, onMarkReady: async () => undefined, onMerge: async () => undefined, onDuplicate: async () => undefined, onUpdateDetails: async () => undefined, onRefresh: async () => undefined, onRescue: async () => ({ steps: [] }) });
  for (const [deliveryTarget, label] of [["local_worktree", "Keep in worktree"], ["remote_branch", "Push branch"], ["pull_request_draft", "Draft pull request"], ["pull_request_ready", "Ready for review"], ["merged", "Merge to base"]]) expect(render({ deliveryTarget })).toContain(label);
  for (const [visualEvidence, label] of [["off", "Off"], ["capture", "Capture"], ["required", "Required"]]) expect(render({ executionControls: { runProjectTests: true, supplementalReview: false, visualEvidence } })).toContain(label);
  const enabledHtml = render({ executionControls: { runProjectTests: true, supplementalReview: true, visualEvidence: "off" } });
  expect(enabledHtml).toContain("Run project tests</dt><dd>Enabled</dd>");
  expect(enabledHtml).toContain("Second review</dt><dd>Enabled</dd>");
  expect(render({ lastHandlerError: { command: "supplemental_review", reason: "Second review did not finish: The reviewer could not be started.", at: "2026-08-24T00:00:00.000Z" } })).toContain("Second review</dt><dd>Not completed — Second review did not finish: The reviewer could not be started.</dd>");
  expect(render({ deliveryTarget: undefined, executionControls: undefined })).toContain("Delivery</dt><dd>Not specified</dd>");
  for (const label of ["Status", "Project", "Approval", "Prompts", "Plan review", "Next action", "Sync", "Created"]) expect(enabledHtml).toContain(`<dt class=\"text-muted-foreground\">${label}</dt>`);
});

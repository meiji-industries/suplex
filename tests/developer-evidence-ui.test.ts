import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TaskLeadPlan } from "../src/frontend/components/app/task-lead-plan.js";
import { activityRelativeDate, extractAgentTranscript, harnessSummary, TaskActivity } from "../src/frontend/components/app/task-history.js";
import { invocationActorLabel, workflowOwnerLabel } from "../src/frontend/components/app/task-invocations.js";
import { DeveloperEvidence, type DeveloperExecutionView } from "../src/frontend/components/tasks/developer-evidence.js";
import type { TaskResponse } from "../src/http/contracts/tasks.js";

test("labels an agent with its execution profile", () => {
  expect(invocationActorLabel({ agentName: "Planner", profileName: "Smart", role: "planner" })).toBe("Planner (Smart)");
  expect(invocationActorLabel({ agentName: "Planner", profileName: "Fast", role: "integrator" })).toBe("Integrator (Fast)");
});

test("labels post-approval ownership and system CI work accurately", () => {
  expect(workflowOwnerLabel({ owner: "lead", phase: "releasing" } as TaskResponse)).toBe("Integrator");
  expect(workflowOwnerLabel({ owner: "lead", phase: "final_review" } as TaskResponse)).toBe("Reviewer");
  expect(workflowOwnerLabel({ owner: "human", phase: "accepted" } as TaskResponse)).toBe("human");
});

test("makes conflict summaries easy to scan", () => {
  expect(harnessSummary({ kind: "decision_blocker", summary: "The forward merge has one resolvable conflict in `server/assets/studio.css`; the approved improvements can be preserved." })).toBe("There is a conflict in server/assets/studio.css. Choose how to resolve it.");
});

test("renders the approved plan as static numbered instructions", () => {
  const html = renderToStaticMarkup(createElement(TaskLeadPlan, { output: { kind: "plan", summary: "Plan", executionId: "lead_1", outputArtifactId: "plan_1", evidenceArtifactId: "evidence_1", content: { kind: "plan", summary: "Plan", gitPresentation: { branchSlug: "stream-progress", pullRequestTitle: "Stream progress", pullRequestDescription: "Show live Developer progress." }, reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "First", entryPoint: null, completionCriterion: null, verification: "test one", verificationCommands: [] }, { number: 2, instruction: "Second", entryPoint: null, completionCriterion: null, verification: "test two", verificationCommands: [] }], compatibilityAnalysis: "Compatible", operationalAnalysis: "No impact", verificationStrategy: "Run checks", unresolvedTechnicalQuestions: [], materialCategories: [], preservedWorktreeCompatibility: null, affectedPaths: [], materiality: [], developerContext: { includeTaskBrief: false, evidenceArtifactIds: [], imageArtifactIds: [], repositoryInstructionPaths: [], artifactStepNumbers: {} } } }, decisionControls: createElement("button", null, "Approve Plan") }));

  expect(html).toContain("Step 1 — First");
  expect(html).toContain("Step 2 — Second");
  expect(html).toContain('data-plan-steps="true"');
  expect(html).toContain('data-orientation="vertical"');
  expect(html).toMatch(/data-plan-steps="true"><div[^>]*data-slot="timeline-item"/);
  expect(html).toContain('data-slot="timeline"');
  expect(html).toContain('data-slot="timeline-indicator"');
  expect(html).not.toMatch(/\sdata-completed(?:=|\s|>)/);
  expect(html).not.toContain("aria-current");
  expect(html).toContain("Plan: Stream progress");
  expect(html).not.toContain("Revision 1");
  expect(html).not.toContain(">Material<");
  expect(html).not.toContain("Builder execution");
  expect(html).not.toContain("Active command");
  expect(html).not.toContain("Verification receipts");
  expect(html).toContain('data-slot="card-footer"');
  expect(html).toContain("Approve Plan");
});

test("shows the Builder's work without execution bookkeeping", () => {
  const execution = {
    id: "developer_1",
    status: "completed",
    attempt: 1,
    branchName: "work/evidence",
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: "2026-08-13T00:01:30.000Z",
    summary: "Added the requested evidence view.",
    targetBaseSha: "a".repeat(40),
  } as DeveloperExecutionView;
  const html = renderToStaticMarkup(createElement(DeveloperEvidence, { execution, onViewChanges: () => {} }));

  expect(html.match(/data-developer-evidence="true"/g)).toHaveLength(1);
  expect(html).toContain("Attempt 1");
  expect(html).toContain("1:30");
  expect(html).toContain("Added the requested evidence view.");
  expect(html).toContain("View changes");
  expect(html).not.toContain("Boundary");
  expect(html).not.toContain("Provider observation");
});

test("places plan activity at its planning revision", () => {
  const timeline = [{ id: "plan", revision: 1, eventType: "planning_started", metadata: {}, createdAt: "2026-08-13T00:00:00.000Z", kind: "workflow" as const }];
  const collapsed = renderToStaticMarkup(createElement(TaskActivity, { timeline, agentInvocations: [], collapsePlan: true, revisionContent: { revision: 1, content: createElement("span", null, "Detailed plan") } }));
  const open = renderToStaticMarkup(createElement(TaskActivity, { timeline, agentInvocations: [], collapsePlan: false, revisionContent: { revision: 1, content: createElement("span", null, "Detailed plan") } }));
  expect(collapsed).toContain("Detailed plan");
  expect(open).toContain("Detailed plan");
});

test("labels planning capacity lifecycle entries", () => {
  const createdAt = "2026-08-13T00:00:00.000Z";
  const timeline = [
    { id: "planning-started", revision: 1, eventType: "planning_started", metadata: { planningStage: "started" }, createdAt, kind: "workflow" as const },
    { id: "planning-active", revision: 2, eventType: "planning_started", metadata: { planningStage: "active" }, createdAt, kind: "workflow" as const },
    { id: "planning-completed", revision: 3, eventType: "planning_started", metadata: { planningStage: "completed" }, createdAt, kind: "workflow" as const },
  ];
  const html = renderToStaticMarkup(createElement(TaskActivity, { timeline, agentInvocations: [], processing: { agentName: "Planner", avatarSeed: "default" } }));

  expect(html).toContain("started planning");
  expect(html).toContain("planning began");
  expect(html).toContain("planning completed");
  expect(html).toContain("Planner");
  expect(html).not.toContain("Forge");
});

test("shows the recorded reason when a task moves to Blocked", () => {
  const html = renderToStaticMarkup(createElement(TaskActivity, { timeline: [{ id: "blocked", revision: 1, eventType: "phase_delivery_blocked", metadata: { blockedReason: "The Developer process exited unexpectedly." }, createdAt: "2026-08-13T00:00:00.000Z", kind: "workflow" as const }], agentInvocations: [] }));

  expect(html).not.toContain("Blocked reason");
  expect(html).toContain("The Developer process exited unexpectedly.");
  expect(html).toContain('data-task-blocked-reason="true"');
  expect(html).toContain('aria-expanded="false"');
});

test("places an approved delivery review at its Reviewed activity, not a later blocker", () => {
  const hash = "a".repeat(40);
  const task = { id: "task_1", owner: "lead", allowedCommands: [], reviewLineage: { currentReview: { id: "review_1", outcome: "approved", summary: "Approved delivery", planRevision: 1, baseSha: hash, baseShaAbbrev: hash.slice(0, 8), subjectCommit: hash, subjectCommitAbbrev: hash.slice(0, 8), subjectTree: hash, subjectTreeAbbrev: hash.slice(0, 8), opinionArtifactId: "opinion_1", evidenceArtifactId: "evidence_1", correctionAttempts: 0, supersedesReviewId: null, successorReviewId: null, leadSessionContinued: true, developerSessionContinued: true, createdAt: "2026-08-13T00:00:00.000Z", findings: [] }, priorReviews: [], reviewAttempts: [], repairAttempts: [] } } as unknown as TaskResponse;
  const timeline = [
    { id: "reviewed", revision: 1, eventType: "phase_delivery_reviewed", metadata: {}, createdAt: "2026-08-13T00:00:00.000Z", kind: "workflow" as const },
    { id: "blocked", revision: 2, eventType: "phase_delivery_blocked", metadata: { blockedReason: "Pinned verification failed" }, createdAt: "2026-08-13T00:01:00.000Z", kind: "workflow" as const },
  ];
  const html = renderToStaticMarkup(createElement(TaskActivity, { timeline, agentInvocations: [], deliveryReviewTask: task }));

  expect(html).toContain("Review result");
  expect(html.indexOf("moved the task to Reviewed")).toBeLessThan(html.indexOf("data-task-activity-delivery-review"));
  expect(html.indexOf("data-task-activity-delivery-review")).toBeLessThan(html.indexOf("moved the task to Blocked"));
});

test("collapses repeated development and CI updates without changing their audit source", () => {
  const timeline = [
    { id: "development-1", revision: 1, eventType: "phase_development", metadata: {}, createdAt: "2026-08-13T00:00:00.000Z", kind: "workflow" as const },
    { id: "development-1-update", revision: 2, eventType: "phase_development", metadata: {}, createdAt: "2026-08-13T00:01:00.000Z", kind: "workflow" as const },
    { id: "development-1-blocked", revision: 3, eventType: "phase_blocked", metadata: { blockedReason: "The Developer process stopped." }, createdAt: "2026-08-13T00:02:00.000Z", kind: "workflow" as const },
    { id: "retry", revision: 4, eventType: "member_action", metadata: { actionLabel: "Retry development" }, createdAt: "2026-08-13T00:03:00.000Z", kind: "member" as const },
    { id: "development-2", revision: 5, eventType: "phase_development", metadata: {}, createdAt: "2026-08-13T00:04:00.000Z", kind: "workflow" as const },
    { id: "ci-1", revision: 6, eventType: "phase_ci_waiting", metadata: {}, createdAt: "2026-08-13T00:05:00.000Z", kind: "workflow" as const },
    { id: "ci-2", revision: 7, eventType: "phase_ci_waiting", metadata: {}, createdAt: "2026-08-13T00:06:00.000Z", kind: "workflow" as const },
  ];
  const html = renderToStaticMarkup(createElement(TaskActivity, { timeline, agentInvocations: [], developerAttempts: [{ attempt: 1 }, { attempt: 2 }], ci: { outcome: "waiting", status: "waiting", attempts: [{ attemptNumber: 1, outcome: "waiting", checks: [{ status: "in_progress", selectedForEvaluation: true }] }] } }));

  expect(html).toContain("Development stopped");
  expect(html).toContain("Development retry started");
  expect(html).toContain("Waiting for CI · poll 1 · polling · 0/1 checks · 2 polls");
  expect(html.match(/Development stopped/g)?.length).toBe(1);
  expect(html.match(/Waiting for CI ·/g)?.length).toBe(1);
});

test("shows relative activity times", () => {
  const now = Date.parse("2026-08-13T10:49:00.000Z");
  expect(activityRelativeDate("2026-08-13T10:48:42.000Z", now)).toBe("18s ago");
  expect(activityRelativeDate("2026-08-13T10:47:28.000Z", now)).toBe("1m 32s ago");
  expect(activityRelativeDate("2026-08-13T09:17:00.000Z", now)).toBe("1h 32m ago");
  expect(activityRelativeDate("2026-08-13T10:39:00.000Z", now)).toBe("10m ago");
  expect(activityRelativeDate("2026-08-11T07:22:00.000Z", now)).toBe("2d 3h 27m ago");
  const timestamp = new Date(Date.now() - 10 * 60_000).toISOString();
  const html = renderToStaticMarkup(createElement(TaskActivity, { timeline: [{ id: "created", revision: 0, eventType: "task_created", metadata: {}, createdAt: timestamp, kind: "member" as const }], agentInvocations: [] }));
  expect(html).toContain("10m ago");
  expect(html).toContain('title="');
});

test("extracts agent messages for the inline activity transcript", () => {
  const transcript = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "ignored" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"summary":"On it"}' } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Finished." } }),
  ].join("\n");
  expect(extractAgentTranscript(transcript)).toBe('{\n  "summary": "On it"\n}\n\nFinished.');
});

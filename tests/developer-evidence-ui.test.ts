import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TaskLeadPlan } from "../src/frontend/components/app/task-lead-plan.js";
import { activityRelativeDate, extractAgentTranscript, harnessSummary, TaskActivity } from "../src/frontend/components/app/task-history.js";
import { invocationActorLabel, workflowOwnerLabel } from "../src/frontend/components/app/task-invocations.js";
import type { TaskResponse } from "../src/http/contracts/tasks.js";

const approvedPlanOutput: NonNullable<TaskResponse["leadOutput"]> = { kind: "plan", summary: "Plan", executionId: "lead_1", outputArtifactId: "plan_1", evidenceArtifactId: "evidence_1", content: { kind: "plan", summary: "Plan", gitPresentation: { branchSlug: "stream-progress", pullRequestTitle: "Stream progress", pullRequestDescription: "Show live Developer progress." }, reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "First", entryPoint: null, completionCriterion: null, verification: "test one", verificationCommands: [] }, { number: 2, instruction: "Second", entryPoint: null, completionCriterion: null, verification: "test two", verificationCommands: [] }], compatibilityAnalysis: "Compatible", operationalAnalysis: "No impact", verificationStrategy: "Run checks", unresolvedTechnicalQuestions: [], preservedWorktreeCompatibility: null, affectedPaths: [], developerContext: { includeTaskBrief: false, evidenceArtifactIds: [], imageArtifactIds: [], repositoryInstructionPaths: [], artifactStepNumbers: {} } } };

test("labels an agent with its execution settings", () => {
  expect(invocationActorLabel({ agentName: "Planner", profileName: "Smart", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", role: "planner" })).toBe("Planner (gpt-5.6-sol · medium · standard)");
  expect(invocationActorLabel({ agentName: "Integrator", profileName: "Fast", model: "gpt-5.6-sol", reasoningLevel: "high", servicePriority: "fast", role: "integrator" })).toBe("Integrator (gpt-5.6-sol · high · fast)");
});

test("labels post-approval ownership and system CI work accurately", () => {
  expect(workflowOwnerLabel({ owner: "lead", step: "releasing" })).toBe("Integrator");
  expect(workflowOwnerLabel({ owner: "lead", step: "final_review" })).toBe("Reviewer");
  expect(workflowOwnerLabel({ owner: "human", step: "accepted" })).toBe("human");
});

test("makes conflict summaries easy to scan", () => {
  expect(harnessSummary({ kind: "decision_blocker", summary: "The forward merge has one resolvable conflict in `server/assets/studio.css`; the approved improvements can be preserved." })).toBe("There is a conflict in server/assets/studio.css. Choose how to resolve it.");
});

test("renders the approved plan as static numbered instructions", () => {
  const html = renderToStaticMarkup(createElement(TaskLeadPlan, { output: approvedPlanOutput, decisionControls: createElement("button", null, "Approve Plan") }));

  const text = html.replace(/<[^>]+>/g, "");
  expect(text).toContain("Step 1 — First");
  expect(text).toContain("Step 2 — Second");
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
  expect(html).toContain('data-plan-slot="plan-footer"');
  expect(html).toContain("Approve Plan");
});

test("renders a historical plan with a closed panel", () => {
  const html = renderToStaticMarkup(createElement(TaskLeadPlan, { output: approvedPlanOutput, collapsible: true }));

  expect(html).toContain("Plan: Stream progress");
  expect(html).not.toContain("Step 1 — First");
  expect(html).toContain('aria-expanded="false"');
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

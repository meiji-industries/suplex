import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TaskLeadPlan } from "../src/frontend/components/app/task-lead-plan.js";
import { activityRelativeDate, extractAgentTranscript, TaskActivity } from "../src/frontend/components/app/task-history.js";
import type { DeveloperExecutionEventView, DeveloperExecutionView } from "../src/frontend/components/tasks/developer-evidence.js";

test("shows live receipts inside the active step and rolls up completed steps", () => {
  const execution: DeveloperExecutionView = { id: "developer_1", status: "running", attempt: 1, branchName: "work/task", currentStep: 1, targetBaseSha: "a".repeat(40), verificationCommands: [{ stepNumber: 1, commands: ["test one"] }, { stepNumber: 2, commands: ["test two"] }] };
  const event = (eventId: string, sequence: number, kind: string, stepNumber: number, summary: string): DeveloperExecutionEventView => ({ eventId, sequence, kind, stepNumber, occurredAt: "2026-08-13T00:00:00.000Z", summary, exitCode: kind === "command_finished" ? 0 : null, artifactId: null });
  const events = [event("done", 1, "command_finished", 1, "Completed command"), event("step-done", 2, "step_completed", 1, "Step completed"), event("step-live", 3, "step_started", 2, "Step started"), event("live", 4, "command_started", 2, "Active command")];
  const html = renderToStaticMarkup(createElement(TaskLeadPlan, { output: { kind: "plan", summary: "Plan", executionId: "lead_1", outputArtifactId: "plan_1", evidenceArtifactId: "evidence_1", content: { kind: "plan", summary: "Plan", gitPresentation: { branchSlug: "stream-progress", pullRequestTitle: "Stream progress", pullRequestDescription: "Show live Developer progress." }, reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "First", entryPoint: null, completionCriterion: null, verification: "test one", verificationCommands: [] }, { number: 2, instruction: "Second", entryPoint: null, completionCriterion: null, verification: "test two", verificationCommands: [] }], compatibilityAnalysis: "Compatible", operationalAnalysis: "No impact", verificationStrategy: "Run checks", unresolvedTechnicalQuestions: [], materialCategories: [], preservedWorktreeCompatibility: null, affectedPaths: [], materiality: [], developerContext: { includeTaskBrief: false, evidenceArtifactIds: [], imageArtifactIds: [], repositoryInstructionPaths: [], artifactStepNumbers: {} } } }, decisionControls: createElement("button", null, "Approve Plan"), stepProgress: { taskId: "task_1", execution: { ...execution, currentStep: 2 }, events, terminalSteps: {} } }));

  expect(html).toContain("Step 1 · completed");
  expect(html).toContain("Step 2 · active");
  expect(html).toContain("Implementer execution");
  expect(html).toContain("Plan: Stream progress");
  expect(html).not.toContain("Revision 1");
  expect(html).not.toContain(">Material<");
  expect(html.indexOf("Implementer execution")).toBeGreaterThan(html.indexOf("Step 2 · active"));
  expect(html).toContain("Active command");
  expect(html).not.toContain("Completed command");
  expect(html).not.toContain("Verification receipts");
  expect(html).toContain('data-slot="card-footer"');
  expect(html).toContain("Approve Plan");
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
  const html = renderToStaticMarkup(createElement(TaskActivity, { timeline, agentInvocations: [], processing: { agentName: "Analyst", avatarSeed: "default" } }));

  expect(html).toContain("started planning");
  expect(html).toContain("planning began");
  expect(html).toContain("planning completed");
  expect(html).toContain("Analyst");
  expect(html).not.toContain("Forge");
});

test("shows the recorded reason when a task moves to Blocked", () => {
  const html = renderToStaticMarkup(createElement(TaskActivity, { timeline: [{ id: "blocked", revision: 1, eventType: "phase_delivery_blocked", metadata: { blockedReason: "The Developer process exited unexpectedly." }, createdAt: "2026-08-13T00:00:00.000Z", kind: "workflow" as const }], agentInvocations: [] }));

  expect(html).toContain("Blocked reason");
  expect(html).toContain("The Developer process exited unexpectedly.");
  expect(html).toContain('data-task-blocked-reason="true"');
});

test("shows relative activity times", () => {
  const now = Date.parse("2026-08-13T10:49:00.000Z");
  expect(activityRelativeDate("2026-08-13T10:48:42.000Z", now)).toBe("18s ago");
  expect(activityRelativeDate("2026-08-13T10:47:28.000Z", now)).toBe("1m 32s ago");
  expect(activityRelativeDate("2026-08-13T09:17:00.000Z", now)).toBe("1h 32m ago");
  expect(activityRelativeDate("2026-08-13T10:39:00.000Z", now)).toBe("10m ago");
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

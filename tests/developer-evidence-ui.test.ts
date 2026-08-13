import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TaskLeadPlan } from "../src/frontend/components/app/task-lead-plan.js";
import { extractAgentTranscript, TaskActivity } from "../src/frontend/components/app/task-history.js";
import type { DeveloperExecutionEventView, DeveloperExecutionView } from "../src/frontend/components/tasks/developer-evidence.js";

test("shows live receipts inside the active step and rolls up completed steps", () => {
  const execution: DeveloperExecutionView = { id: "developer_1", status: "running", attempt: 1, branchName: "work/task", currentStep: 1, targetBaseSha: "a".repeat(40), verificationCommands: [{ stepNumber: 1, commands: ["test one"] }, { stepNumber: 2, commands: ["test two"] }] };
  const event = (eventId: string, sequence: number, kind: string, stepNumber: number, summary: string): DeveloperExecutionEventView => ({ eventId, sequence, kind, stepNumber, occurredAt: "2026-08-13T00:00:00.000Z", summary, exitCode: kind === "command_finished" ? 0 : null, artifactId: null });
  const events = [event("done", 1, "command_finished", 1, "Completed command"), event("step-done", 2, "step_completed", 1, "Step completed"), event("step-live", 3, "step_started", 2, "Step started"), event("live", 4, "command_started", 2, "Active command")];
  const html = renderToStaticMarkup(createElement(TaskLeadPlan, { output: { kind: "plan", summary: "Plan", executionId: "lead_1", outputArtifactId: "plan_1", evidenceArtifactId: "evidence_1", content: { kind: "plan", summary: "Plan", gitPresentation: { branchSlug: "stream-progress", pullRequestTitle: "Stream progress", pullRequestDescription: "Show live Developer progress." }, reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "First", entryPoint: null, completionCriterion: null, verification: "test one", verificationCommands: [] }, { number: 2, instruction: "Second", entryPoint: null, completionCriterion: null, verification: "test two", verificationCommands: [] }], compatibilityAnalysis: "Compatible", operationalAnalysis: "No impact", verificationStrategy: "Run checks", unresolvedTechnicalQuestions: [], materialCategories: [], preservedWorktreeCompatibility: null, affectedPaths: [], materiality: [], developerContext: { includeTaskBrief: false, evidenceArtifactIds: [], imageArtifactIds: [], repositoryInstructionPaths: [], artifactStepNumbers: {} } } }, planRevision: 1, planMaterial: true, materialCategories: [], stepProgress: { taskId: "task_1", execution: { ...execution, currentStep: 2 }, events, terminalSteps: {} } }));

  expect(html).toContain("Step 1 · completed");
  expect(html).toContain("Step 2 · active");
  expect(html).toContain("Developer execution");
  expect(html.indexOf("Developer execution")).toBeGreaterThan(html.indexOf("Step 2 · active"));
  expect(html).toContain("Active command");
  expect(html).not.toContain("Completed command");
  expect(html).not.toContain("Verification receipts");
});

test("rolls up the plan activity after the Plan phase", () => {
  const timeline = [{ id: "plan", revision: 1, eventType: "planning_started", metadata: {}, createdAt: "2026-08-13T00:00:00.000Z", kind: "workflow" as const }];
  const collapsed = renderToStaticMarkup(createElement(TaskActivity, { timeline, agentInvocations: [], collapsePlan: true, revisionContent: { revision: 1, content: createElement("span", null, "Detailed plan") } }));
  const open = renderToStaticMarkup(createElement(TaskActivity, { timeline, agentInvocations: [], collapsePlan: false, revisionContent: { revision: 1, content: createElement("span", null, "Detailed plan") } }));
  expect(collapsed).toContain("Plan");
  expect(collapsed).not.toContain("Detailed plan");
  expect(open).toContain("Detailed plan");
});

test("extracts agent messages for the inline activity transcript", () => {
  const transcript = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "ignored" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"summary":"On it"}' } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Finished." } }),
  ].join("\n");
  expect(extractAgentTranscript(transcript)).toBe('{\n  "summary": "On it"\n}\n\nFinished.');
});

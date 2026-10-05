// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";

import type { Task } from "../src/frontend/contracts/tasks.js";
import type { ReviewRecord } from "../src/frontend/contracts/generated/ReviewRecord.js";
import type { TaskActivity } from "../src/frontend/features/tasks/task-work.js";
import { WorkflowHistory } from "../src/frontend/features/tasks/workflow-history.js";

const recordedAt = "2026-09-08T12:00:00.000Z";
const profile = { profileId: "profile", provider: "codex", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issue: null, issueKey: null, title: "Review the task", description: "", status: "active", deliveryTarget: "pull_request_draft",
  rootProfile: profile, workerProfile: profile, workflow: "independent_review", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "meiji-industries/suplex", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "review-history", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: recordedAt },
  worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [], artifacts: [], dependsOn: [], createdAt: recordedAt, updatedAt: recordedAt, statusChangedAt: recordedAt, archivedAt: null,
} satisfies Task;
const review = {
  sessionId: "reviewer", turnId: "review-1", role: "reviewer",
  range: { baseSha: "a".repeat(40), headSha: "b".repeat(40), files: ["task-action.ts"], commits: ["b".repeat(40)] },
  result: { role: "reviewer", approved: false, summary: "Repair the task action.", blockingFindings: ["The task action drops the answer."], verification: "passed", verificationSummary: "The focused checks passed." },
  invalidReason: null, recordedAt,
} satisfies ReviewRecord;
const session = { id: "planner-a", kind: "worker", advisorRole: "planner_a", label: "Plan A", profileId: "profile", generation: 1, nativeSessionId: null, paneId: null, current: true, replacement: null, harness: "codex" } satisfies TaskActivity["sessions"][number];
const turn = { id: "plan-a", sessionId: session.id, prompt: "Create the plan.", status: "prompted", promptedAt: recordedAt, completedAt: null, result: null } satisfies TaskActivity["turns"][number];
const roots: Root[] = [];

async function mount(reviews: ReviewRecord[], activity: TaskActivity = { sessions: [], turns: [], shellPaneId: null }, workflow: Task["workflow"] = "independent_review") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<WorkflowHistory task={{ ...task, workflow, workflowState: { ...task.workflowState, reviews } }} activity={activity} />); });
  return container;
}

function element<T extends HTMLElement>(container: ParentNode, selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

async function click(button: HTMLButtonElement) {
  await act(async () => { button.focus(); button.click(); });
}

afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
});

test("a reviewer row keeps compact facts visible while findings, verification, and Markdown expand", async () => {
  const report = "## Repair plan\n\nKeep the **answer** in the task action.";
  const container = await mount([review], { sessions: [], turns: [{ ...turn, id: review.turnId, sessionId: review.sessionId, status: "completed", completedAt: recordedAt, result: JSON.stringify({ text: report }) }], shellPaneId: null });
  const history = element<HTMLElement>(container, "[data-workflow-history]");
  expect(history.matches('ol[aria-label="Review rounds"]')).toBe(true);
  expect(history.textContent).not.toContain("Review history");

  const card = element<HTMLElement>(history, '[data-review-round="reviewer"]');
  expect(card.textContent).toContain("Reviewer round 1");
  expect(Array.from(card.querySelectorAll('[data-slot="badge"]'), badge => badge.textContent)).toEqual(["1 blocking finding", "Not approved"]);
  expect(card.textContent).not.toContain("Repair the task action.");
  expect(card.textContent).toContain("1 blocking finding");
  expect(card.querySelector("code")).toBeNull();
  expect(element<HTMLElement>(card, "time").getAttribute("datetime")).toBe(recordedAt);
  expect(card.textContent).not.toContain("The task action drops the answer.");
  expect(card.textContent).not.toContain("The focused checks passed.");
  expect(card.querySelector(".prose-suplex")).toBeNull();

  const toggle = element<HTMLButtonElement>(card, 'button[data-slot="history-trigger"]');
  expect(toggle.textContent).toContain("Show details for Reviewer round 1");
  expect(toggle.type).toBe("button");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await click(toggle);
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const detail = element<HTMLElement>(card, '[data-slot="history-content"]');
  expect(toggle.getAttribute("aria-controls")).toBe(detail.id);
  expect(detail.textContent).toContain("Repair the task action.");
  expect(element<HTMLElement>(detail, '[data-review-section="verification"] [data-slot="badge"]').textContent).toBe("Passed");
  expect(detail.textContent).toContain("The focused checks passed.");
  expect(element<HTMLElement>(detail, "ul li").textContent).toBe("The task action drops the answer.");
  expect(element<HTMLElement>(detail, ".prose-suplex h2").textContent).toBe("Repair plan");
  expect(element<HTMLElement>(detail, ".prose-suplex strong").textContent).toBe("answer");

  await click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(card.querySelector(".prose-suplex")).toBeNull();
});

test("an approved reviewer shows a passed badge instead of a blocking-finding count", async () => {
  const approved = { ...review, result: { ...review.result, approved: true, blockingFindings: [] } };
  const container = await mount([approved]);
  const card = element<HTMLElement>(container, '[data-review-round="reviewer"]');
  expect(Array.from(card.querySelectorAll('[data-slot="badge"]'), badge => badge.textContent)).toEqual(["Passed", "Approved"]);
  expect(card.textContent).not.toContain("blocking finding");
});

test("an invalid reviewer keeps its round number and expands the destructive invalid reason", async () => {
  const invalid = { ...review, turnId: "review-2", result: null, invalidReason: "The report has no verification result." };
  const container = await mount([review, invalid]);
  const cards = container.querySelectorAll<HTMLElement>('[data-review-round="reviewer"]');
  const card = cards.item(1);
  expect(card.textContent).toContain("Reviewer round 2");
  expect(element<HTMLElement>(card, '[data-slot="badge"]').textContent).toBe("Invalid");
  expect(card.textContent).not.toContain(invalid.invalidReason);
  expect(card.querySelector('[data-slot="history-content"]')).toBeNull();
  await click(element<HTMLButtonElement>(card, 'button[data-slot="history-trigger"]'));
  const reason = element<HTMLElement>(card, '[data-slot="history-content"] p');
  expect(reason.textContent).toBe(invalid.invalidReason);
  expect(reason.classList.contains("text-destructive")).toBe(true);
});

test("a planner without a report has a compact row and no expand control", async () => {
  const container = await mount([], { sessions: [session], turns: [turn], shellPaneId: null }, "competing_plans");
  const card = element<HTMLElement>(container, '[data-plan-report="planner_a"]');
  expect(card.textContent).toContain("Plan A");
  expect(element<HTMLElement>(card, '[data-slot="badge"]').textContent).toBe("No report yet");
  expect(card.querySelector("button, [aria-expanded], [data-slot=history-content]")).toBeNull();
});

test("planner reports and the selected Worker assignment expand their complete Markdown", async () => {
  const report = "# Plan A summary\n\nUse the **existing** controls.";
  const assignment = "Worker instructions\n\nCoordinator plan:\nCombine the plans.\n\n## Checks\n\nRun the focused checks.";
  const worker = { ...session, id: "worker", advisorRole: null, label: "Worker" };
  const container = await mount([], {
    sessions: [session, worker],
    turns: [
      { ...turn, status: "completed", completedAt: recordedAt, result: JSON.stringify({ text: report }) },
      { ...turn, id: "build", sessionId: worker.id, prompt: assignment },
      { ...turn, id: "other-build", sessionId: worker.id, prompt: "Continue the task." },
    ], shellPaneId: null,
  }, "competing_plans");
  const plan = element<HTMLElement>(container, '[data-plan-report="planner_a"]');
  expect(element<HTMLElement>(plan, '[data-slot="badge"]').textContent).toBe("Report");
  expect(plan.textContent).not.toContain("Plan A summary");
  expect(plan.querySelector(".prose-suplex")).toBeNull();
  await click(element<HTMLButtonElement>(plan, "button"));
  expect(element<HTMLElement>(plan, ".prose-suplex h1").textContent).toBe("Plan A summary");
  expect(element<HTMLElement>(plan, ".prose-suplex strong").textContent).toBe("existing");

  expect(container.querySelectorAll("[data-synthesis-assignment]")).toHaveLength(1);
  const combined = element<HTMLElement>(container, "[data-synthesis-assignment]");
  expect(combined.textContent).toContain("Combined plan");
  expect(combined.textContent).not.toContain("Combine the plans.");
  expect(combined.querySelector(".prose-suplex")).toBeNull();
  await click(element<HTMLButtonElement>(combined, "button"));
  expect(element<HTMLElement>(combined, ".prose-suplex").textContent).toContain("Worker instructions");
  expect(element<HTMLElement>(combined, ".prose-suplex h2").textContent).toBe("Checks");
  expect(combined.textContent).toContain("Run the focused checks.");
});

test("a Rater report renders Markdown in each structured result field", async () => {
  const rater = {
    ...review,
    sessionId: "rater",
    turnId: "rating-1",
    role: "rater",
    result: {
      role: "rater",
      rating: 7,
      summary: "## Rating summary\n\nThe **core flow** works.\n\n- Keep the compact row",
      blockingFindings: ["### Lost state\n\nPreserve `answerText`.\n\n- Add a regression check"],
      verification: "passed",
      verificationSummary: "### Focused checks\n\nRan `pnpm test`.\n\n1. Unit tests passed",
    },
  } satisfies ReviewRecord;
  const container = await mount([rater], { sessions: [], turns: [], shellPaneId: null }, "refine_pull_request");
  const row = element<HTMLElement>(container, '[data-review-round="rater"]');
  expect(row.textContent).toContain("Rater round 1");
  expect(Array.from(row.querySelectorAll('[data-slot="badge"]'), badge => badge.textContent)).toEqual(["1 blocking finding", "7/10"]);
  expect(row.textContent).toContain("1 blocking finding");
  expect(row.textContent).not.toContain("Rating summary");

  await click(element<HTMLButtonElement>(row, 'button[data-slot="history-trigger"]'));
  const summary = element<HTMLElement>(row, '[data-review-section="summary"]');
  expect(element<HTMLElement>(summary, "h2").textContent).toBe("Rating summary");
  expect(element<HTMLElement>(summary, "strong").textContent).toBe("core flow");
  expect(element<HTMLElement>(summary, "li").textContent).toBe("Keep the compact row");

  const verification = element<HTMLElement>(row, '[data-review-section="verification"]');
  expect(element<HTMLElement>(verification, "h3").textContent).toBe("Focused checks");
  expect(element<HTMLElement>(verification, "code").textContent).toBe("pnpm test");
  expect(element<HTMLElement>(verification, "ol li").textContent).toBe("Unit tests passed");

  const findings = element<HTMLElement>(row, '[data-review-section="findings"]');
  expect(element<HTMLElement>(findings, "h3").textContent).toBe("Lost state");
  expect(element<HTMLElement>(findings, "code").textContent).toBe("answerText");
  expect(element<HTMLElement>(findings, ".prose-suplex li").textContent).toBe("Add a regression check");
});

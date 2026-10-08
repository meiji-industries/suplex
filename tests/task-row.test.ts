import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import type { Task } from "../src/frontend/contracts/tasks.js";
import { TaskRow } from "../src/frontend/features/tasks/tasks.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1",
  companyId: "company-1",
  projectId: "project-1",
  issue: null, artifacts: [], issueKey: "FOR-1",
  title: "Repair task links",
  description: "Keep task and pull request navigation separate.",
  status: "active",
  deliveryTarget: "pull_request_draft",
  rootProfile: profile,
  workerProfile: profile,
  workflow: "standard",
  advisorProfiles: {},
  workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: {
    repository: "meiji-industries/suplex",
    repositoryPath: "/repo",
    worktreeRoot: "/worktrees",
    branch: "fix/task-links",
    baseBranch: "main",
    baselineSha: "a".repeat(40),
    startingSha: "a".repeat(40),
    setupCommand: "",
    verificationCommand: "",
    runProjectTests: true,
    visualEvidence: "off",
    source: null,
    capturedAt: "2026-09-08T00:00:00.000Z",
  },
  worktree: null,
  pullRequest: {
    repository: "meiji-industries/suplex",
    number: 164,
    url: "https://github.com/meiji-industries/suplex/pull/164",
    headSha: "b".repeat(40),
    state: "open",
    mergedAt: null,
  },
  humanQuestion: null,
  blockedBy: [{ id: "task-0", title: "Prepare task links", status: "queued" }],
  queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] },
  limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 },
  wakeAt: null,
  images: [],
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  statusChangedAt: "2026-09-08T00:00:00.000Z",
  queuePriority: 0,
  dependsOn: [],
  archivedAt: null,
} satisfies Task;

test("task rows render sibling task and pull request links", () => {
  const html = renderToStaticMarkup(createElement(TaskRow, { task, project: undefined, cost: undefined }));
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>|<\/a>/g)];
  let anchorDepth = 0;

  for (const [tag] of links) {
    if (tag === "</a>") {
      anchorDepth -= 1;
    } else {
      expect(anchorDepth).toBe(0);
      anchorDepth += 1;
    }
  }

  expect(anchorDepth).toBe(0);
  expect(html).toContain("data-task-row");
  expect(html).not.toContain("Blocked by");
  expect(links.flatMap(match => match[1] ?? [])).toEqual([
    "/tasks/task-1?company=company-1",
    "https://github.com/meiji-industries/suplex/pull/164",
  ]);
});

test("task rows keep every field in column order", () => {
  const html = renderToStaticMarkup(createElement(TaskRow, { task, project: { id: "project-1", name: "Suplex" } as never, cost: undefined }));
  const order = ["data-task-title", "data-task-project", "data-task-status", "data-task-cost", "data-task-time", "data-task-compact-details", "data-task-pr"].map(attribute => html.indexOf(`${attribute}="true"`));

  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((left, right) => left - right));
  expect(html).toContain("FOR-1");
  expect(html).toContain("Repair task links");
  expect(html).toContain("Suplex");
  expect(html).toContain("data-task-compact-project");
  expect(html).toContain('dateTime="2026-09-08T00:00:00.000Z"');
  expect(html).toMatch(/<time data-task-time[^>]*class="[^"]*font-mono[^"]*tabular-nums/);
  expect(html).toContain(">Active<");
});

test("task rows dim the titles of delivered and cancelled tasks only", () => {
  // The title also carries type styles; only its colour depends on the status.
  const titleColour = (status: Task["status"]) => /class="truncate ([^"]+)">Repair task links</.exec(renderToStaticMarkup(createElement(TaskRow, { task: { ...task, status }, project: undefined, cost: undefined })))?.[1]?.split(" ").filter(name => name === "text-muted-foreground" || name === "text-foreground");

  expect(titleColour("delivered")).toEqual(["text-muted-foreground"]);
  expect(titleColour("cancelled")).toEqual(["text-muted-foreground"]);
  expect(titleColour("active")).toEqual(["text-foreground"]);
  expect(titleColour("waiting_human")).toEqual(["text-foreground"]);
});

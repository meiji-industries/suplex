import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import type { Task } from "../src/tasks/contracts.js";
import { TaskRow } from "../src/frontend/features/tasks/tasks.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1",
  companyId: "company-1",
  projectId: "project-1",
  issueKey: "FOR-1",
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
    repository: "meiji-industries/forge",
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
    repository: "meiji-industries/forge",
    number: 164,
    url: "https://github.com/meiji-industries/forge/pull/164",
    headSha: "b".repeat(40),
    state: "open",
    mergedAt: null,
  },
  humanQuestion: null,
  blockedBy: { id: "task-0", title: "Prepare task links", status: "backlog" },
  limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 },
  wakeAt: null,
  images: [],
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  statusChangedAt: "2026-09-08T00:00:00.000Z",
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
  expect(html).toContain("Blocked by Prepare task links · Backlog");
  expect(links.flatMap(match => match[1] ?? [])).toEqual([
    "/tasks/task-1?company=company-1",
    "https://github.com/meiji-industries/forge/pull/164",
  ]);
});

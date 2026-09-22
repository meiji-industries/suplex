// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Task } from "../src/tasks/contracts.js";

const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", () => api);

import { TaskWork, type TaskActivity } from "../src/frontend/features/tasks/task-work.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issueKey: null, title: "Show the diff count", description: "", status: "active", deliveryTarget: "pull_request_draft",
  rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "meiji-industries/forge", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "diff-count", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
  worktree: { path: "/worktrees/diff-count", branch: "diff-count", baseSha: "a".repeat(40), headSha: "b".repeat(40), dirty: true }, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { startIntent: "manual", state: "running", waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
  dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
} satisfies Task;

const activity = { sessions: [], turns: [], shellPaneId: null } satisfies TaskActivity;

function serve(summary: { available: boolean; files: number } | Error) {
  api.readJson.mockImplementation(async (url: string) => {
    if (typeof url !== "string") return {};
    if (url.endsWith("/diff/summary")) {
      if (summary instanceof Error) throw summary;
      return summary;
    }
    if (url.endsWith("/execution")) return { sessions: [] };
    if (url.endsWith("/timeline")) return { tasks: [], unavailableSessions: 0 };
    throw new Error(`Unexpected request: ${url}`);
  });
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root, render: async () => { await act(async () => { root.render(<TaskWork task={task} activity={activity} onChange={() => {}} onSelectWorker={() => {}} />); await Promise.resolve(); }); } };
}

function diffsTab(container: HTMLElement) {
  const value = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]')).find(candidate => candidate.textContent?.startsWith("Diffs"));
  if (!value) throw new Error("Diffs tab trigger was not rendered");
  return value;
}

afterEach(async () => { await act(async () => { document.body.replaceChildren(); }); });

beforeEach(() => api.readJson.mockReset());

test("the Diffs tab shows the changed-file count on any active tab without reading the patch", async () => {
  serve({ available: true, files: 2 });
  const view = mount();
  await view.render();
  expect(diffsTab(view.container).textContent).toBe("Diffs (2)");
  expect(view.container.querySelector('[data-task-work-tabs] [data-slot="tabs-trigger"]')?.textContent).toBe("Chat");
  expect(api.readJson).toHaveBeenCalledWith("/api/tasks/task-1/diff/summary");
  expect(api.readJson.mock.calls.some(([url]) => url === "/api/tasks/task-1/diff")).toBe(false);
});

test("the Diffs tab shows no count when the worktree is not available", async () => {
  serve({ available: false, files: 0 });
  const view = mount();
  await view.render();
  expect(diffsTab(view.container).textContent).toBe("Diffs");
});

test("a failed summary read leaves the Diffs label without a count", async () => {
  serve(new Error("The worktree diff could not be read"));
  const view = mount();
  await view.render();
  expect(diffsTab(view.container).textContent).toBe("Diffs");
});

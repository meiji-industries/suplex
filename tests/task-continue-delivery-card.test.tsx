// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "../src/tasks/contracts.js";

const state = vi.hoisted(() => ({ checks: { available: true, pullRequestState: "draft", runs: [] } as { available: boolean; pullRequestState: "draft" | "ready" | "merged"; runs: [] }, readJson: vi.fn() }));
vi.mock("../src/frontend/features/tasks/lib/task-checks.js", () => ({ useTaskChecks: () => ({ checks: state.checks }) }));
vi.mock("../src/frontend/lib/api.js", () => ({ readJson: state.readJson }));
import { TaskPullRequestCard } from "../src/frontend/features/tasks/pull-request-card.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issueKey: null, title: "Continue delivery", description: "", status: "delivered", deliveryTarget: "pull_request_draft",
  rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "meiji-industries/forge", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "continue", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
  worktree: null, pullRequest: { repository: "meiji-industries/forge", number: 247, url: "https://github.com/meiji-industries/forge/pull/247", headSha: "a".repeat(40), state: "merged", mergedAt: "2026-09-08T00:00:00.000Z" }, humanQuestion: null, blockedBy: [], queue: { waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [], dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
} satisfies Task;

const mounts: Array<{ unmount(): void }> = [];
afterEach(async () => { await act(async () => { mounts.splice(0).forEach(root => root.unmount()); document.body.replaceChildren(); }); });
beforeEach(() => { state.checks = { available: true, pullRequestState: "draft", runs: [] }; state.readJson.mockReset(); });

test("fresh draft and ready observations override a stale merged cache and wire continuation", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounts.push(root);
  const onChange = vi.fn();
  state.readJson.mockResolvedValue({ ...task, status: "active", deliveryTarget: "pull_request_ready" });
  await act(async () => { root.render(<TaskPullRequestCard task={task} onChange={onChange} />); });
  expect(container.textContent).toContain("Publish for review");
  expect(container.textContent).toContain("Continue to merge");
  await act(async () => { container.querySelector<HTMLButtonElement>("button")?.click(); });
  expect(state.readJson).toHaveBeenCalledWith("/api/tasks/task-1/continue-delivery", { method: "POST", body: JSON.stringify({ deliveryTarget: "pull_request_ready" }) });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "active", deliveryTarget: "pull_request_ready" }));

  state.checks = { available: true, pullRequestState: "ready", runs: [] };
  await act(async () => { root.render(<TaskPullRequestCard task={task} onChange={onChange} />); });
  expect(container.textContent).not.toContain("Publish for review");
  expect(container.textContent).toContain("Continue to merge");

  state.checks = { available: true, pullRequestState: "merged", runs: [] };
  await act(async () => { root.render(<TaskPullRequestCard task={task} onChange={onChange} />); });
  expect(container.textContent).not.toContain("Continue to merge");
  expect(container.textContent).toContain("Merged");

  state.checks = { available: false, pullRequestState: "merged", runs: [] };
  await act(async () => { root.render(<TaskPullRequestCard task={task} onChange={onChange} />); });
  expect(container.textContent).toContain("Publish for review");
});

test("missing pull request and checks still allow continuation, and a failed request can be retried", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounts.push(root);
  const onChange = vi.fn();
  const missing = { ...task, pullRequest: null };
  state.checks = { available: false, pullRequestState: "merged", runs: [] };
  state.readJson.mockRejectedValueOnce(new Error("GitHub did not answer")).mockResolvedValueOnce({ ...missing, status: "active", deliveryTarget: "merged" });
  await act(async () => { root.render(<TaskPullRequestCard task={missing} onChange={onChange} />); });
  expect(container.textContent).toContain("Publish for review");
  expect(container.textContent).toContain("Continue to merge");
  const merge = () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Continue to merge");
  await act(async () => { merge()?.click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("GitHub did not answer");
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => { merge()?.click(); });
  expect(state.readJson).toHaveBeenCalledTimes(2);
  expect(state.readJson).toHaveBeenLastCalledWith("/api/tasks/task-1/continue-delivery", { method: "POST", body: JSON.stringify({ deliveryTarget: "merged" }) });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "active", deliveryTarget: "merged" }));
  expect(container.querySelector('[role="alert"]')).toBeNull();

  await act(async () => { root.render(<TaskPullRequestCard task={{ ...task, deliveryTarget: "local_worktree" }} onChange={onChange} />); });
  expect(container.textContent).not.toContain("Continue to merge");
});

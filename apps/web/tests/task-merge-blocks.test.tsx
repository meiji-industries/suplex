// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Task } from "../contracts/tasks.js";
import type { TaskChecks } from "../features/tasks/lib/task-checks.js";

const state = vi.hoisted(() => ({ checks: null as unknown }));
vi.mock("../features/tasks/lib/task-checks.js", async (importOriginal) => ({ ...await importOriginal<object>(), useTaskChecks: () => ({ checks: state.checks }) }));
import { TaskPullRequestCard } from "../features/tasks/pull-request-card.js";
import { checkRunSummary } from "../features/tasks/lib/task-checks.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issue: null, artifacts: [], issueKey: null, title: "Blocked merge", description: "", status: "delivered", deliveryTarget: "pull_request_ready",
  rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "acme/demo", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "blocked", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
  worktree: null, pullRequest: { repository: "acme/demo", number: 12, url: "https://github.com/acme/demo/pull/12", headSha: "a".repeat(40), state: "open", mergedAt: null }, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [], dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null,
} satisfies Task;

const passed = (name: string) => ({ name, status: "successful" as const, url: null, conclusion: "SUCCESS" });
const runs: TaskChecks["runs"] = [passed("build"), passed("unit"), passed("lint"), { name: "Docs preview", status: "successful", url: null, conclusion: "SKIPPED" }];
const block = "Branch `main` requires signed commits and 2 commits are unsigned (abc1234, def5678).";

const mounts: Array<{ unmount(): void }> = [];
afterEach(async () => { await act(async () => { mounts.splice(0).forEach(root => root.unmount()); document.body.replaceChildren(); }); });

async function render(checks: TaskChecks): Promise<HTMLElement> {
  state.checks = checks;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounts.push(root);
  await act(async () => { root.render(<TaskPullRequestCard task={task} onChange={() => {}} />); });
  return container;
}

test("the checks summary counts skipped checks apart from passed and failed ones", () => {
  expect(checkRunSummary(runs)).toBe("3 passed, 1 skipped");
  expect(checkRunSummary([...runs, { name: "e2e", status: "failing", url: null, conclusion: "FAILURE" }])).toBe("3 passed, 1 skipped, 1 failed");
});

test("the pull request card names each merge block next to the checks summary", async () => {
  const container = await render({ available: true, pullRequestState: "ready", runs, mergeBlocks: [block] });
  expect(container.querySelector("[aria-label='Checks summary']")?.textContent).toBe("3 passed, 1 skipped");
  const blocks = container.querySelector("[aria-label='Merge blocks']");
  expect(blocks?.textContent).toContain("GitHub blocks the merge");
  expect(Array.from(blocks?.querySelectorAll("li") ?? [], item => item.textContent)).toEqual([block]);
  expect(container.querySelector("[aria-label='Pull request checks']")?.textContent).toContain("Skipped");
});

test("a pull request without a merge block shows no block and a merged one hides old blocks", async () => {
  const clean = await render({ available: true, pullRequestState: "ready", runs });
  expect(clean.querySelector("[aria-label='Merge blocks']")).toBeNull();
  const merged = await render({ available: true, pullRequestState: "merged", runs, mergeBlocks: [block] });
  expect(merged.querySelector("[aria-label='Merge blocks']")).toBeNull();
});

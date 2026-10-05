// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "sonner";
import type { Task } from "../src/frontend/contracts/tasks.js";
import { TaskOptions } from "../src/frontend/features/tasks/task-options.js";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../src/frontend/features/tasks/archive-task-dialog.js", () => ({ ArchiveTaskDialog: () => null }));
vi.mock("../src/frontend/features/tasks/new-task-dialog.js", () => ({ NewTaskDialog: () => null }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

test("copies the absolute URL of the task beside its options menu", async () => {
  const profile: Task["rootProfile"] = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" };
  const task: Task = {
    id: "task-url", title: "Copy this task", companyId: "company/a&b", projectId: "project", issueKey: null, issue: null, artifacts: [], description: "", status: "backlog", deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "task-url", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [], dependsOn: [],
    createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
  };
  window.history.replaceState({}, "", "/tasks/other-task?company=other-company");
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TaskOptions task={task} onChange={vi.fn()} onError={vi.fn()} />));
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy task URL"]')!;
    expect(copy.title).toBe("Copy task URL");
    expect(copy.nextElementSibling?.getAttribute("aria-label")).toBe("Task options");
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/tasks/task-url?company=company%2Fa%26b`);
    expect(toast.success).toHaveBeenCalledExactlyOnceWith("Copied the task URL to clipboard");
    expect(toast.error).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

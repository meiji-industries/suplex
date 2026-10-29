// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "sonner";
import type { Task } from "../contracts/tasks.js";
import { canSendToBacklog, TaskOptions } from "../features/tasks/task-options.js";
import { ArchiveTaskDialog } from "../features/tasks/archive-task-dialog.js";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../features/tasks/archive-task-dialog.js", () => ({ ArchiveTaskDialog: vi.fn(() => null) }));
vi.mock("../features/tasks/new-task-dialog.js", () => ({ NewTaskDialog: () => null }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function taskFixture(): Task {
  const profile: Task["rootProfile"] = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" };
  return {
    id: "task-url", title: "Copy this task", companyId: "company/a&b", projectId: "project", issueKey: null, issue: null, artifacts: [], description: "", status: "backlog", deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "task-url", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [], dependsOn: [],
    createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null,
  };
}

test("copies the absolute URL of the task beside its options menu", async () => {
  const task = taskFixture();
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

test("a background archive returns to the list only from the archived task page", async () => {
  const task = taskFixture();
  const onChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TaskOptions task={task} onChange={onChange} onError={vi.fn()} />));
    const onArchived = vi.mocked(ArchiveTaskDialog).mock.calls.findLast(([props]) => props.kind === undefined)![0].onArchived;
    const archived = { ...task, archivedAt: "2026-10-07T00:00:00.000Z" };

    window.history.replaceState({}, "", "/tasks/other-task?company=other-company");
    act(() => onArchived(archived));
    expect(onChange).toHaveBeenLastCalledWith(archived);
    expect(window.location.pathname).toBe("/tasks/other-task");

    window.history.replaceState({}, "", "/board/task-url?company=company%2Fa%26b");
    act(() => onArchived(archived));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/board?company=company%2Fa%26b");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Send to backlog shows for queued, active, waiting, cancelled, and archived tasks only", () => {
  const visible = (["backlog", "queued", "active", "waiting_human", "cancelled", "delivered"] as const).filter(status => canSendToBacklog({ status, archivedAt: null }));
  expect(visible).toEqual(["queued", "active", "waiting_human", "cancelled"]);
  for (const status of ["backlog", "delivered"] as const) expect(canSendToBacklog({ status, archivedAt: "2026-10-07T00:00:00.000Z" })).toBe(true);
});

test("a queued task leaves the queue at once, and other work asks before it starts fresh", async () => {
  const onChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ...taskFixture(), status: "backlog" }), { status: 200, headers: { "content-type": "application/json" } }));
  const openMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Task options"]')!;
    await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); trigger.click(); });
    return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === "Send to backlog");
  };
  try {
    await act(async () => root.render(<TaskOptions task={{ ...taskFixture(), status: "queued" }} onChange={onChange} onError={vi.fn()} />));
    await act(async () => (await openMenu())!.click());
    expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("/api/tasks/task-url/disarm"), expect.objectContaining({ method: "POST" }));
    expect(vi.mocked(ArchiveTaskDialog).mock.lastCall![0]).toMatchObject({ kind: "backlog", open: false });

    await act(async () => root.render(<TaskOptions task={{ ...taskFixture(), status: "active" }} onChange={onChange} onError={vi.fn()} />));
    await act(async () => (await openMenu())!.click());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ArchiveTaskDialog).mock.lastCall![0]).toMatchObject({ kind: "backlog", open: true, onArchived: onChange });

    await act(async () => root.render(<TaskOptions task={taskFixture()} onChange={onChange} onError={vi.fn()} />));
    expect(await openMenu()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

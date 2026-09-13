// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Task } from "../src/tasks/contracts.js";

const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", () => api);

import { TaskNoteInput } from "../src/frontend/features/tasks/task-work.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issueKey: null, title: "Repair task notes", description: "", status: "active", deliveryTarget: "pull_request_draft",
  rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "meiji-industries/forge", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "task-notes", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
  worktree: null, pullRequest: null, humanQuestion: null, blockedBy: null, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
  dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
} satisfies Task;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function textarea(container: HTMLElement) {
  const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Coordinator"]');
  if (!field) throw new Error("Message Coordinator textarea was not rendered");
  return field;
}

function setText(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(field: HTMLTextAreaElement) {
  field.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function pressEnter(field: HTMLTextAreaElement, options: KeyboardEventInit = {}, isComposing = false) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...options });
  if (isComposing) Object.defineProperty(event, "isComposing", { value: true });
  field.dispatchEvent(event);
  return event;
}

function mount(props: { task?: Task; onChange?: (next: Task) => void; strict?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = props.onChange ?? vi.fn();
  const render = (next = props.task ?? task) => root.render(props.strict ? <StrictMode><TaskNoteInput task={next} onChange={onChange} /></StrictMode> : <TaskNoteInput task={next} onChange={onChange} />);
  return { container, onChange, render, root };
}

async function render(renderComponent: () => void) {
  await act(async () => { renderComponent(); });
}

afterEach(async () => {
  await act(async () => { document.body.replaceChildren(); });
});

beforeEach(() => api.readJson.mockReset());

test("Shift+Enter keeps a multiline draft and Enter sends it once", async () => {
  api.readJson.mockResolvedValue(task);
  const view = mount();
  await render(view.render);
  const field = textarea(view.container);

  await act(async () => {
    setText(field, "First line");
    expect(pressEnter(field, { shiftKey: true }).defaultPrevented).toBe(false);
    setText(field, "First line\nSecond line");
  });
  expect(api.readJson).not.toHaveBeenCalled();
  expect(field.value).toBe("First line\nSecond line");

  await act(async () => { expect(pressEnter(field).defaultPrevented).toBe(true); await Promise.resolve(); });
  expect(api.readJson).toHaveBeenCalledTimes(1);
  expect(api.readJson).toHaveBeenCalledWith("/api/tasks/task-1/note", { method: "POST", body: JSON.stringify({ note: "First line\nSecond line" }) });
});

test("composition Enter does not submit the task note", async () => {
  const view = mount();
  await render(view.render);
  const field = textarea(view.container);

  await act(async () => {
    setText(field, "Composing");
    expect(pressEnter(field, {}, true).defaultPrevented).toBe(false);
  });
  expect(api.readJson).not.toHaveBeenCalled();
});

test("official PromptInput keeps an edit made during a delayed successful note submission", async () => {
  const accepted = deferred<Task>();
  api.readJson.mockReturnValueOnce(accepted.promise);
  const view = mount({ strict: true });
  await render(view.render);
  const field = textarea(view.container);

  await act(async () => { setText(field, "First draft"); });
  await act(async () => { submit(field); await Promise.resolve(); });
  expect(api.readJson).toHaveBeenCalledTimes(1);
  expect(field.value).toBe("First draft");

  await act(async () => { setText(field, "Edited while Coordinator works"); });
  await act(async () => { accepted.resolve(task); await accepted.promise; });
  expect(view.onChange).toHaveBeenCalledWith(task);
  expect(field.value).toBe("Edited while Coordinator works");
});

test("two form submissions before React rerenders send once, retain a failed draft, and allow retry", async () => {
  const rejected = deferred<Task>();
  api.readJson.mockReturnValueOnce(rejected.promise).mockResolvedValueOnce(task);
  const view = mount();
  await render(view.render);
  const field = textarea(view.container);

  await act(async () => { setText(field, "Retry this message"); });
  await act(async () => { submit(field); submit(field); await Promise.resolve(); });
  expect(api.readJson).toHaveBeenCalledTimes(1);
  expect(field.value).toBe("Retry this message");

  await act(async () => { rejected.reject(new Error("Coordinator is not ready")); await Promise.resolve(); });
  expect(view.container.textContent).toContain("Coordinator is not ready");
  expect(field.value).toBe("Retry this message");

  await act(async () => { submit(field); await Promise.resolve(); });
  expect(api.readJson).toHaveBeenCalledTimes(2);
  expect(view.onChange).toHaveBeenCalledWith(task);
  expect(field.value).toBe("");
});

test("a response for a task replaced during submission does not update the current task", async () => {
  const accepted = deferred<Task>();
  api.readJson.mockReturnValueOnce(accepted.promise);
  const view = mount();
  await render(view.render);
  const field = textarea(view.container);
  await act(async () => { setText(field, "Do not apply after navigation"); submit(field); await Promise.resolve(); });
  await render(() => view.render({ ...task, id: "task-2" }));

  await act(async () => { accepted.resolve(task); await accepted.promise; });
  expect(view.onChange).not.toHaveBeenCalled();
});

test("an unmounted composer does not apply a late accepted response", async () => {
  const accepted = deferred<Task>();
  api.readJson.mockReturnValueOnce(accepted.promise);
  const view = mount();
  await render(view.render);
  const field = textarea(view.container);
  await act(async () => { setText(field, "Do not apply after unmount"); submit(field); await Promise.resolve(); });
  await act(async () => { view.root.unmount(); });

  await act(async () => { accepted.resolve(task); await accepted.promise; });
  expect(view.onChange).not.toHaveBeenCalled();
});

 test("a delivered task accepts a follow-up message and explains that it resumes work", async () => {
  api.readJson.mockResolvedValueOnce(task);
  const view = mount({ task: { ...task, status: "delivered" } });
  await render(view.render);
  expect(view.container.textContent).toContain("Send a message to resume this task.");
  const field = textarea(view.container);
  await act(async () => { setText(field, "Fix the failing checks"); submit(field); });
  expect(api.readJson).toHaveBeenCalledWith("/api/tasks/task-1/note", expect.objectContaining({ method: "POST", body: JSON.stringify({ note: "Fix the failing checks" }) }));
  expect(view.onChange).toHaveBeenCalledWith(task);
});

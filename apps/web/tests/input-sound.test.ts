/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TaskListTask } from "../contracts/task-responses.js";
import { createInputSound, inputSoundStorageKey, parseInputSound, readInputSound, saveInputSound, tasksEnteringInput } from "../features/tasks/lib/input-sound.js";

function task(id: string, status: TaskListTask["status"]): TaskListTask {
  return {
    id, companyId: "company-a", projectId: "project", issueKey: null, title: id, status, configuration: { repository: "owner/repo", branch: id },
    pullRequest: null, humanQuestion: null, blockedBy: [], queue: { planConcurrencyLimited: false, projectConcurrencyLimited: false, waitingOn: [] }, dependsOn: [],
    createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null,
  };
}
const notAllowed = (): Promise<void> => Promise.reject(new DOMException("The user did not interact with the page.", "NotAllowedError"));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("a snapshot never reports a task, and a changes frame reports each entry into waiting_human", () => {
  const working = [task("a", "active"), task("b", "waiting_human")];
  const waiting = [task("a", "waiting_human"), task("b", "waiting_human")];
  expect(tasksEnteringInput("snapshot", working, waiting)).toEqual([]);
  expect(tasksEnteringInput("snapshot", undefined, waiting)).toEqual([]);
  expect(tasksEnteringInput("changes", working, waiting)).toEqual(["a"]);
  // A frame that repeats the waiting state does not report it again.
  expect(tasksEnteringInput("changes", waiting, waiting)).toEqual([]);
  // A task that leaves and enters again is reported again.
  const answered = [task("a", "active"), task("b", "waiting_human")];
  expect(tasksEnteringInput("changes", waiting, answered)).toEqual([]);
  expect(tasksEnteringInput("changes", answered, waiting)).toEqual(["a"]);
  // A task that a changes frame adds in waiting_human was not waiting on this page before.
  expect(tasksEnteringInput("changes", working, [...working, task("c", "waiting_human")])).toEqual(["c"]);
  // Without a cached list, the frame changes nothing.
  expect(tasksEnteringInput("changes", undefined, waiting)).toEqual([]);
});

test("the setting is on by default and keeps the saved value per device", () => {
  expect(parseInputSound(null)).toBe(true);
  expect(parseInputSound("invalid")).toBe(true);
  expect(parseInputSound("on")).toBe(true);
  expect(parseInputSound("off")).toBe(false);
  expect(readInputSound()).toBe(true);
  expect(saveInputSound(false)).toBe(false);
  expect(stored.get(inputSoundStorageKey)).toBe("off");
  expect(readInputSound()).toBe(false);
  saveInputSound(true);
  expect(readInputSound()).toBe(true);
});

test("storage errors use the default and do not throw", () => {
  const disabled = () => { throw new Error("disabled"); };
  vi.stubGlobal("localStorage", { getItem: disabled, setItem: disabled });
  expect(readInputSound()).toBe(true);
  expect(saveInputSound(false)).toBe(false);
});

test("the sound does not play when the setting is off", async () => {
  const play = vi.fn(() => Promise.resolve());
  saveInputSound(false);
  createInputSound(play)();
  await settle();
  expect(play).not.toHaveBeenCalled();
  saveInputSound(true);
  createInputSound(play)();
  expect(play).toHaveBeenCalledTimes(1);
});

test("a refused sound plays once on the next interaction", async () => {
  const target = new EventTarget();
  const play = vi.fn(notAllowed);
  const sound = createInputSound(play, () => true, target);
  sound(); sound();
  await settle();
  expect(play).toHaveBeenCalledTimes(2);
  play.mockImplementation(() => Promise.resolve());
  target.dispatchEvent(new Event("keydown"));
  target.dispatchEvent(new Event("pointerdown"));
  target.dispatchEvent(new Event("keydown"));
  expect(play).toHaveBeenCalledTimes(3);

  // A retry that fails again does not wait for a further interaction.
  play.mockImplementation(notAllowed);
  sound();
  await settle();
  target.dispatchEvent(new Event("pointerdown"));
  await settle();
  target.dispatchEvent(new Event("pointerdown"));
  expect(play).toHaveBeenCalledTimes(5);
});

test("other playback errors are swallowed without a retry", async () => {
  const target = new EventTarget();
  const play = vi.fn(() => Promise.reject(new DOMException("No source.", "NotSupportedError")));
  createInputSound(play, () => true, target)();
  await settle();
  target.dispatchEvent(new Event("pointerdown"));
  expect(play).toHaveBeenCalledTimes(1);
});

test("a retry does not play when the setting is off by then", async () => {
  const target = new EventTarget();
  let enabled = true;
  const play = vi.fn(notAllowed);
  createInputSound(play, () => enabled, target)();
  await settle();
  enabled = false;
  target.dispatchEvent(new Event("pointerdown"));
  expect(play).toHaveBeenCalledTimes(1);
});

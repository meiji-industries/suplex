// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { TaskSetup } from "../src/frontend/contracts/generated/TaskSetup.js";
import type { TaskActivityResponse } from "../src/frontend/contracts/generated/TaskActivityResponse.js";
import { LivePaneDock } from "../src/frontend/features/tasks/task-chat/live-pane-dock.js";
import { RecentTaskAgents } from "../src/frontend/features/tasks/recent-task-agents.js";
import { readTaskSetupLog } from "../src/frontend/features/tasks/lib/task-api.js";

vi.mock("../src/frontend/features/tasks/lib/task-api.js", () => ({ readTaskSetupLog: vi.fn() }));
vi.mock("../src/frontend/features/tasks/task-chat/live-pane-terminal.js", () => ({ LivePaneTerminal: () => null }));
vi.mock("../src/frontend/features/tasks/task-chat/session-history.js", () => ({ SessionHistory: () => null }));

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.clearAllMocks(); });

async function mount(setup: TaskSetup, shellPaneId: string | null = null) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: TaskSetup) => {
    const activity: TaskActivityResponse = { setup: next, sessions: [], turns: [], shellPaneId };
    await act(async () => { root.render(<><LivePaneDock taskId="task" activity={activity} /><RecentTaskAgents agents={[]} setup={next} /></>); });
  };
  cleanup = async () => { await act(async () => { root.unmount(); }); container.remove(); };
  await render(setup);
  return { container, render };
}

test("setup appears before a session, updates output, and keeps the failed log", async () => {
  vi.useFakeTimers();
  const running: TaskSetup = { state: "running", exitStatus: null };
  const failed: TaskSetup = { state: "failed", exitStatus: "7" };
  vi.mocked(readTaskSetupLog).mockResolvedValueOnce({ setup: running, output: "dump starts\n" }).mockResolvedValue({ setup: failed, output: "dump starts\ndump failed\n" });
  const { container, render } = await mount(running);
  expect(container.querySelector('[role="tab"]')?.textContent).toBe("Setup");
  expect(container.querySelector("pre")?.textContent).toBe("dump starts\n");
  expect(container.querySelector('[data-setup-state="running"]')?.textContent).toBe("Setup · Working");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(container.querySelector("pre")?.textContent).toBe("dump starts\ndump failed\n");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Setup failed with exit status 7.");
  const reads = vi.mocked(readTaskSetupLog).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(readTaskSetupLog).toHaveBeenCalledTimes(reads);
  await render(failed);
  expect(container.querySelector("[data-setup-state]")).toBeNull();
  expect(container.querySelector("pre")?.textContent).toContain("dump failed");
});

test("completed setup loads from disk, follows Shell, and leaves the card", async () => {
  const setup: TaskSetup = { state: "succeeded", exitStatus: "0" };
  vi.mocked(readTaskSetupLog).mockResolvedValue({ setup, output: "setup finished\n" });
  const { container } = await mount(setup, "shell");
  const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  expect(tabs.map(tab => tab.textContent)).toEqual(["Shell", "Setup"]);
  await act(async () => { tabs[1]!.click(); });
  expect(container.querySelector("pre")?.textContent).toBe("setup finished\n");
  expect(container.querySelector("[data-setup-state]")).toBeNull();
});

test("no setup and no sessions leave the dock and card empty", async () => {
  const { container } = await mount({ state: "none", exitStatus: null });
  expect(container.innerHTML).toBe("");
  expect(readTaskSetupLog).not.toHaveBeenCalled();
});

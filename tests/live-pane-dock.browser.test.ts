import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

const narrowViewport = 390;

test("live panes support mounting, resizing, switching, and reconnect status", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(narrowViewport);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Live pane restoration", description: "Watch the agent work.", startImmediately: true, idempotencyKey: "live-dock" });
    const store = value.tasks.repository.controls;
    const root = store.claimRoot({ taskId: task.id });
    store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_dock_root" });
    const { page } = value;
    page.setDefaultTimeout(10_000);
    await page.routeWebSocket(/\/pane\/.*\/terminal/, socket => {
      socket.send(JSON.stringify({ type: "open" }));
      socket.send(Buffer.from("\x1b[32mLive agent output\x1b[0m\r\nInspecting the task worktree...\r\n"));
    });
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: task.title, level: 2, exact: true }).waitFor();
    const dock = page.getByRole("region", { name: "Live agent output", exact: true });
    expect(await dock.count()).toBe(0);
    store.bindPane({ sessionId: root.id, generation: root.generation, paneId: "wProof:p1" });
    await dock.waitFor();
    await dock.locator(".xterm-screen").waitFor();
    const terminalHost = dock.getByLabel("Live pane output for root", { exact: true });
    const terminalSurface = terminalHost.locator(".xterm-screen");
    const slider = dock.getByRole("slider", { name: "Resize live agent output" });
    await slider.focus();
    await slider.press("ArrowUp");
    expect(await slider.getAttribute("aria-valuenow")).toBe("344");
    await page.reload();
    await dock.waitFor();
    await dock.locator(".xterm-screen").waitFor();
    expect(await slider.getAttribute("aria-valuenow")).toBe("344");
    const worker = store.launchWorker({ taskId: task.id, rootSessionId: root.id, rootGeneration: root.generation, instruction: "Verify the dock" });
    store.bindHarnessSession({ sessionId: worker.id, generation: worker.generation, nativeSessionId: "ses_dock_worker" });
    store.bindPane({ sessionId: worker.id, generation: worker.generation, paneId: "wProof:p2" });
    const workerTab = dock.getByRole("tab", { name: "Worker", exact: true });
    await workerTab.click();
    const workerHost = dock.getByLabel("Live pane output for worker", { exact: true });
    await workerHost.waitFor();
    await workerHost.locator(".xterm-screen").waitFor();
    await dock.getByRole("tab", { name: "Coordinator", exact: true }).click();
    await terminalHost.waitFor();
    await terminalSurface.waitFor();
    await page.routeWebSocket(/\/pane\/.*\/terminal/, socket => socket.close({ code: 1011, reason: "Connection lost" }));
    await page.reload();
    const reconnecting = page.getByRole("status").filter({ hasText: "Reconnecting" });
    await reconnecting.waitFor();
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

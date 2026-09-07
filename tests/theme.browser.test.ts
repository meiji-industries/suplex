import { expect, test } from "vitest";

import { nativeBrowser } from "./helpers/native-browser.js";

const desktopViewport = 1280;

test("theme follows the OS, persists a keyboard toggle, and syncs tabs", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  const { page } = value;
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${value.base}/profile?company=${value.company.id}`);
    const useLight = page.getByRole("button", { name: "Use light theme", exact: true });
    await useLight.waitFor();
    expect(await page.locator("html").getAttribute("class")).toContain("dark");
    expect(await page.evaluate(() => ({ preference: localStorage.getItem("forge.theme"), scheme: document.documentElement.style.colorScheme }))).toEqual({ preference: null, scheme: "dark" });
    await useLight.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Use dark theme", exact: true }).waitFor();
    expect(await page.evaluate(() => localStorage.getItem("forge.theme"))).toBe("light");
    expect(await page.locator("html").evaluate(element => element.classList.contains("dark"))).toBe(false);
    await page.reload();
    await page.getByRole("button", { name: "Use dark theme", exact: true }).waitFor();
    expect(await page.locator("html").evaluate(element => element.classList.contains("dark"))).toBe(false);

    const otherPage = await page.context().newPage();
    await otherPage.emulateMedia({ colorScheme: "dark" });
    await otherPage.goto(`${value.base}/profile?company=${value.company.id}`);
    await otherPage.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await expect.poll(() => page.locator("html").getAttribute("class")).toContain("dark");
    await otherPage.close();

    await page.evaluate(() => localStorage.removeItem("forge.theme"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await page.getByRole("button", { name: "Use dark theme", exact: true }).waitFor();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("button", { name: "Use light theme", exact: true }).waitFor();

    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("theme follows the OS and remains interactive when browser storage is disabled", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    await value.page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error("Storage disabled"); };
      Storage.prototype.setItem = () => { throw new Error("Storage disabled"); };
    });
    await value.page.emulateMedia({ colorScheme: "dark" });
    await value.page.goto(`${value.base}/profile?company=${value.company.id}`);
    const useLight = value.page.getByRole("button", { name: "Use light theme", exact: true });
    await useLight.waitFor();
    expect(await value.page.locator("html").evaluate(element => element.classList.contains("dark"))).toBe(true);
    await useLight.click();
    await value.page.getByRole("button", { name: "Use dark theme", exact: true }).waitFor();
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("changing the app theme preserves the live terminal connection and element", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    await value.page.emulateMedia({ colorScheme: "light" });
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Theme terminal", description: "Keep the session connected.", startImmediately: true, idempotencyKey: "theme-terminal" });
    const store = value.tasks.repository.controls;
    const root = store.claimRoot({ taskId: task.id });
    store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_theme_terminal" });
    store.bindPane({ sessionId: root.id, generation: root.generation, paneId: "theme:p1" });
    let connections = 0;
    await value.page.routeWebSocket(/\/pane\/.*\/terminal/, socket => {
      connections += 1;
      socket.send(JSON.stringify({ type: "open" }));
      socket.send(Buffer.from("Theme-safe output\r\n"));
    });
    await value.page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    const screen = value.page.locator(".xterm-screen");
    await screen.waitFor();
    const marker = await screen.elementHandle();
    expect(marker).not.toBeNull();
    await marker!.evaluate(element => element.setAttribute("data-theme-test", "preserved"));
    await value.page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await expect.poll(() => value.page.locator("html").getAttribute("class")).toContain("dark");
    expect(connections).toBe(1);
    expect(await marker!.getAttribute("data-theme-test")).toBe("preserved");
    expect(await marker!.evaluate(element => element.isConnected)).toBe(true);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

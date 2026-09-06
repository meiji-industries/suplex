import { expect, test } from "vitest";

import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("theme follows the OS, persists a keyboard toggle, syncs tabs, and keeps dialogs readable at %ipx", { timeout: 90_000 }, async width => {
  const value = await nativeBrowser(width);
  const { page } = value;
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${value.base}/profile?company=${value.company.id}`);
    const useLight = page.getByRole("button", { name: "Use light theme", exact: true });
    await useLight.waitFor();
    expect(await page.locator("html").getAttribute("class")).toContain("dark");
    expect(await page.evaluate(() => ({ preference: localStorage.getItem("forge.theme"), scheme: document.documentElement.style.colorScheme }))).toEqual({ preference: null, scheme: "dark" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const health = page.getByRole("button", { name: /^System health:/ });
    await health.waitFor();
    const themeBounds = await useLight.boundingBox();
    const healthBounds = await health.boundingBox();
    expect(themeBounds).not.toBeNull();
    expect(healthBounds).not.toBeNull();
    expect(themeBounds!.x).toBeLessThan(healthBounds!.x);
    await health.click();
    const healthDialog = page.getByRole("dialog", { name: "System health", exact: true });
    await healthDialog.waitFor();
    expect(await healthDialog.evaluate(element => getComputedStyle(element).colorScheme)).toBe("dark");
    await page.screenshot({ path: `/tmp/forge-dark-mode-dark-${width}.png`, fullPage: true, animations: "disabled" });
    await healthDialog.getByRole("button", { name: "Close", exact: true }).click();

    await useLight.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Use dark theme", exact: true }).waitFor();
    expect(await page.evaluate(() => localStorage.getItem("forge.theme"))).toBe("light");
    expect(await page.locator("html").evaluate(element => element.classList.contains("dark"))).toBe(false);
    await page.reload();
    await page.getByRole("button", { name: "Use dark theme", exact: true }).waitFor();
    expect(await page.locator("html").evaluate(element => element.classList.contains("dark"))).toBe(false);
    await page.screenshot({ path: `/tmp/forge-dark-mode-light-${width}.png`, fullPage: true, animations: "disabled" });

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

    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    const taskDialog = page.getByRole("dialog");
    await taskDialog.waitFor();
    expect(await taskDialog.evaluate(element => getComputedStyle(element).colorScheme)).toBe("dark");
    expect(await taskDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/forge-dark-mode-new-task-${width}.png`, fullPage: true, animations: "disabled" });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("theme follows the OS and remains interactive when browser storage is disabled", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(1280);
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
    expect(await value.page.locator('meta[name="theme-color"]').getAttribute("content")).toBe("#0a0a0a");
    await useLight.click();
    await value.page.getByRole("button", { name: "Use dark theme", exact: true }).waitFor();
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("changing the app theme preserves the live terminal connection and element", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(1280);
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
    const renderedTerminalBackground = async (): Promise<string> => {
      const imageUrl = `data:image/png;base64,${(await screen.screenshot({ animations: "disabled" })).toString("base64")}`;
      return value.page.evaluate(async (source) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas context is not available");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        const counts = new Map<string, number>();
        for (let index = 0; index < pixels.length; index += 16) {
          const color = `rgb(${pixels[index]}, ${pixels[index + 1]}, ${pixels[index + 2]})`;
          counts.set(color, (counts.get(color) ?? 0) + 1);
        }
        let dominant = "";
        let count = 0;
        for (const [color, occurrences] of counts) if (occurrences > count) { dominant = color; count = occurrences; }
        return dominant;
      }, imageUrl);
    };
    const lightTerminalBackground = await renderedTerminalBackground();
    expect(lightTerminalBackground).toBe("rgb(255, 255, 255)");
    await value.page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await expect.poll(() => value.page.locator("html").getAttribute("class")).toContain("dark");
    const darkTerminalBackground = await renderedTerminalBackground();
    expect(darkTerminalBackground).toBe("rgb(10, 10, 10)");
    expect(darkTerminalBackground).not.toBe(lightTerminalBackground);
    expect(connections).toBe(1);
    expect(await marker!.getAttribute("data-theme-test")).toBe("preserved");
    expect(await marker!.evaluate(element => element.isConnected)).toBe(true);
    await value.page.screenshot({ path: "/tmp/forge-dark-mode-terminal-1280.png", fullPage: true, animations: "disabled" });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

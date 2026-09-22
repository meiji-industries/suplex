import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}/vite.config.ts`,
  server: { host: "127.0.0.1", port: 0, strictPort: true },
});
const errors = [];
let browser;
let pagesChecked = 0;
let workflowsChecked = 0;

try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/docs/mockups/dependency-setup/`;
  browser = await chromium.launch();

  for (const width of [1280, 760, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(`${width}px: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${width}px: ${message.text()}`);
    });
    await page.route("**/api/**", (route) => {
      errors.push(`Mockup attempted an API request: ${route.request().url()}`);
      return route.abort();
    });

    for (const file of ["index.html", "01-desktop-not-available.html", "02-setup.html", "03-in-app-banner.html", "04-host-health.html"]) {
      await page.goto(`${base}${file}`);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const dimensions = await page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      assert.ok(dimensions.content <= dimensions.viewport, `${file} overflows at ${width}px: ${dimensions.content}px`);
      const preview = await page.locator(".preview").boundingBox();
      const controls = await page.locator(".preview button:visible, .preview a:visible, .preview input:visible").evaluateAll((elements) => elements.map((element) => {
        const { left, right } = element.getBoundingClientRect();
        return { label: element.getAttribute("aria-label") ?? element.textContent, left, right };
      }));
      for (const control of controls) assert.ok(control.left >= preview.x - 1 && control.right <= preview.x + preview.width + 1, `${file} clips ${control.label} at ${width}px`);
      assert.deepEqual(errors, [], `${file} has browser errors`);
      pagesChecked += 1;
    }
    await page.getByRole("button", { name: "Dark theme", exact: true }).click();
    assert.ok(await page.locator("html").evaluate((element) => element.classList.contains("dark")));
    await page.getByRole("button", { name: "Light theme", exact: true }).click();
    assert.ok(await page.locator("html").evaluate((element) => !element.classList.contains("dark")));
    for (const previewWidth of ["760", "390", "Desktop"]) {
      const control = page.getByRole("button", { name: previewWidth, exact: true });
      await control.click();
      assert.equal(await control.getAttribute("aria-pressed"), "true");
      if (previewWidth !== "Desktop") assert.ok((await page.locator(".preview").boundingBox()).width <= Number(previewWidth));
    }
    workflowsChecked += 1;

    await page.goto(`${base}02-setup.html`);
    const panel = page.getByRole("region", { name: "Selected check", exact: true });
    const next = page.getByRole("link", { name: "Continue", exact: true });
    await next.waitFor();
    // Continue never gates: it links to the task list in every state.
    assert.equal(await next.getAttribute("href"), "03-in-app-banner.html");
    await page.getByText("2 of 4 ready", { exact: true }).waitFor();
    const git = page.getByRole("button", { name: /^Git Save code changes/ });
    await git.click();
    assert.equal(await git.getAttribute("aria-pressed"), "true");
    await panel.getByRole("heading", { name: "Git is ready", exact: true }).waitFor();
    const optional = page.getByRole("button", { name: /^Optional tools/ });
    await optional.click();
    assert.equal(await optional.getAttribute("aria-expanded"), "true");
    await page.getByRole("button", { name: /^GitHub CLI Publish pull requests/ }).click();
    await panel.getByText("gh auth login", { exact: true }).waitFor();
    await optional.click();
    assert.equal(await optional.getAttribute("aria-expanded"), "false");
    await page.getByRole("button", { name: /^OpenCode Run tasks with OpenCode/ }).click();
    await panel.getByText("opencode auth login", { exact: true }).waitFor();
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { globalThis.copiedCommand = value; } } }));
    const copy = panel.getByRole("button", { name: "Copy the command", exact: true });
    await copy.click();
    assert.equal(await page.evaluate(() => globalThis.copiedCommand), "opencode auth login");
    assert.equal(await copy.innerText(), "Copied");
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Clipboard permission denied"); }; });
    await copy.click();
    await panel.getByRole("status").getByText("Suplex cannot copy the command. Select the command and copy it manually.", { exact: true }).waitFor();
    assert.equal(await copy.innerText(), "Copy", "A failed copy must not claim success");
    for (const [ready, command] of [[3, "curl -fsSL https://herdr.dev/install.sh | sh"], [3, "herdr"], [4, null]]) {
      await panel.getByRole("button", { name: "Check again", exact: true }).click();
      const checking = panel.getByRole("button", { name: /Check in progress/ });
      await checking.waitFor();
      assert.ok(await checking.isDisabled(), "Checking must disable duplicate checks");
      await checking.waitFor({ state: "hidden" });
      await page.getByText(`${ready} of 4 ready`, { exact: true }).waitFor();
      // Continue stays a live link in every state; the completed run keeps the marker query.
      assert.equal(await next.getAttribute("href"), ready < 4 ? "03-in-app-banner.html" : "03-in-app-banner.html?state=ready");
      if (command) await panel.getByText(command, { exact: true }).waitFor();
    }
    const details = page.getByRole("button", { name: "Technical details", exact: true }).first();
    await details.click();
    assert.equal(await details.getAttribute("aria-expanded"), "true", "Technical details must expand");
    await details.click();
    assert.equal(await details.getAttribute("aria-expanded"), "false", "Technical details must collapse");
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
    assert.equal(await page.getByText("Herdr stopped on your host", { exact: true }).count(), 0, "Completed setup must open tasks without the stopped-Herdr alert");
    workflowsChecked += 1;

    await page.goto(`${base}04-host-health.html`);
    const activePanel = page.locator('[role="tabpanel"]:not([hidden])');
    const attention = page.getByRole("tab", { name: /^Attention/ });
    await attention.click();
    assert.equal(await attention.getAttribute("aria-selected"), "true");
    assert.equal(await activePanel.getByText("Git", { exact: true }).count(), 0, "Attention must hide healthy Git");
    await page.getByRole("tab", { name: /^All/ }).click();
    await activePanel.getByText("Git", { exact: true }).waitFor();
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await refresh.click();
    await page.getByRole("status").getByText("Suplex checks the sample host.", { exact: true }).waitFor();
    assert.ok(await refresh.isDisabled(), "Refresh must disable duplicate checks");
    await page.getByRole("status").getByText("Sample checks refreshed just now", { exact: true }).waitFor();
    assert.ok(await refresh.isEnabled());
    workflowsChecked += 1;
    assert.deepEqual(errors, [], `Interaction errors at ${width}px`);
    await context.close();
  }

  console.log(`Passed ${pagesChecked} page/viewport checks and ${workflowsChecked} interaction workflows; no browser errors.`);
} finally {
  await browser?.close();
  await server.close();
}

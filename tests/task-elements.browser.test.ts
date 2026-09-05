import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import type { TaskExecution } from "../src/task-execution-contracts.js";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("task elements show native tools, Root plan and GitHub checks at %ipx", { timeout: 60_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Inspect agent work", description: "Preserve the live panes and task controls.", startImmediately: false, idempotencyKey: "elements" });
    let execution: TaskExecution = { sessions: [{ id: "root", role: "root", generation: 1, available: true, limited: false,
      plan: [{ content: "Inspect the requested scope", status: "completed" }, { content: "Verify worker output independently", status: "in_progress" }],
      tools: [{ id: "call_read", name: "read", status: "running", input: { filePath: "README.md" }, output: null, error: null }],
    }, { id: "worker", role: "worker", generation: 1, available: true, limited: true, plan: [{ content: "Worker plan must not replace Root", status: "pending" }], tools: [{ id: "call_test", name: "bash", status: "error", input: { command: "pnpm test" }, output: null, error: "Expected 2, received 1" }] }] };
    const { page } = value;
    await page.route(`**/api/tasks/${task.id}/execution`, route => route.fulfill({ json: execution }));
    await page.route(`**/api/tasks/${task.id}/checks`, route => route.fulfill({ json: { available: true, runs: [
      { name: "Unit tests", status: "successful", conclusion: "SUCCESS", url: "https://github.com/owner/repo/actions/runs/1" },
      { name: "Browser tests", status: "failing", conclusion: "FAILURE", url: "https://github.com/owner/repo/actions/runs/2" },
      { name: "Deploy", status: "pending", url: null },
      { name: "Optional checks", status: "successful", conclusion: "SKIPPED", url: null },
      { name: "Informational check", status: "successful", conclusion: "NEUTRAL", url: null },
    ] } }));
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await page.getByRole("region", { name: "Root plan", exact: true }).getByText("Verify worker output independently").waitFor();
    expect(await page.getByText("Worker plan must not replace Root").count()).toBe(0);
    await page.getByRole("button", { name: "Toggle plan" }).click();
    await page.getByText("Verify worker output independently").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Toggle plan" }).click();
    await page.getByText("Verify worker output independently").waitFor();
    await page.screenshot({ path: join(tmpdir(), `forge-elements-plan-${width}.png`) });
    await page.getByRole("tab", { name: /Activity/ }).click();
    await page.getByText("Expected 2, received 1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "read Running", exact: true }).click();
    await page.getByText('"README.md"', { exact: true }).first().waitFor();
    execution = { sessions: execution.sessions.map(session => ({ ...session, tools: session.tools.map(tool => tool.id === "call_read" ? { ...tool, status: "completed", output: "Current README content" } : tool) })) };
    await page.getByRole("button", { name: "read Completed", exact: true }).waitFor();
    await page.getByText("Current README content", { exact: true }).first().waitFor();
    await page.screenshot({ path: join(tmpdir(), `forge-elements-tools-${width}.png`) });
    await page.getByRole("tab", { name: "Checks", exact: true }).click();
    await page.getByText("GitHub check runs", { exact: true }).waitFor();
    await page.getByText("1 passed", { exact: true }).waitFor();
    await page.getByText("1 failed", { exact: true }).waitFor();
    await page.getByText("1 skipped", { exact: true }).waitFor();
    await page.getByText("1 pending", { exact: true }).waitFor();
    await page.getByText("1 neutral", { exact: true }).waitFor();
    expect(await page.getByRole("link", { name: "Open Browser tests", exact: true }).getAttribute("href")).toBe("https://github.com/owner/repo/actions/runs/2");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `forge-elements-checks-${width}.png`) });
    expect(value.errors).toEqual([]);
    expect(value.tasks.getTask(value.userId, task.id).status).toBe("backlog");
    expect(value.wakes).toEqual([]);
  } finally { await value.close(); }
});

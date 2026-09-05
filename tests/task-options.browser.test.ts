import { expect, test } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("task menu labels stay on one line and Duplicate opens a draft at %ipx", { timeout: 45_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const image = { filename: "example.gif", mimeType: "image/gif" as const, base64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" };
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Copy this task", description: "Keep the original objective.", startImmediately: false, deliveryTarget: "local_worktree", runProjectTests: false, visualEvidence: "capture", images: [image], idempotencyKey: "copy-task" });
    const { page } = value;
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await page.getByRole("button", { name: "Task options" }).click();
    const refresh = page.getByRole("menuitem", { name: "Check current state", exact: true });
    await refresh.waitFor();
    const lines = await refresh.evaluate(element => {
      const range = document.createRange();
      const text = Array.from(element.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("Check current state"));
      if (!text) throw new Error("Missing menu text");
      range.selectNodeContents(text);
      return range.getClientRects().length;
    });
    expect(lines).toBe(1);
    await page.screenshot({ path: join(tmpdir(), `forge-task-options-${width}.png`) });
    await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.getByLabel("Task title", { exact: true }).inputValue()).toBe("Copy this task (2)");
    expect(await dialog.getByLabel("Task description", { exact: true }).inputValue()).toBe(task.description);
    expect(await dialog.getByRole("radio", { name: "Keep in worktree", exact: true }).isChecked()).toBe(true);
    expect(await dialog.getByRole("checkbox", { name: "Run project tests", exact: true }).isChecked()).toBe(false);
    expect(value.tasks.listTasks(value.userId, value.company.id)).toHaveLength(1);
    await page.screenshot({ path: join(tmpdir(), `forge-task-duplicate-${width}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await expect.poll(() => value.tasks.listTasks(value.userId, value.company.id).length).toBe(2);
    const duplicate = value.tasks.listTasks(value.userId, value.company.id).find(candidate => candidate.id !== task.id)!;
    expect(duplicate).toMatchObject({ title: "Copy this task (2)", projectId: task.projectId, description: task.description, deliveryTarget: task.deliveryTarget, rootProfile: task.rootProfile, workerProfile: task.workerProfile, configuration: { runProjectTests: false, visualEvidence: "capture" } });
    expect(duplicate.configuration.branch).not.toBe(task.configuration.branch);
    expect(duplicate.images).toHaveLength(1);
    const copiedImage = await value.tasks.getTaskArtifact(value.userId, duplicate.id, duplicate.images[0]!.artifactId);
    expect(copiedImage.bytes.toString("base64")).toBe(image.base64);
    expect(value.tasks.getTask(value.userId, task.id)).toEqual(task);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

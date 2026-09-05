import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("New Task remembers settings before and after creation at %ipx", async width => {
  const value = await nativeBrowser(width);
  const { page } = value;
  try {
    const repositoryPath = join(value.config.repositoryRoot, "second");
    const worktreeRoot = join(value.config.worktreeRoot, "second");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    value.database.authTransaction(db => db.prepare("UPDATE forge_projects SET repository_identity = ? WHERE id = ?").run("owner/first", value.project.id));
    await value.projects.createProject(value.userId, value.company.id, { name: "Second repository", repositoryPath, worktreeRoot, repository: "owner/repo", baseBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    const dialog = page.getByRole("dialog");
    for (const role of ["Root", "Worker"]) {
      await dialog.getByRole("button", { name: new RegExp(`^${role} assignee:`) }).click();
      await page.getByRole("menuitemradio", { name: new RegExp(`${role} ·`) }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
    }
    await dialog.getByRole("button", { name: "Project", exact: true }).click();
    await page.getByRole("menuitem", { name: /Second repository/ }).click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await dialog.getByRole("radio", { name: "Push branch", exact: true }).check();
    await dialog.getByRole("checkbox", { name: "Start immediately", exact: true }).uncheck();
    await dialog.getByRole("checkbox", { name: "Run project tests", exact: true }).uncheck();
    await dialog.getByRole("combobox", { name: "Screenshots" }).click();
    await page.getByRole("option", { name: "Capture", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.reload();
    for (let index = 0; index < 2; index++) {
      await page.getByRole("button", { name: "Create task", exact: true }).click();
      await expect.poll(() => dialog.getByRole("button", { name: "Project", exact: true }).innerText()).toContain("Second repository");
      expect(await dialog.getByRole("radio", { name: "Push branch", exact: true }).isChecked()).toBe(true);
      expect(await dialog.getByRole("checkbox", { name: "Start immediately", exact: true }).isChecked()).toBe(false);
      expect(await dialog.getByRole("checkbox", { name: "Run project tests", exact: true }).isChecked()).toBe(false);
      expect(await dialog.getByRole("combobox", { name: "Screenshots" }).innerText()).toContain("Capture");
      for (const role of ["Root", "Worker"]) {
        await dialog.getByRole("button", { name: new RegExp(`^${role} assignee:`) }).click();
        expect(await page.getByRole("menuitemradio", { name: new RegExp(`${role} ·`) }).getAttribute("aria-checked")).toBe("true");
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "hidden" });
      }
      await page.screenshot({ path: join(tmpdir(), `forge-remembered-task-${width}.png`) });
      await dialog.getByLabel("Task title", { exact: true }).fill(`Remembered ${index}`);
      await dialog.getByLabel("Task description", { exact: true }).fill("Check remembered settings");
      await dialog.getByRole("button", { name: "Create task", exact: true }).click();
      await page.getByRole("heading", { name: `Remembered ${index}`, level: 2, exact: true }).waitFor();
      await page.reload();
    }
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

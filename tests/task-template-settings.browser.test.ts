import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("native templates save, apply, reset defaults, and delete at %ipx", { timeout: 90_000 }, async width => {
  const value = await nativeBrowser(width);
  const { page } = value;
  try {
    const secondRepositoryPath = join(value.config.repositoryRoot, "second");
    const secondWorktreeRoot = join(value.config.worktreeRoot, "second");
    await mkdir(secondRepositoryPath, { recursive: true });
    await mkdir(secondWorktreeRoot, { recursive: true });
    value.database.authTransaction(db => db.prepare("UPDATE forge_projects SET repository_identity = ? WHERE id = ?").run("owner/first", value.project.id));
    const secondProject = await value.projects.createProject(value.userId, value.company.id, { name: "Second repository", repositoryPath: secondRepositoryPath, worktreeRoot: secondWorktreeRoot, repository: "owner/repo", baseBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
    const projectUrl = `${value.base}/projects/${value.project.id}/templates?company=${value.company.id}`;
    const settingsUrl = `${value.base}/templates?company=${value.company.id}`;

    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.locator("[data-app-header]").getByRole("button", { name: "New task", exact: true }).click();
    let dialog = page.getByRole("dialog");
    const dialogWidth = await dialog.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    expect(dialogWidth.scrollWidth).toBeLessThanOrEqual(dialogWidth.clientWidth);
    await dialog.getByRole("button", { name: "Template", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open templates", exact: true }).waitFor();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Open templates"]);
    await page.getByRole("menuitem", { name: "Open templates", exact: true }).click();
    await expect.poll(() => page.url()).toBe(projectUrl);
    await page.getByRole("button", { name: "New template", exact: true }).waitFor();

    await page.goto(`${value.base}/profile?company=${value.company.id}`);
    if (width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("link", { name: "Templates", exact: true }).click();
    await expect.poll(() => page.url()).toBe(settingsUrl);
    const projectSelector = page.getByRole("combobox", { name: "Template project", exact: true });
    expect(await projectSelector.innerText()).toContain(value.project.name);
    await page.getByText("No templates configured.", { exact: true }).waitFor();
    await page.screenshot({ path: `/tmp/forge-template-settings-empty-${width}.png`, fullPage: true });

    await page.getByRole("button", { name: "New template", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "New template", exact: true });
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await page.screenshot({ path: `/tmp/forge-new-actions-template-dialog-${width}.png`, fullPage: true, animations: "disabled" });
    await dialog.getByLabel("Name", { exact: true }).fill("Unsaved first draft");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await projectSelector.click();
    await page.getByRole("option", { name: secondProject.name, exact: true }).click();
    await page.getByRole("button", { name: "New template", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "New template", exact: true });
    expect(await dialog.getByLabel("Name", { exact: true }).inputValue()).toBe("");
    await dialog.getByLabel("Name", { exact: true }).fill("Unsaved second draft");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await projectSelector.click();
    await page.getByRole("option", { name: value.project.name, exact: true }).click();
    await page.getByRole("button", { name: "New template", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "New template", exact: true });
    expect(await dialog.getByLabel("Name", { exact: true }).inputValue()).toBe("");
    await dialog.getByLabel("Name", { exact: true }).fill("Release");
    await dialog.getByLabel("Description", { exact: true }).fill("Inspect and release the change");
    await dialog.getByRole("combobox", { name: "Root profile", exact: true }).click();
    await page.getByRole("option", { name: /Root · openai/ }).click();
    await dialog.getByRole("combobox", { name: "Worker profile", exact: true }).click();
    await page.getByRole("option", { name: /Worker · openai/ }).click();
    await dialog.getByRole("combobox", { name: "Delivery target", exact: true }).click();
    await page.getByRole("option", { name: "Keep in worktree", exact: true }).click();
    await dialog.getByRole("combobox", { name: "Browser evidence", exact: true }).click();
    await page.getByRole("option", { name: "Necessary", exact: true }).click();
    await dialog.getByRole("checkbox", { name: "Run project tests", exact: true }).click();

    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    await page.route(`**/api/projects/${value.project.id}/task-templates`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      await saveGate;
      await route.fulfill({ response });
    });
    await dialog.getByRole("button", { name: "New template", exact: true }).click();
    await expect.poll(() => dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(true);
    expect(await dialog.getByRole("button", { name: "Close", exact: true }).count()).toBe(0);
    releaseSave();
    const visibleNameAction = page.getByRole("button", { name: "Edit Release", exact: true });
    await visibleNameAction.waitFor();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    await page.unroute(`**/api/projects/${value.project.id}/task-templates`);
    let templates = value.templates.list(value.userId, value.project.id);
    expect(templates).toHaveLength(1);
    const template = templates[0]!;
    expect(template.rootProfileId).toBe("profile_native_root");
    expect(template.workerProfileId).toBe("profile_native_worker");
    const searchInput = page.getByLabel("Search templates", { exact: true });
    const searchBounds = await searchInput.boundingBox();
    const sectionBounds = await searchInput.evaluate(element => element.closest("section")?.getBoundingClientRect().toJSON());
    expect(searchBounds).not.toBeNull();
    expect(sectionBounds).toBeTruthy();
    expect(searchBounds!.x).toBeGreaterThanOrEqual(sectionBounds!.x);
    expect(searchBounds!.x + searchBounds!.width).toBeLessThanOrEqual(sectionBounds!.x + sectionBounds!.width);
    expect(await visibleNameAction.isVisible()).toBe(true);
    const nameActionBounds = await visibleNameAction.boundingBox();
    expect(nameActionBounds).not.toBeNull();
    expect(nameActionBounds!.x).toBeGreaterThanOrEqual(0);
    expect(nameActionBounds!.x + nameActionBounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/forge-template-settings-populated-${width}.png`, fullPage: true });

    await visibleNameAction.click();
    dialog = page.getByRole("dialog", { name: "Edit template", exact: true });
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await page.screenshot({ path: `/tmp/forge-template-settings-edit-dialog-${width}.png`, fullPage: true, animations: "disabled" });
    await dialog.getByLabel("Description", { exact: true }).fill("Updated release instructions");
    await dialog.getByRole("combobox", { name: "Root profile", exact: true }).click();
    await page.getByRole("option", { name: "Project default", exact: true }).click();
    const saved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/api/task-templates/${template.id}`));
    await dialog.getByRole("button", { name: "Save template", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect.poll(() => dialog.isVisible()).toBe(false);
    templates = value.templates.list(value.userId, value.project.id);
    expect(templates[0]).toMatchObject({ description: "Updated release instructions" });
    expect(templates[0]?.rootProfileId).toBeUndefined();

    await projectSelector.click();
    await page.getByRole("option", { name: secondProject.name, exact: true }).click();
    expect(await page.getByRole("button", { name: "Edit Release", exact: true }).count()).toBe(0);
    await projectSelector.click();
    await page.getByRole("option", { name: value.project.name, exact: true }).click();
    await page.getByRole("button", { name: "Edit Release", exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.locator("[data-app-header]").getByRole("button", { name: "New task", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Template", exact: true }).click();
    await page.getByRole("menuitem", { name: "Release", exact: true }).waitFor();
    expect(await page.getByRole("menuitem").count()).toBe(1);
    await page.getByRole("menuitem", { name: "Release", exact: true }).click();
    expect(await dialog.getByLabel("Task description", { exact: true }).inputValue()).toBe("Updated release instructions");
    expect(await dialog.getByRole("radio", { name: "Keep in worktree", exact: true }).isChecked()).toBe(true);
    expect(await dialog.getByRole("checkbox", { name: "Run project tests", exact: true }).isChecked()).toBe(false);
    expect(await dialog.getByRole("combobox", { name: "Screenshots", exact: true }).innerText()).toContain("Necessary");
    await dialog.getByLabel("Task title", { exact: true }).fill("Apply release template");
    await dialog.getByRole("checkbox", { name: "Start immediately", exact: true }).click();
    await dialog.getByRole("button", { name: "New task", exact: true }).click();
    await expect.poll(() => value.tasks.listTasks(value.userId, value.company.id).length).toBe(1);
    expect(value.tasks.listTasks(value.userId, value.company.id)[0]).toMatchObject({
      title: "Apply release template",
      description: "Updated release instructions",
      deliveryTarget: "local_worktree",
      rootProfile: { profileId: "profile_native_root" },
      workerProfile: { profileId: "profile_native_worker" },
      configuration: { runProjectTests: false, visualEvidence: "required" },
    });

    await page.goto(settingsUrl);
    await page.getByRole("button", { name: "Edit Release", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Edit template", exact: true });
    await dialog.getByRole("button", { name: "Delete template", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Delete Release?", exact: true });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
    let deleteAttempts = 0;
    await page.route(`**/api/task-templates/${template.id}`, async route => {
      if (route.request().method() !== "DELETE") return route.continue();
      deleteAttempts += 1;
      if (deleteAttempts === 1) return route.fulfill({ status: 503, json: { error: "Forge could not delete the template" } });
      const response = await route.fetch();
      await deleteGate;
      await route.fulfill({ response });
    });
    const failedDelete = page.waitForResponse(response => response.request().method() === "DELETE" && response.status() === 503);
    await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
    await failedDelete;
    const deleteAlert = confirmation.getByRole("alert");
    await deleteAlert.waitFor();
    expect(await deleteAlert.innerText()).toContain("Forge could not delete the template");
    expect(value.templates.list(value.userId, value.project.id)).toHaveLength(1);
    expect(await confirmation.isVisible()).toBe(true);
    const deleted = page.waitForResponse(response => response.request().method() === "DELETE");
    await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => confirmation.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(true);
    releaseDelete();
    expect((await deleted).status()).toBe(204);
    await expect.poll(() => value.templates.list(value.userId, value.project.id).length).toBe(0);
    await expect.poll(() => page.getByText("No templates configured.", { exact: true }).isVisible()).toBe(true);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("global templates shows project loading errors", async () => {
  const value = await nativeBrowser();
  const { page } = value;
  try {
    await page.route(`**/api/companies/${value.company.id}/projects`, route => route.fulfill({ status: 503, json: { error: "Projects are not available" } }));
    await page.goto(`${value.base}/templates?company=${value.company.id}`);
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").innerText()).toContain("Projects are not available");
    expect(await page.getByText("Add a project before you add a template.", { exact: true }).count()).toBe(0);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

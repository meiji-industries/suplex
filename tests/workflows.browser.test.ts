import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import type { Page } from "playwright";
import type { TaskControlStore } from "../src/root-session-store.js";
import type { RaterResult, ReviewRange } from "../src/workflows.js";
import { nativeBrowser } from "./helpers/native-browser.js";

const proof = resolve(".context/workflows-proof");
const sha = (letter: string) => letter.repeat(40);
const range = (head: string): ReviewRange => ({ baseSha: sha("a"), headSha: head, files: ["src/feature.ts"], commits: [head] });
const report = (rating: number) => `## Rating ${rating}/10\n\nCorrectness: the guard is missing.\n\n### Surgical plan\n1. Add the null guard in src/feature.ts.\n\n\`\`\`json\n{"rating":${rating},"blockingFindings":["src/feature.ts: null dereference"],"verification":"passed","verificationSummary":"pnpm test exit 0","summary":"Rated ${rating}"}\n\`\`\`\n`;

/** Seeds a Rater or planner round through the same store path the controller uses, so history reads real ledger rows. */
function seedAdvisor(store: TaskControlStore, taskId: string, role: "rater" | "planner_a" | "planner_b", head: string, text: string, result: RaterResult | null, invalidReason: string | null) {
  const root = store.currentSession(taskId, "root")!;
  const session = store.launchWorker({ taskId, rootSessionId: root.id, rootGeneration: root.generation, advisor: { role, prompt: `${role} assignment`, input: { kind: "advisor", role, range: range(head), evidenceDirectory: "/evidence", evidenceSha256: "f".repeat(64), verificationTurnIds: [] } } });
  store.bindHarnessSession({ sessionId: session.id, generation: session.generation, nativeSessionId: `ses_${role}_${session.generation}` });
  const outcome = role === "rater" ? { result, invalidReason } : { result: result ? { role, summary: "Plan summary" } : null, invalidReason };
  store.recordWorkerResultAndWake({ taskId, sessionId: session.id, generation: session.generation, receiptId: `${session.id}:done`, observation: JSON.stringify({ state: "completed", text, advisor: { role, ...outcome } }), ...(role === "rater" ? { review: { result, invalidReason } } : {}) });
  return session;
}

async function openNavigation(page: Page, width: number) {
  if (width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
}

test.each([1440, 390])("Workflows page lists five workflows, expands one, prefills the dialog, and the dialog enforces workflow settings at %ipx", { timeout: 120_000 }, async width => {
  const value = await nativeBrowser(width);
  const { page } = value;
  try {
    await mkdir(proof, { recursive: true });
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await page.goto(`${value.base}/profile?company=${value.company.id}`);
    await openNavigation(page, width);
    await page.getByRole("link", { name: "Workflows", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/admin/workflows");
    await page.getByRole("table", { name: "Workflows" }).waitFor();
    expect(await page.locator("[data-workflow-row]").count()).toBe(5);
    expect(await page.locator("[data-workflow-row]").allTextContents()).toEqual([expect.stringContaining("Combined planning"), expect.stringContaining("Direct build"), expect.stringContaining("Pull request repair"), expect.stringContaining("Second opinion"), expect.stringContaining("Standard")]);
    expect(await page.locator('[data-workflow-row="workflow_native_refine_pull_request"]').innerText()).toContain("Merged pull request");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(proof, `workflows-page-${width}.png`), fullPage: true, animations: "disabled" });
    // Editing a workflow sets its default agents; the editor shows the built-in engine's steps.
    const fable = value.profiles.create(value.userId, { name: "Fable", role: "root", avatarSeed: "3".repeat(32), provider: "openai", model: "gpt-5.5", reasoningLevel: "high", serviceTier: "default" });
    await page.reload();
    await page.getByRole("button", { name: "Edit Pull request repair", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit workflow", exact: true });
    expect(await editor.getByRole("list", { name: "Pull request repair steps" }).getByRole("listitem").count()).toBe(6);
    await editor.getByRole("combobox", { name: "Coordinator", exact: true }).click();
    await page.getByRole("option", { name: /^Fable/ }).click();
    await editor.getByRole("combobox", { name: "Rater", exact: true }).click();
    await page.getByRole("option", { name: /^Fable/ }).click();
    await editor.getByRole("button", { name: "Save workflow", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    expect(value.workflows.list(value.userId).find(workflow => workflow.id === "workflow_native_refine_pull_request")).toMatchObject({ rootProfileId: fable.id, advisorProfileIds: { rater: fable.id } });
    const repairRow = page.locator('[data-workflow-row="workflow_native_refine_pull_request"]');
    expect(await repairRow.innerText()).toContain("Fable");
    expect(await repairRow.getByLabel("Default agents").locator("> span").first().getAttribute("title")).toBe("Coordinator: Fable");
    expect(await repairRow.getByTitle("Worker: Project default").innerText()).toBe("Project default");
    // A new workflow is a named preset over a built-in engine; archiving hides it from the task dialog.
    await page.getByRole("button", { name: "New workflow", exact: true }).click();
    const creator = page.getByRole("dialog", { name: "New workflow", exact: true });
    await creator.getByLabel("Name", { exact: true }).fill("Fable review");
    await creator.getByRole("combobox", { name: "Built-in workflow", exact: true }).click();
    await page.getByRole("option", { name: "Second opinion", exact: true }).click();
    await creator.getByRole("combobox", { name: "Reviewer", exact: true }).click();
    await page.getByRole("option", { name: /^Fable/ }).click();
    await creator.getByRole("button", { name: "New workflow", exact: true }).click();
    await creator.waitFor({ state: "hidden" });
    const created = value.workflows.list(value.userId).find(workflow => workflow.name === "Fable review")!;
    expect(created).toMatchObject({ engine: "independent_review", advisorProfileIds: { reviewer: fable.id } });
    await page.locator(`[data-workflow-row="${created.id}"]`).getByRole("button", { name: "Fable review actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }).click();
    await page.locator(`[data-workflow-row="${created.id}"]`).getByText("Archived", { exact: true }).waitFor();
    // Create task from a row applies the workflow and its default agents.
    await page.locator('[data-workflow-row="workflow_native_refine_pull_request"]').getByRole("button", { name: "Pull request repair actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Create task", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Coordinator assignee: Fable", exact: true }).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Rater assignee: Fable", exact: true }).waitFor();
    await expect.poll(() => page.getByRole("dialog").getByRole("combobox", { name: "Workflow", exact: true }).innerText()).toContain("Pull request repair");
    expect(await page.getByRole("dialog").getByRole("combobox", { name: "Workflow", exact: true }).innerText()).not.toContain("Fable review");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    // Create task prefills the workflow; nothing starts from navigation or expansion.
    await page.locator('[data-workflow-row="workflow_native_independent_review"]').getByRole("button", { name: "Second opinion actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Create task", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Task title", { exact: true }).waitFor();
    await expect.poll(() => dialog.getByRole("combobox", { name: "Workflow", exact: true }).innerText()).toContain("Second opinion");
    await dialog.getByRole("button", { name: /^Reviewer assignee:/ }).waitFor();
    expect(await dialog.getByRole("button", { name: /^Rater assignee:/ }).count()).toBe(0);
    expect(await dialog.getByRole("button", { name: /^Coordinator assignee:/ }).getAttribute("aria-label")).not.toContain("Fable");
    expect(value.tasks.listTasks(value.userId)).toEqual([]);
    await page.screenshot({ path: join(proof, `dialog-second-opinion-${width}.png`), fullPage: true, animations: "disabled" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    // An ordinary fresh task opens as Standard.
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
    await page.keyboard.press("c");
    await dialog.getByLabel("Task title", { exact: true }).waitFor();
    await expect.poll(() => dialog.getByRole("combobox", { name: "Workflow", exact: true }).innerText()).toContain("Standard");
    expect(await dialog.getByRole("button", { name: /^Reviewer assignee:/ }).count()).toBe(0);
    // Repair fixes the target and tests, requires a pull request source, and restores the draft when switched away.
    await dialog.getByRole("radio", { name: "Push branch", exact: true }).check();
    await dialog.getByRole("combobox", { name: "Workflow", exact: true }).click();
    await page.getByRole("option", { name: "Pull request repair", exact: true }).click();
    expect(await dialog.getByRole("radio", { name: "Merge to base", exact: true }).isChecked()).toBe(true);
    expect(await dialog.getByRole("radio", { name: "Push branch", exact: true }).isDisabled()).toBe(true);
    const tests = dialog.getByRole("checkbox", { name: "Run project tests", exact: true });
    expect(await tests.isChecked()).toBe(true);
    expect(await tests.isDisabled()).toBe(true);
    await dialog.getByLabel("Task title", { exact: true }).fill("Repair the login pull request");
    await dialog.getByLabel("Task description", { exact: true }).fill("Bring it to 9/10.");
    expect(await dialog.locator("[data-repair-note]").innerText()).toBe("Select a pull request source.");
    expect(await dialog.getByRole("button", { name: "New task", exact: true }).isDisabled()).toBe(true);
    await dialog.getByRole("button", { name: /^Rater assignee:/ }).waitFor();
    await page.route(`**/api/projects/${value.project.id}/task-sources?kind=pull_request`, route => route.fulfill({ json: { available: true, sources: [{ kind: "pull_request", number: 41, title: "Fix login", body: "", author: "dev", headBranch: "fix-login", baseBranch: "main", isDraft: true }] } }));
    await dialog.getByRole("button", { name: "New from source", exact: true }).click();
    expect(await page.getByRole("menu").getByRole("tab").count()).toBe(0);
    await page.getByRole("menuitem", { name: /#41 Fix login/ }).click();
    expect(await dialog.locator("[data-repair-note]").innerText()).toBe("Forge repairs this pull request, then pushes and merges it after the checks pass.");
    expect(await dialog.getByRole("button", { name: "New task", exact: true }).isDisabled()).toBe(false);
    await page.screenshot({ path: join(proof, `dialog-repair-${width}.png`), fullPage: true, animations: "disabled" });
    const [posted] = await Promise.all([
      page.waitForRequest(request => request.method() === "POST" && request.url().includes("/tasks")),
      dialog.getByRole("button", { name: "New task", exact: true }).click(),
    ]);
    expect(posted.postDataJSON()).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true, source: { kind: "pull_request", number: 41 } });
    expect(posted.postDataJSON()).not.toHaveProperty("advisorProfileIds.reviewer");
    await dialog.getByRole("alert").waitFor();
    await dialog.getByRole("combobox", { name: "Workflow", exact: true }).click();
    await page.getByRole("option", { name: "Combined planning", exact: true }).click();
    expect(await dialog.getByRole("radio", { name: "Push branch", exact: true }).isChecked()).toBe(true);
    expect(await tests.isDisabled()).toBe(false);
    await dialog.getByRole("button", { name: /^Plan A assignee:/ }).waitFor();
    await dialog.getByRole("button", { name: /^Plan B assignee:/ }).waitFor();
    expect(await dialog.getByRole("button", { name: /^Rater assignee:/ }).count()).toBe(0);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    // Fresh dialogs never remember a workflow, and the forced repair target never reached memory.
    await page.reload();
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
    await page.keyboard.press("c");
    await dialog.getByLabel("Task title", { exact: true }).waitFor();
    await expect.poll(() => dialog.getByRole("combobox", { name: "Workflow", exact: true }).innerText()).toContain("Standard");
    expect(await dialog.getByRole("radio", { name: "Push branch", exact: true }).isChecked()).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("forge.newTask.lastSettings") ?? "{}"))).not.toHaveProperty("workflow");
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test.each([1440, 390])("templates and duplicates carry workflow selections, and task details show review history, labels, and truthful completion at %ipx", { timeout: 150_000 }, async width => {
  const value = await nativeBrowser(width);
  const { page } = value;
  const store = value.tasks.repository.controls;
  try {
    await mkdir(proof, { recursive: true });
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    // Templates store and apply workflow selections; repair templates fix target/tests.
    await page.goto(`${value.base}/projects/${value.project.id}/templates?company=${value.company.id}`);
    await page.getByRole("button", { name: "New template", exact: true }).click();
    let editor = page.getByRole("dialog", { name: "New template", exact: true });
    await editor.getByLabel("Name", { exact: true }).fill("Second opinion release");
    await editor.getByLabel("Description", { exact: true }).fill("Review twice before delivery");
    await editor.getByRole("combobox", { name: "Workflow", exact: true }).click();
    await page.getByRole("option", { name: "Second opinion", exact: true }).click();
    await editor.getByRole("combobox", { name: "Reviewer profile", exact: true }).click();
    await page.getByRole("option", { name: /Root/ }).click();
    await editor.getByRole("button", { name: "New template", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    const table = page.getByRole("table", { name: "Task templates" });
    expect(await table.innerText()).toContain("Second opinion");
    await page.getByRole("button", { name: "Edit Second opinion release", exact: true }).click();
    editor = page.getByRole("dialog", { name: "Edit template", exact: true });
    await editor.getByRole("combobox", { name: "Workflow", exact: true }).click();
    await page.getByRole("option", { name: "Pull request repair", exact: true }).click();
    expect(await editor.getByRole("combobox", { name: "Delivery target", exact: true }).innerText()).toContain("Merge to base");
    expect(await editor.getByRole("combobox", { name: "Delivery target", exact: true }).isDisabled()).toBe(true);
    expect(await editor.getByRole("combobox", { name: "Reviewer profile", exact: true }).count()).toBe(0);
    await editor.getByRole("combobox", { name: "Workflow", exact: true }).click();
    await page.getByRole("option", { name: "Second opinion", exact: true }).click();
    // Switching workflows drops Advisor selections that the new workflow does not admit; choose Reviewer again.
    expect(await editor.getByRole("combobox", { name: "Reviewer profile", exact: true }).innerText()).toContain("Same as Coordinator");
    await editor.getByRole("combobox", { name: "Reviewer profile", exact: true }).click();
    await page.getByRole("option", { name: /Root/ }).click();
    await editor.getByRole("button", { name: "Save template", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    const templates = value.templates.list(value.userId, value.project.id);
    expect(templates[0]).toMatchObject({ workflow: "independent_review", advisorProfileIds: { reviewer: "profile_native_root" } });
    await page.screenshot({ path: join(proof, `templates-${width}.png`), fullPage: true, animations: "disabled" });
    // Applying the template in the dialog selects the workflow and its Advisor.
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.locator("[data-app-header]").getByRole("button", { name: "New task", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Template", exact: true }).click();
    await page.getByRole("menuitem", { name: "Second opinion release", exact: true }).click();
    await expect.poll(() => dialog.getByRole("combobox", { name: "Workflow", exact: true }).innerText()).toContain("Second opinion");
    await dialog.getByRole("button", { name: /^Reviewer assignee: Root/ }).waitFor();
    await page.keyboard.press("Escape");
    // Duplicate copies the workflow into a non-started draft without execution state.
    const { task: original } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Reviewed change", description: "Needs a second opinion", idempotencyKey: "browser-review", startImmediately: true, workflow: "independent_review" });
    const root = store.claimRoot({ taskId: original.id });
    store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_review_root" });
    store.updateWorkflowState(original.id, state => ({ ...state, reviews: [{ sessionId: "s", turnId: "t", role: "reviewer", range: range(sha("b")), result: { role: "reviewer", approved: false, blockingFindings: ["src/feature.ts: unguarded"], verification: "passed", verificationSummary: "ok", summary: "Not yet" }, invalidReason: null, recordedAt: new Date().toISOString() }] }));
    await page.goto(`${value.base}/tasks/${original.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Reviewed change", level: 2, exact: true }).waitFor();
    expect(await page.locator("[data-task-workflow]").innerText()).toBe("Second opinion");
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
    const duplicate = page.getByRole("dialog");
    await duplicate.getByLabel("Task title", { exact: true }).waitFor();
    await expect.poll(() => duplicate.getByRole("combobox", { name: "Workflow", exact: true }).innerText()).toContain("Second opinion");
    expect(await duplicate.getByRole("checkbox", { name: "Start immediately", exact: true }).isChecked()).toBe(false);
    await duplicate.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("heading", { name: /Reviewed change/, level: 2 }).waitFor();
    const copy = value.tasks.listTasks(value.userId).find(task => task.id !== original.id)!;
    expect(copy).toMatchObject({ status: "backlog", workflow: "independent_review", workflowState: { reviews: [], deliveryWait: null, completion: null } });
    expect(store.sessions(copy.id)).toEqual([]);
    // Repair history: rounds, an invalid attempt, a stale rating, CI pending, and a human question.
    const { task: repair } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Repair the payments pull request", description: "Rate and repair until 9.", idempotencyKey: "browser-repair", startImmediately: true, workflow: "independent_review" });
    value.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET workflow = 'refine_pull_request', delivery_target = 'merged', advisor_profiles_json = ? WHERE task_id = ?").run(JSON.stringify({ rater: { ...original.rootProfile, model: "gpt-5.6-luna" } }), repair.id));
    const repairRoot = store.claimRoot({ taskId: repair.id });
    store.bindHarnessSession({ sessionId: repairRoot.id, generation: repairRoot.generation, nativeSessionId: "ses_repair_root" });
    store.setWorktree(repair.id, { path: "/worktrees/repair", branch: "fix-payments", baseSha: sha("a"), headSha: sha("d"), dirty: false });
    seedAdvisor(store, repair.id, "rater", sha("b"), report(7), { role: "rater", rating: 7, blockingFindings: ["src/feature.ts: null dereference"], verification: "passed", verificationSummary: "pnpm test exit 0", summary: "Rated 7" }, null);
    seedAdvisor(store, repair.id, "rater", sha("c"), "I think it is fine now.", null, "The report has no fenced json block");
    seedAdvisor(store, repair.id, "rater", sha("c"), report(9).replace('"blockingFindings":["src/feature.ts: null dereference"]', '"blockingFindings":[]'), { role: "rater", rating: 9, blockingFindings: [], verification: "passed", verificationSummary: "pnpm test exit 0", summary: "Rated 9" }, null);
    store.updateWorkflowState(repair.id, state => ({ ...state, deliveryWait: { headSha: sha("c"), fingerprint: "fp", since: new Date().toISOString(), reason: "checks" } }));
    await page.goto(`${value.base}/tasks/${repair.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Repair the payments pull request", level: 2, exact: true }).waitFor();
    expect(await page.locator("[data-task-workflow]").innerText()).toBe("Pull request repair");
    const status = page.locator("[data-workflow-status]");
    expect(await status.innerText()).toContain("CI pending");
    expect(await status.innerText()).toContain(`9/10 for ${sha("c").slice(0, 10)}`);
    expect(await status.innerText()).toContain("Review stale");
    expect(await page.getByRole("complementary", { name: "Task properties" }).innerText()).toContain("Rater");
    expect(await page.getByRole("complementary", { name: "Task properties" }).innerText()).toContain("gpt-5.6-luna");
    await page.locator("[data-workflow-history] summary").first().click();
    const rounds = page.locator("[data-review-round]");
    expect(await rounds.count()).toBe(3);
    expect(await rounds.nth(0).innerText()).toContain("Rater round 1");
    expect(await rounds.nth(0).innerText()).toContain("7/10");
    expect(await rounds.nth(1).innerText()).toContain("Invalid");
    expect(await rounds.nth(1).innerText()).toContain("no fenced json block");
    expect(await rounds.nth(2).innerText()).toContain("Rater round 3");
    await rounds.nth(0).getByText("Full report and repair plan", { exact: true }).click();
    await rounds.nth(0).getByText("Add the null guard in src/feature.ts.").waitFor();
    store.askHuman(repair.id, "Three consecutive repair cycles left the same blocking findings at 7/10. How should Forge continue?", [{ label: "Continue", description: "Another attempt.", recommended: true }, { label: "Revise scope", description: "Describe the decision.", recommended: false }]);
    await page.getByRole("region", { name: "Question" }).getByText(/Three consecutive repair cycles/).waitFor();
    await page.getByRole("tab", { name: "Other", exact: true }).click();
    await page.getByText("Runtime diagnostics", { exact: true }).click();
    expect(await page.getByRole("region", { name: "Sessions", exact: true }).innerText()).toContain("Rater 1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(proof, `task-repair-history-${width}.png`), fullPage: true, animations: "disabled" });
    // Combined planning: both candidate reports and the Worker's stored synthesis assignment.
    const { task: combined } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Combined planning build", description: "Two plans, one build.", idempotencyKey: "browser-combined", startImmediately: true, workflow: "competing_plans" });
    const combinedRoot = store.claimRoot({ taskId: combined.id });
    store.bindHarnessSession({ sessionId: combinedRoot.id, generation: combinedRoot.generation, nativeSessionId: "ses_combined_root" });
    store.setWorktree(combined.id, { path: "/worktrees/combined", branch: "forge/combined", baseSha: sha("a"), headSha: sha("a"), dirty: false });
    const planA = seedAdvisor(store, combined.id, "planner_a", sha("a"), "# Plan A\n\nAdd a helper module.\n\n```json\n{\"summary\":\"Helper module\"}\n```", { role: "rater", rating: 1, blockingFindings: [], verification: "passed", verificationSummary: "", summary: "" } as never, null);
    const planB = seedAdvisor(store, combined.id, "planner_b", sha("a"), "# Plan B\n\nInline the change.\n\n```json\n{\"summary\":\"Inline\"}\n```", { role: "rater", rating: 1, blockingFindings: [], verification: "passed", verificationSummary: "", summary: "" } as never, null);
    store.launchWorker({ taskId: combined.id, rootSessionId: combinedRoot.id, rootGeneration: combinedRoot.generation, instruction: "Coordinator plan:\nCombined plan: helper module with inline call site.\n\nAcceptance criteria:\n1. Tests pass", workflowInput: { kind: "worker", mode: "planned", purpose: "implementation", range: range(sha("a")), plan: "Combined plan", acceptanceCriteria: ["Tests pass"], instruction: "Build", advisorSessionId: null, candidateSessionIds: [planA.id, planB.id] } });
    await page.goto(`${value.base}/tasks/${combined.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Combined planning build", level: 2, exact: true }).waitFor();
    await page.locator("[data-workflow-history] summary").first().click();
    expect(await page.locator('[data-plan-report="planner_a"]').innerText()).toContain("Plan A");
    expect(await page.locator('[data-plan-report="planner_b"]').innerText()).toContain("Plan B");
    await page.locator('[data-plan-report="planner_b"]').getByText("Full plan", { exact: true }).click();
    await page.locator('[data-plan-report="planner_b"]').getByText("Inline the change.").waitFor();
    await page.locator("[data-synthesis-assignment]").getByText("Assignment", { exact: true }).click();
    await page.locator("[data-synthesis-assignment]").getByText(/Combined plan: helper module with inline call site/).waitFor();
    await page.screenshot({ path: join(proof, `task-combined-history-${width}.png`), fullPage: true, animations: "disabled" });
    // External merge before the obligations: labeled truthfully, no fabricated rating. Then a workflow merge shows Merged.
    const { task: external } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Merged by someone else", description: "External merge.", idempotencyKey: "browser-external", startImmediately: true, workflow: "independent_review" });
    value.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET workflow = 'refine_pull_request', delivery_target = 'merged' WHERE task_id = ?").run(external.id));
    store.setPullRequest(external.id, { repository: "owner/repo", number: 9, url: "https://github.com/owner/repo/pull/9", headSha: sha("e"), state: "merged", mergedAt: new Date().toISOString() });
    store.updateWorkflowState(external.id, state => ({ ...state, completion: { kind: "external_merge", reviewedHead: null, pullRequestNumber: 9, observedAt: new Date().toISOString() } }));
    store.markDelivered(external.id);
    await page.goto(`${value.base}/tasks/${external.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Merged by someone else", level: 2, exact: true }).waitFor();
    const externalStatus = await page.locator("[data-workflow-status]").innerText();
    expect(externalStatus).toContain("Merged externally");
    expect(externalStatus).toContain("Workflow verification incomplete");
    expect(externalStatus).toContain("Not rated");
    expect(externalStatus).not.toContain("9/10");
    await page.screenshot({ path: join(proof, `task-external-merge-${width}.png`), fullPage: true, animations: "disabled" });
    store.updateWorkflowState(repair.id, state => ({ ...state, deliveryWait: null, completion: { kind: "workflow", reviewedHead: sha("c"), pullRequestNumber: 7, observedAt: new Date().toISOString() } }));
    store.setPullRequest(repair.id, { repository: "owner/repo", number: 7, url: "https://github.com/owner/repo/pull/7", headSha: sha("c"), state: "merged", mergedAt: new Date().toISOString() });
    await page.goto(`${value.base}/tasks/${repair.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Repair the payments pull request", level: 2, exact: true }).waitFor();
    expect(await page.locator("[data-workflow-status]").innerText()).toContain("Merged");
    expect(await page.locator("[data-workflow-status]").innerText()).not.toContain("Review stale");
    // Old Standard tasks keep Coordinator and Worker labels and show no review history.
    const { task: standard } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Standard task", description: "Plain", idempotencyKey: "browser-standard", startImmediately: false });
    await page.goto(`${value.base}/tasks/${standard.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Standard task", level: 2, exact: true }).waitFor();
    expect(await page.locator("[data-task-workflow]").innerText()).toBe("Standard");
    expect(await page.locator("[data-workflow-history]").count()).toBe(0);
    expect(await page.getByRole("complementary", { name: "Task properties" }).innerText()).toMatch(/Coordinator[\s\S]*Worker/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test.each([1440, 390])("delivered outcomes render the observed endpoint, not a merge, and role selectors keep role and profile visible at %ipx", { timeout: 150_000 }, async width => {
  const value = await nativeBrowser(width);
  const { page } = value;
  const store = value.tasks.repository.controls;
  try {
    await mkdir(proof, { recursive: true });
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    const seed = async (key: string, title: string, workflow: "independent_review" | "refine_pull_request", target: string, mutate: (id: string) => void) => {
      // Repair tasks need a live pull request source at creation; the fixture creates a Second opinion task and switches the stored workflow.
      const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title, description: "Outcome fixture", idempotencyKey: key, startImmediately: true, workflow: "independent_review", ...(target === "merged" ? {} : { deliveryTarget: target as "local_worktree" }) });
      void workflow;
      if (target === "merged") value.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET workflow = 'refine_pull_request', delivery_target = 'merged' WHERE task_id = ?").run(task.id));
      const root = store.claimRoot({ taskId: task.id });
      store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: `ses_${key}` });
      mutate(task.id);
      return task;
    };
    const pull = (id: string, state: "open" | "merged") => store.setPullRequest(id, { repository: "owner/repo", number: 5, url: "https://github.com/owner/repo/pull/5", headSha: sha("b"), state, mergedAt: state === "merged" ? new Date().toISOString() : null });
    const complete = (id: string) => { store.updateWorkflowState(id, state => ({ ...state, completion: { kind: "workflow", reviewedHead: sha("b"), pullRequestNumber: null, observedAt: new Date().toISOString() } })); store.markDelivered(id); };
    const cases: Array<{ title: string; task: { id: string }; expect: string[]; forbid: string[] }> = [];
    cases.push({ title: "Local worktree outcome", task: await seed("outcome-local", "Local worktree outcome", "independent_review", "local_worktree", complete), expect: ["Delivered"], forbid: ["Merged"] });
    cases.push({ title: "Pushed branch outcome", task: await seed("outcome-branch", "Pushed branch outcome", "independent_review", "remote_branch", complete), expect: ["Delivered"], forbid: ["Merged"] });
    cases.push({ title: "Draft pull request outcome", task: await seed("outcome-draft", "Draft pull request outcome", "independent_review", "pull_request_draft", id => { pull(id, "open"); complete(id); }), expect: ["Delivered"], forbid: ["Merged"] });
    cases.push({ title: "Ready pull request outcome", task: await seed("outcome-ready", "Ready pull request outcome", "independent_review", "pull_request_ready", id => { pull(id, "open"); complete(id); }), expect: ["Delivered"], forbid: ["Merged"] });
    cases.push({ title: "Direct merge outcome", task: await seed("outcome-merge", "Direct merge outcome", "refine_pull_request", "merged", id => { pull(id, "merged"); complete(id); }), expect: ["Merged"], forbid: ["Merged externally", "Delivered"] });
    cases.push({ title: "External merge outcome", task: await seed("outcome-external", "External merge outcome", "refine_pull_request", "merged", id => { pull(id, "merged"); store.updateWorkflowState(id, state => ({ ...state, completion: { kind: "external_merge", reviewedHead: null, pullRequestNumber: 5, observedAt: new Date().toISOString() } })); store.markDelivered(id); }), expect: ["Merged externally", "Workflow verification incomplete", "Not rated"], forbid: ["Delivered"] });
    cases.push({ title: "Queued merge outcome", task: await seed("outcome-queue", "Queued merge outcome", "refine_pull_request", "merged", id => { pull(id, "open"); store.updateWorkflowState(id, state => ({ ...state, deliveryWait: { headSha: sha("b"), fingerprint: "fp", since: new Date().toISOString(), reason: "merge_queue" } })); }), expect: ["Merge requested"], forbid: ["Merged", "Delivered"] });
    for (const item of cases) {
      await page.goto(`${value.base}/tasks/${item.task.id}?company=${value.company.id}`);
      await page.getByRole("heading", { name: item.title, level: 2, exact: true }).waitFor();
      const badges = await page.locator("[data-workflow-status] [data-slot=\"badge\"]").allInnerTexts();
      for (const text of item.expect) expect(badges, item.title).toContain(text);
      for (const text of item.forbid) expect(badges, item.title).not.toContain(text);
      await page.screenshot({ path: join(proof, `outcome-${item.task.id === cases[0]!.task.id ? "local" : item.title.split(" ")[0]!.toLowerCase()}-${width}.png`), fullPage: true, animations: "disabled" });
    }
    // Role selectors show role and profile together for every workflow, by default and with an explicit Advisor choice.
    await page.goto(`${value.base}/admin/workflows?company=${value.company.id}`);
    const visible = async (label: string) => (await page.getByRole("dialog").getByRole("button", { name: new RegExp(`^${label} assignee:`) }).innerText()).replace(/\s+/g, " ").trim();
    await page.locator('[data-workflow-row="workflow_native_independent_review"]').getByRole("button", { name: "Second opinion actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Create task", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Task title", { exact: true }).waitFor();
    await expect.poll(() => visible("Coordinator")).toBe("Coordinator: Root");
    expect(await visible("Worker")).toBe("Worker: Worker");
    expect(await visible("Reviewer")).toBe("Reviewer: Root");
    await dialog.getByRole("combobox", { name: "Workflow", exact: true }).click();
    await page.getByRole("option", { name: "Combined planning", exact: true }).click();
    expect(await visible("Plan A")).toBe("Plan A: Root");
    expect(await visible("Plan B")).toBe("Plan B: Root");
    await dialog.getByRole("combobox", { name: "Workflow", exact: true }).click();
    await page.getByRole("option", { name: "Pull request repair", exact: true }).click();
    expect(await visible("Rater")).toBe("Rater: Root");
    await dialog.getByRole("button", { name: /^Rater assignee:/ }).click();
    await page.getByRole("menuitemradio", { name: /Root ·/ }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    expect(await visible("Rater")).toBe("Rater: Root");
    expect(await dialog.getByRole("button", { name: "Rater assignee: Root", exact: true }).count()).toBe(1);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: join(proof, `role-selectors-${width}.png`), fullPage: true, animations: "disabled" });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

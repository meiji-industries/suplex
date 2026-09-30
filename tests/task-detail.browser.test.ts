import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";
import { seedTodayFixture } from "./helpers/today-fixture.js";

const desktopViewport = 1280;

test("native task detail supports answering a question and cancelling", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    const task = await value.createTask({ title: "Native task detail", description: "Preserve the existing branch changes.", startImmediately: false, idempotencyKey: "native-detail" });
    const root = "fixture-root";
    const stamp = new Date().toISOString();
    value.database.exec("BEGIN");
    try {
      value.database.prepare("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,created_at,updated_at,profile_json) VALUES (?,?,'root',1,1,'reserved',?,?,?)")
        .run(root, task.id, stamp, stamp, JSON.stringify(task.rootProfile));
      value.database.prepare("UPDATE suplex_task_controls SET status = 'waiting_human', root_session_id = ?, human_question = 'Which base branch should I use?', human_question_id = 'fixture-question' WHERE task_id = ?").run(root, task.id);
      value.database.exec("COMMIT");
    } catch (error) { value.database.exec("ROLLBACK"); throw error; }
    const { page } = value;
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Native task detail", level: 2, exact: true }).waitFor();
    await page.locator("[data-task-detail-header]").getByRole("button", { name: "Task options", exact: true }).waitFor();
    await page.getByRole("region", { name: "Question" }).getByText("Which base branch should I use?").waitFor();
    await page.getByLabel("Answer", { exact: true }).fill("Use main and preserve local work.");
    await page.getByRole("button", { name: "Answer and continue", exact: true }).click();
    await page.getByRole("region", { name: "Question" }).waitFor({ state: "hidden" });
    await expect.poll(async () => (await value.api("GET", `/api/tasks/${task.id}`)).body, { timeout: 10_000 }).toMatchObject({ status: "active" });
    expect(value.database.prepare("SELECT prompt_text FROM suplex_task_turns WHERE session_id = ?").all(root).some(row => String(row.prompt_text).includes("Use main and preserve local work."))).toBe(true);
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Cancel task", exact: true }).click();
    await page.getByText("Cancelled", { exact: true }).first().waitFor();
    expect((await value.api("GET", `/api/tasks/${task.id}`)).body).toMatchObject({ status: "cancelled" });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("backlog details save through the interface", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    const task = await value.createTask({ title: "Original title", description: "Original description", startImmediately: false, idempotencyKey: "backlog-edit" });
    await value.page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Edit task", exact: true }).click();
    await value.page.getByRole("dialog").getByText("Edit task", { exact: true }).waitFor();
    await value.page.getByLabel("Task title", { exact: true }).fill("Updated title");
    await value.page.getByLabel("Task description", { exact: true }).fill("Updated objective");
    await value.page.getByRole("button", { name: "Workflow", exact: true }).click();
    await value.page.getByRole("option", { name: "Simple task", exact: true }).click();
    await value.page.getByRole("button", { name: "Save task", exact: true }).click();
    await value.page.getByRole("heading", { name: "Updated title", level: 2, exact: true }).waitFor();
    expect((await value.api("GET", `/api/tasks/${task.id}`)).body).toMatchObject({ title: "Updated title", description: "Updated objective", status: "backlog", workflow: "direct_build" });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("Today answers questions across company boundaries without leaving the view", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    const seeded = await seedTodayFixture(value);
    await value.page.goto(`${value.base}/today`);
    await value.page.getByRole("heading", { name: "Needs you", exact: true }).waitFor();
    for (const task of seeded.questionTasks) {
      const row = value.page.locator("article").filter({ hasText: task.title });
      await row.getByLabel("Answer", { exact: true }).fill(`Use main for ${task.companyName}.`);
      await row.getByRole("button", { name: "Answer and continue", exact: true }).click();
      await expect.poll(() => {
        const control = value.database.prepare("SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?").get(task.id);
        const turns = value.database.prepare("SELECT prompt_text FROM suplex_task_turns WHERE task_id = ?").all(task.id);
        return {
          originalQuestionGone: control?.human_question_id !== task.questionId,
          answerPersisted: turns.some(turn => String(turn.prompt_text).includes(`Use main for ${task.companyName}.`)),
        };
      }, { timeout: 10_000 }).toEqual({ originalQuestionGone: true, answerPersisted: true });
      expect(new URL(value.page.url()).pathname).toBe("/today");
    }
    for (const task of seeded.questionTasks) {
      const control = value.database.prepare("SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?").get(task.id);
      expect(control?.human_question_id).not.toBe(task.questionId);
      const turns = value.database.prepare("SELECT prompt_text FROM suplex_task_turns WHERE task_id = ?").all(task.id);
      expect(turns.some(turn => String(turn.prompt_text).includes(`Use main for ${task.companyName}.`))).toBe(true);
    }
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("human questions show recommendations and accept Other at %ipx", async width => {
  const value = await nativeBrowser(width);
  try {
    for (const other of [false, true]) {
      const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Choose the runtime base", description: "Do not publish unrelated changes.", startImmediately: true, idempotencyKey: `question-${other}` });
      const options = [{ label: "Wait for main", description: "Keep this task paused until its dependency lands.", recommended: true }, { label: "Use another branch", description: "Provide the intended runtime branch.", recommended: false }];
      const root = value.tasks.repository.controls.claimRoot({ taskId: task.id });
      value.tasks.repository.controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: `ses_question_${other}` });
      value.tasks.repository.controls.askHuman(task.id, "Where should the runtime change go?", options);
      const { page } = value;
      await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
      const question = page.getByRole("form", { name: "Answer necessary" });
      await question.waitFor();
      await question.getByText("Recommended", { exact: true }).waitFor();
      expect(await question.getByRole("button", { name: "Answer and continue" }).isDisabled()).toBe(true);
      expect(value.tasks.getTask(value.userId, task.id).status).toBe("waiting_human");
      await page.reload();
      if (other) {
        await question.getByText("Other", { exact: true }).waitFor();
        expect(await question.getByRole("button", { name: "Answer and continue" }).isDisabled()).toBe(true);
        await question.getByLabel("Answer", { exact: true }).fill("Use runtime/native as the base.");
      } else await question.getByRole("radio", { name: /Wait for main/ }).click();
      await expect.poll(() => question.getByRole("button", { name: "Answer and continue" }).isEnabled()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(tmpdir(), `forge-question-${width}-${other}.png`), fullPage: true });
      const answered = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${task.id}/answer`));
      await question.getByRole("button", { name: "Answer and continue" }).click();
      const response = await answered;
      expect(response.status(), await response.text()).toBe(200);
      expect(response.request().postDataJSON()).toMatchObject({ answer: other ? "Use runtime/native as the base." : "Wait for main: Keep this task paused until its dependency lands." });
      expect(value.tasks.getTask(value.userId, task.id).status).toBe("active");
    }
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

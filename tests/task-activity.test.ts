import { expect, test } from "vitest";
import { TaskActivityResponseSchema } from "../src/http/contracts/tasks.js";
import { nativeApp } from "./helpers/native-app.js";

test("task activity accepts a session without runtime display metadata", () => {
  expect(TaskActivityResponseSchema.safeParse({
    sessions: [{ id: "session", kind: "root", advisorRole: null, label: "Coordinator", profileId: "profile", generation: 1, nativeSessionId: null, paneId: null, current: true }],
    turns: [],
    shellPaneId: null,
  }).success).toBe(true);
});

test("task activity reports the captured harness for every provider without depending on pane metadata", async () => {
  const value = await nativeApp();
  try {
    const cases = [
      { provider: "opencode", harness: "opencode", paneId: null },
      { provider: "claude-code", harness: "claude-code", paneId: "pane-stale-claude" },
      { provider: "codex", harness: "codex", paneId: null },
      { provider: "devin", harness: "devin", paneId: "pane-stale-devin" },
    ] as const;
    const tasks: Array<{ id: string; harness: typeof cases[number]["harness"]; paneId: string | null }> = [];

    for (const entry of cases) {
      value.profiles.update(value.userId, value.project.rootProfileId, { provider: entry.provider });
      const { task } = await value.tasks.createTask(value.userId, value.company.id, {
        projectId: value.project.id,
        title: `${entry.harness} activity`,
        description: "Read the captured runtime",
        idempotencyKey: `task-activity-${entry.harness}`,
        startImmediately: true,
      });
      const session = value.tasks.repository.controls.claimRoot({ taskId: task.id });
      if (entry.paneId) value.tasks.repository.controls.bindPane({ sessionId: session.id, generation: session.generation, paneId: entry.paneId });
      tasks.push({ id: task.id, harness: entry.harness, paneId: entry.paneId });
    }

    value.profiles.update(value.userId, value.project.rootProfileId, { provider: "opencode" });
    for (const task of tasks) {
      const response = await value.app.inject({ url: `/api/tasks/${task.id}/activity`, headers: value.headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().sessions).toEqual([
        expect.objectContaining({ profileId: value.project.rootProfileId, harness: task.harness, paneId: task.paneId }),
      ]);
    }
  } finally { await value.close(); }
});

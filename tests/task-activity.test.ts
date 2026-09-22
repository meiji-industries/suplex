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

test("task activity reports prompted and completed timestamps for each turn", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, {
      projectId: value.project.id,
      title: "Activity timestamps",
      description: "Read persisted turn timestamps",
      idempotencyKey: "task-activity-timestamps",
      startImmediately: true,
    });
    const session = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    const promptedAt = "2026-09-21T10:00:00.000Z";
    const completedAt = "2026-09-21T10:05:23.000Z";
    value.database.authTransaction(db => {
      db.prepare("INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, prompted_at, completed_at, created_at, updated_at) VALUES ('completed-turn', ?, ?, ?, 'hash', 'Completed prompt', 'completed', ?, ?, ?, ?), ('pending-turn', ?, ?, ?, 'hash', 'Pending prompt', 'pending_prompt', NULL, NULL, ?, ?)").run(task.id, session.id, session.generation, promptedAt, completedAt, promptedAt, completedAt, task.id, session.id, session.generation, promptedAt, promptedAt);
    });

    const response = await value.app.inject({ url: `/api/tasks/${task.id}/activity`, headers: value.headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().turns).toEqual([
      expect.objectContaining({ id: "completed-turn", promptedAt, completedAt }),
      expect.objectContaining({ id: "pending-turn", promptedAt: null, completedAt: null }),
    ]);
  } finally { await value.close(); }
});

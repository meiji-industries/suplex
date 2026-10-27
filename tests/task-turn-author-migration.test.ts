import { readFile } from "node:fs/promises";

import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

async function migrationSql(): Promise<string[]> {
  const source = await readFile(new URL("../apps/server/migrations/20261012174110023_task_turn_author.sql", import.meta.url), "utf8");
  return source.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

test("earlier answers take the person from their task_answered audit event", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE suplex_task_turns (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, prompt_text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE suplex_audit_events (id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO suplex_task_turns VALUES
        ('answer-chris', 'task-1', '{"question":"Q","answer":"A"}', '2026-10-12T10:00:00.000Z'),
        ('answer-adam', 'task-2', '{"question":"Q","answer":"B"}', '2026-10-12T10:00:00.000Z'),
        ('note', 'task-1', 'Human note:\nCheck', '2026-10-12T11:00:00.000Z');
      INSERT INTO suplex_audit_events VALUES
        ('a1', 'user_chris', 'task_answered', '{"taskId":"task-1","resultingState":"{}"}', '2026-10-12T10:00:00.000Z'),
        ('a2', 'user_development', 'task_answered', '{"taskId":"task-2","resultingState":"{}"}', '2026-10-12T10:00:00.000Z'),
        ('a3', 'user_development', 'task_cancelled', '{"taskId":"task-1","resultingState":"{}"}', '2026-10-12T11:00:00.000Z');
    `);
    for (const statement of await migrationSql()) database.exec(statement);

    expect(database.prepare("SELECT id, author_user_id FROM suplex_task_turns ORDER BY id").all()).toEqual([
      { id: "answer-adam", author_user_id: "user_development" },
      { id: "answer-chris", author_user_id: "user_chris" },
      { id: "note", author_user_id: null },
    ]);
  } finally {
    database.close();
  }
});

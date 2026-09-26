// Inspect a saved native timeline and its React rendering in an isolated Rust installation.
import { equal, ok } from "node:assert/strict";
import { nativeBrowser } from "../helpers/native-browser.js";

const fixture = await nativeBrowser();
try {
  const task = await fixture.createTask({ title: "Saved native timeline", description: "No runtime launch is needed", idempotencyKey: "timeline-interop", startImmediately: false });
  const sessionId = "timeline-saved-root";
  const nativeId = "codex-timeline-saved";
  const now = new Date().toISOString();
  fixture.database.prepare("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,native_session_id,lifecycle,created_at,updated_at) VALUES (?,?,'root',1,0,?,'stopped',?,?)")
    .run(sessionId, task.id, nativeId, now, now);
  const usage = (messageId: string, startedAt: number, completedAt: number) => ({
    sessionId: nativeId, messageId, turnId: "turn-one", role: "root", provider: "openai", model: "gpt-6-sol",
    startedAt, completedAt, failed: false, summary: false, steps: 1, cost: 0, subsidized: false,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message",
  });
  const insert = fixture.database.prepare("INSERT INTO suplex_task_usage (task_id,session_id,message_id,snapshot,observed_at) VALUES (?,?,?,?,?)");
  for (const item of [usage("message-two", 200, 300), usage("message-one", 100, 200)]) insert.run(task.id, nativeId, item.messageId, JSON.stringify(item), now);
  fixture.database.prepare("INSERT INTO suplex_task_analytics_sessions (session_id,task_id,observed_at,error_at) VALUES (?,?,?,NULL)").run(sessionId, task.id, now);
  const route = `/api/tasks/${task.id}/timeline`;
  const rust = await fixture.page.request.get(`${fixture.base}${route}`);
  equal(rust.status(), 200, await rust.text());
  equal(rust.headers()["cache-control"], "private, no-store");
  const timeline = await rust.json() as { tasks: Array<{ activity: unknown[] }> };
  equal(timeline.tasks.length, 1);
  ok(timeline.tasks[0]!.activity.length > 0);
  const missing = await fixture.page.request.get(`${fixture.base}/api/tasks/task_missing/timeline`);
  equal(missing.status(), 404);
  await fixture.page.goto(`${fixture.base}/tasks/${task.id}?company=${fixture.company.id}`);
  await fixture.page.getByText("Worked for", { exact: false }).waitFor();
  equal(fixture.errors.length, 0, fixture.errors.join("; "));
  console.log("Rust task timeline reads saved execution time and React renders it.");
} finally { await fixture.close(); }

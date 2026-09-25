// Compare the full task timeline HTTP response on one TypeScript-created database.
// Run with SUPLEX_BROWSER_BACKEND=rust and SUPLEX_RUST_BIN pointing at the staged binary.
import { deepStrictEqual, equal } from "node:assert/strict";
import { TaskAnalyticsStore } from "../../src/tasks/analytics/store.js";
import { TaskUsageSchema } from "../../src/tasks/usage.js";
import { nativeBrowser } from "../helpers/native-browser.js";

const fixture = await nativeBrowser();
try {
  const created = await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
    projectId: fixture.project.id,
    title: "Saved native timeline",
    description: "No runtime launch is needed",
    idempotencyKey: "timeline-interop",
    startImmediately: false,
  });
  const taskId = created.task.id;
  const sessionId = "timeline-saved-root";
  const nativeId = "codex-timeline-saved";
  const now = new Date().toISOString();
  fixture.database.authQuery(db => db.prepare(
    "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,native_session_id,lifecycle,created_at,updated_at) VALUES (?,?, 'root',1,0,?,'stopped',?,?)",
  ).run(sessionId, taskId, nativeId, now, now));
  const usage = (messageId: string, startedAt: number, completedAt: number) => TaskUsageSchema.parse({
    sessionId: nativeId, messageId, turnId: "turn-one", role: "root", provider: "openai", model: "gpt-6-sol",
    startedAt, completedAt, failed: false, summary: false, steps: 1, cost: 0, subsidized: false,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message",
  });
  new TaskAnalyticsStore(fixture.database).record(taskId, sessionId, [usage("message-two", 200, 300), usage("message-one", 100, 200)]);
  const route = `/api/tasks/${taskId}/timeline`;
  const typescript = await fixture.app.inject({ url: route, headers: fixture.headers });
  equal(typescript.statusCode, 200, typescript.body);
  const rust = await fixture.page.request.get(`${fixture.base}${route}`);
  equal(rust.status(), 200, await rust.text());
  equal(rust.headers()["cache-control"], "private, no-store");
  deepStrictEqual(await rust.json(), typescript.json());
  const missing = await fixture.page.request.get(`${fixture.base}/api/tasks/task_missing/timeline`);
  equal(missing.status(), 404);
  await fixture.page.goto(`${fixture.base}/tasks/${taskId}?company=${fixture.company.id}`);
  await fixture.page.getByText("Worked for", { exact: false }).waitFor();
  equal(fixture.errors.length, 0, fixture.errors.join("; "));
  console.log("Rust task timeline matches the complete TypeScript response and React renders saved execution time.");
} finally {
  await fixture.close();
}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AnalyticsHistoryReader } from "../src/tasks/analytics/collector.js";
import { taskSessionRuntimeDirectory } from "../src/runtimes/task-harness.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("analytics reads Devin usage from the Suplex session runtime directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-devin-analytics-"));
  directories.push(root);
  const databasePath = join(root, "suplex.sqlite");
  const session = { id: "suplex-session", nativeSessionId: "devin-reserved", kind: "worker" as const };
  const directory = taskSessionRuntimeDirectory(databasePath, session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "turn-turn-1.jsonl"), "Reviewed the change.\n");
  const reader = new AnalyticsHistoryReader(databasePath, join(root, "runtime", "analytics"));
  const usage = await reader.read(session);
  expect(usage).toMatchObject([{ sessionId: "devin-reserved", messageId: "turn-1", provider: "devin" }]);
});

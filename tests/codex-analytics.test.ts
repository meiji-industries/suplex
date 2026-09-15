import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AnalyticsHistoryReader } from "../src/tasks/analytics/collector.js";
import { modelPricingKey } from "../src/profiles/model-pricing.js";
import { taskSessionRuntimeDirectory } from "../src/runtimes/task-harness.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("analytics reads Codex usage and estimates its cost from the turn log", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-analytics-"));
  directories.push(root);
  const databasePath = join(root, "forge.sqlite");
  const session = { id: "forge-session", nativeSessionId: "codex-11111111-2222-4333-8444-555555555555", kind: "worker" as const };
  const directory = taskSessionRuntimeDirectory(databasePath, session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "turn-turn-1.jsonl"), [
    JSON.stringify({ type: "thread.started", thread_id: "11111111-2222-4333-8444-555555555555" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Done." } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 20 } }),
  ].join("\n") + "\n");
  const dispatch = (generation: string, turnId: string, model: string) => writeFile(join(directory, `dispatch-${generation}.json`), JSON.stringify({
    generation, turnId, sessionID: session.nativeSessionId, pid: 999_999,
    processIdentity: { command: "codex", executable: "/opt/codex/codex", argv: ["/opt/codex/codex", "exec", "--json", "-m", model, "-"], processGroup: 999_999, startTime: "0", ownerUid: 0 },
  }));
  // The latest dispatch used a different model; turn-1 keeps the one it ran with.
  await dispatch("0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e", "turn-1", "gpt-5.6-sol");
  await dispatch("1f1e2d3c-4b5a-4968-8778-695a4b3c2d1e", "turn-2", "gpt-6-astra");
  const pricing = new Map([[modelPricingKey("openai", "gpt-5.6-sol"), { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }]]);
  const reader = new AnalyticsHistoryReader(databasePath, join(root, "runtime", "analytics"));

  const usage = await reader.read(session, pricing);

  expect(usage).toMatchObject([{
    sessionId: session.nativeSessionId, messageId: "turn-1", turnId: "turn-1", provider: "openai", model: "gpt-5.6-sol",
    failed: false, steps: 1, subsidized: true, source: "message",
    tokens: { input: 300, output: 30, reasoning: 20, cache: { read: 600, write: 100 } },
  }]);
  expect(usage[0]!.cost).toBeCloseTo(0.003925, 10);
});

test("Codex usage is unpriced when the catalog has no entry for its model", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-analytics-"));
  directories.push(root);
  const databasePath = join(root, "forge.sqlite");
  const session = { id: "forge-session", nativeSessionId: "codex-unpriced", kind: "root" as const };
  const directory = taskSessionRuntimeDirectory(databasePath, session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "turn-turn-1.jsonl"), `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })}\n`);

  const usage = await new AnalyticsHistoryReader(databasePath, join(root, "runtime", "analytics")).read(session);

  expect(usage).toMatchObject([{ model: "unknown", cost: 0, subsidized: false, tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } } }]);
});

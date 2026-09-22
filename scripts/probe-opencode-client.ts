import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCodeClient } from "../src/runtimes/opencode/client.js";
import { createOpenCodePromptIntent, reconcileOpenCodePrompt, replayOpenCodePrompt } from "../src/runtimes/opencode/session.js";

const runtime = process.argv[2];
if (!runtime) throw new Error("Usage: tsx scripts/probe-opencode-client.ts <disposable-proof-directory>");
const baseUrl = (await readFile(join(runtime, "state/url"), "utf8")).trim();
const password = (await readFile(join(runtime, "state/password"), "utf8")).trim();
const directory = await realpath(join(runtime, "project"));
const client = new OpenCodeClient({ baseUrl, password });
const model = { providerID: "openai", modelID: "gpt-5.6-luna" };
const native = await client.createSession({ title: "Suplex production OpenCode client proof", directory, model: { id: model.modelID, providerID: model.providerID, variant: "max" }, agent: "build" });
const receipts: unknown[] = [];
for (const word of ["client-first-proof", "client-second-proof"]) {
  const intent = createOpenCodePromptIntent({ sessionID: native.id, directory, model, agent: "build", variant: "max", prompt: `Reply with exactly ${word}. Do not use tools.` });
  let claimed = false;
  await replayOpenCodePrompt(client, intent, async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const result = await reconcileOpenCodePrompt(client, { ...intent, dispatch: "ambiguous" });
    if (result.state === "completed") {
      assert.equal(result.native?.providerID, model.providerID);
      assert.equal(result.native?.modelID, model.modelID);
      receipts.push(result);
      break;
    }
    assert.ok(!["error", "interrupted", "terminal_incomplete"].includes(result.state), JSON.stringify(result));
    assert.ok(Date.now() < deadline, `No terminal response: ${JSON.stringify(result)}`);
    await delay(200);
  }
}
const messages = await client.getMessages(native.id, { directory });
assert.equal(messages.filter((message) => message.info.role === "user").length, 2);
const texts = messages.filter((message) => message.info.role === "assistant").flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text));
assert.deepEqual(texts, ["client-first-proof", "client-second-proof"]);
process.stdout.write(`${JSON.stringify({ version: (await client.health()).version, sessionID: native.id, directory, receipts }, null, 2)}\n`);

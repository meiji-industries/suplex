import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { ensureOpenCodeServer, openCodeRoleConfig, openCodeServerClient, openCodeProcessAlive, type OpenCodeServerReference } from "../src/opencode-server.js";
import { createOpenCodePromptIntent, reconcileOpenCodePrompt, replayOpenCodePrompt } from "../src/opencode-session.js";
import { createGitCommandGuard } from "../src/worktrees.js";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: tsx scripts/probe-opencode-runtime.ts <absolute-opencode-executable>");
const directory = await mkdtemp(join(tmpdir(), "forge-opencode-runtime-"));
await promisify(execFile)("git", ["init", "--quiet", directory]);
const profile = { providerID: "forge-proof", modelID: "proof", reasoningEffort: "max", serviceTier: "priority" } as const;
const live = new Set<OpenCodeServerReference>();
const checks: unknown[] = [];
let activeRole: "root" | "worker" = "root";
let turn = 0;
const advertised = new Map<string, string[]>();
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = z.object({ stream: z.boolean().optional(), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(JSON.parse(Buffer.concat(chunks).toString()));
  const names = body.tools?.map((tool) => tool.function.name) ?? [];
  let delta: Record<string, unknown> = { content: "proof complete" };
  let finish = "stop";
  if (names.length > 0) {
    advertised.set(activeRole, names);
    const step = turn++;
    if (step === 0 || activeRole === "worker" && step === 1) {
      delta = { tool_calls: [{ index: 0, id: `call_${activeRole}`, type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: step === 1 ? "git push" : `touch ${activeRole === "root" ? "forbidden" : "allowed"}.txt`, description: "Disposable permission probe" }),
      } }] };
      finish = "tool_calls";
    }
  }
  const envelope = { id: "chatcmpl-proof", object: "chat.completion.chunk", created: 1, model: "proof" };
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...envelope, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "proof complete" }, finish_reason: "stop" }] }));
  }
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
async function stop(reference: OpenCodeServerReference): Promise<void> {
  process.kill(reference.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (openCodeProcessAlive(reference.pid)) {
    assert.ok(Date.now() < deadline, "Scratch server did not stop");
    await delay(50);
  }
  live.delete(reference);
}
try {
  for (const role of ["root", "worker"] as const) {
    activeRole = role;
    turn = 0;
    const runtimeDirectory = join(directory, role);
    const config = openCodeRoleConfig({ role, profile });
    config.provider = { "forge-proof": { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "disposable-proof" }, models: { proof: { limit: { context: 128000, output: 4096 } } } } };
    config.small_model = "forge-proof/proof";
    const guard = role === "worker" ? await createGitCommandGuard(runtimeDirectory, "git-guard") : undefined;
    const input: Parameters<typeof ensureOpenCodeServer>[0] = { executable, directory, runtimeDirectory, config, ...(guard ? { env: guard.env } : {}) };
    const reference = await ensureOpenCodeServer(input);
    live.add(reference);
    assert.equal((await stat(join(runtimeDirectory, "server.json"))).mode & 0o777, 0o600);
    const client = openCodeServerClient(reference);
    const session = await client.createSession({ title: `Forge ${role} native permission proof`, directory, model: { id: profile.modelID, providerID: profile.providerID, variant: "max" }, agent: `forge-${role}` });
    const intent = createOpenCodePromptIntent({ sessionID: session.id, directory, model: { providerID: profile.providerID, modelID: profile.modelID }, agent: `forge-${role}`, variant: "max", prompt: "Execute the permission probe." });
    await replayOpenCodePrompt(client, intent, async () => true);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const result = await reconcileOpenCodePrompt(client, { ...intent, dispatch: "ambiguous" });
      if (result.state === "completed") break;
      assert.ok(!["error", "interrupted", "terminal_incomplete"].includes(result.state), JSON.stringify(result));
      assert.ok(Date.now() < deadline, JSON.stringify(result));
      await delay(100);
    }
    const names = advertised.get(role);
    assert.ok(names, "Provider must receive tool definitions");
    assert.ok(names.includes("read"), "Read tool must remain available");
    assert.equal(names.includes("bash"), role === "worker");
    assert.equal(names.includes("task"), false);
    if (role === "root") for (const name of ["edit", "write", "apply_patch"]) assert.equal(names.includes(name), false);
    const messages = await client.getMessages(session.id, { directory });
    const toolParts = z.array(z.object({ tool: z.string(), state: z.object({ status: z.string(), input: z.unknown(), output: z.string().optional() }) })).parse(messages.flatMap((message) => message.parts.filter((part) => part.type === "tool")));
    assert.ok(toolParts.length > 0, "Provider must attempt a tool call");
    assert.ok(toolParts.some((part) => part.tool === (role === "root" ? "invalid" : "bash") && part.state.status === "completed"));
    if (role === "worker") {
      assert.equal(await readFile(join(directory, "allowed.txt"), "utf8"), "");
      assert.ok(toolParts.some((part) => part.state.output?.includes("policy blocked git push")), "Worker shell must inherit the Git guard");
    }
    else assert.equal(await stat(join(directory, "forbidden.txt")).then(() => true, () => false), false);
    checks.push({ role, sessionID: session.id, advertisedTools: names, toolParts });
    assert.equal((await ensureOpenCodeServer(input)).pid, reference.pid);
    await stop(reference);
    const restarted = await ensureOpenCodeServer(input);
    live.add(restarted);
    assert.notEqual(restarted.generation, reference.generation);
    assert.equal((await openCodeServerClient(restarted).getSession(session.id, directory)).id, session.id);
    checks.push({ role, restartPreservedSession: session.id });
    await stop(restarted);
  }
  assert.ok(!(await readFile(join(directory, "forbidden.txt")).catch(() => null)));
  process.stdout.write(`${JSON.stringify({ directory, checks }, null, 2)}\n`);
} finally {
  for (const reference of live) await stop(reference);
  await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
}

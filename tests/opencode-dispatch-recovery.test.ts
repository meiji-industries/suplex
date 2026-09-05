import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CliHerdrClient } from "../src/herdr-client.js";
import { OpenCodeTaskRuntime, type OpenCodeTaskScope } from "../src/opencode-task-runtime.js";
import { createOpenCodePromptIntent } from "../src/opencode-session.js";
import { OpenCodeServerReferenceSchema, type OpenCodeServerReference } from "../src/opencode-server.js";

test.each(["absent", "admitted", "tool_running", "tool_error", "busy", "bad_history", "bad_status"])("dispatch fencing retains the replacement server and reads native history when %s", async evidence => {
  const directory = await mkdtemp(join(tmpdir(), "forge-dispatch-fence-"));
  const sessionID = "ses_fence";
  const scope: OpenCodeTaskScope = { id: "session-proof", taskId: "task-proof", directory, role: "worker", profile: { providerID: "openai", modelID: "test", reasoningEffort: "medium", serviceTier: "default" } };
  const intent = createOpenCodePromptIntent({ sessionID, directory, prompt: "Do one operation", model: { providerID: "openai", modelID: "test" }, agent: "forge-worker", variant: "medium", dispatch: "ambiguous" });
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET") posts++;
    const path = new URL(request.url!, "http://localhost").pathname;
    let result: unknown;
    if (path === `/session/${sessionID}`) result = { id: sessionID, projectID: "project", directory, title: "Retained", version: "1", time: { created: 1, updated: 1 } };
    else if (path === `/session/${sessionID}/message`) {
      result = evidence === "bad_history" ? [{}] : ["admitted", "tool_running", "tool_error"].includes(evidence) ? [
        { info: { id: intent.messageID, sessionID, role: "user", time: { created: 1 }, model: intent.model, agent: intent.agent }, parts: [{ type: "text", text: intent.prompt }] },
        ...(evidence.startsWith("tool_") ? [{ info: { id: "msg_assistant", sessionID, role: "assistant", parentID: intent.messageID, time: { created: 2 }, modelID: "test", providerID: "openai", mode: "forge-worker", agent: "forge-worker", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...(evidence === "tool_error" ? { error: { name: "MessageAbortedError" } } : {}) }, parts: [{ type: "tool", callID: "call_probe", tool: "bash", state: { status: evidence === "tool_error" ? "error" : "running" } }] }] : []),
      ] : [];
    }
    else if (path === "/session/status") result = evidence === "bad_status" ? { [sessionID]: { type: "unrecognized" } } : evidence === "busy" ? { [sessionID]: { type: "busy" } } : {};
    else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test listener has no address");
    const runtimeDirectory = join(directory, "runtime", "task-sessions", scope.id);
    await mkdir(runtimeDirectory, { recursive: true });
    const old: OpenCodeServerReference = { pid: 2_147_483_647, baseUrl: "http://127.0.0.1:1", password: "a".repeat(64), directory, executable: "/old-opencode", generation: "b775df17-718a-4cb2-8e23-6912b8aa0d39", configHash: "a".repeat(64), processIdentity: { command: "opencode serve", executable: "/old-opencode", argv: ["opencode", "serve"], processGroup: 2_147_483_647, startTime: "old-start", ownerUid: process.getuid?.() ?? 0 } };
    const replacement = { ...old, pid: process.pid, generation: "c775df17-718a-4cb2-8e23-6912b8aa0d39", baseUrl: `http://127.0.0.1:${address.port}`, password: "b".repeat(64) };
    await writeFile(join(runtimeDirectory, `dispatch-server-${old.generation}.json`), JSON.stringify(old));
    await writeFile(join(runtimeDirectory, "server.json"), JSON.stringify(replacement));
    class Runtime extends OpenCodeTaskRuntime {
      override async ensureSession(actualScope: OpenCodeTaskScope, actualSession: string | null): Promise<string> {
        expect(actualScope).toEqual(scope);
        expect(actualSession).toBe(sessionID);
        return sessionID;
      }
    }
    const runtime = new Runtime(join(directory, "forge.sqlite"), new CliHerdrClient());
    for (let retry = 0; retry < 2; retry++) {
      const result = await runtime.recoverDispatch(scope, intent, { serverGeneration: old.generation, claimedAt: "2020-01-01T00:00:00.000Z" });
      expect(result.retry).toBe(evidence === "absent" ? "allowed" : "forbidden");
      if (evidence === "admitted") expect(result.admission).toBe("observed");
      if (evidence.startsWith("tool_")) expect(result).toMatchObject({ state: "unknown", executionUncertain: { stoppedServerGeneration: old.generation } });
      expect(result.sessionID).toBe(sessionID);
      expect(OpenCodeServerReferenceSchema.parse(JSON.parse(await readFile(join(runtimeDirectory, "server.json"), "utf8"))).generation).toBe(replacement.generation);
    }
    expect(posts).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

import { afterEach, expect, test, vi } from "vitest";
import * as commands from "../src/platform/command-runner.js";
import * as executables from "../src/platform/executable-resolver.js";
import { readOpenCodeHistory } from "../src/runtimes/opencode/session-history.js";
import { historyFromOpenCodeMessages, OpenCodeSessionReader } from "../src/runtimes/opencode/session-reader.js";
import { OpenCodeMessageEnvelopeSchema } from "../src/runtimes/opencode/contracts.js";
import type { TaskSession } from "../src/tasks/control.js";

afterEach(() => vi.restoreAllMocks());
const session: TaskSession = { id: "old", taskId: "task", kind: "worker", generation: 1, current: false, nativeSessionId: "ses_old", lifecycle: "cancelled", paneId: null, assignmentHash: null, launchOwner: null, launchOwnerPid: null, launchOwnerStartTime: null, stopRequestedAt: "now", stoppedAt: "now", advisorRole: null, workflowInput: null };
const message = { info: { id: "msg_result", sessionID: "ses_old", role: "assistant", time: { created: 100, completed: 200 }, parentID: "msg_user", modelID: "model", providerID: "openai", mode: "primary", agent: "forge-worker", path: { cwd: "/repo", root: "/repo" }, cost: 3, tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } } }, parts: [] };
function exported(id = "ses_old") {
  vi.spyOn(executables, "resolveOpenCodeExecutable").mockResolvedValue("/bin/opencode");
  return vi.spyOn(commands, "readCommandOutput").mockResolvedValue(JSON.stringify({ info: { id }, messages: [message] }));
}
test("retired Worker spend remains readable without its server or worktree", async () => {
  const run = exported();
  const result = await new OpenCodeSessionReader("/absent/forge.sqlite").timeline(session);
  expect(result.usage).toMatchObject([{ cost: 3, sessionId: "ses_old" }]);
  expect(result.liveMessageId).toBeNull();
  expect(run).toHaveBeenCalledWith("/bin/opencode", ["export", "--pure", "ses_old"]);
});
test("an export from another session cannot replace spend history", async () => {
  exported("ses_other");
  await expect(readOpenCodeHistory("ses_old")).rejects.toThrow("another session");
});

test("native machine output survives an immediate process exit after a large write", async () => {
  const stdout = await commands.readCommandOutput(process.execPath, ["-e", "require('node:fs').writeSync(1, JSON.stringify({text: 'x'.repeat(200000)})); process.exit(0)"]);
  expect(JSON.parse(stdout).text).toHaveLength(200000);
});

test("history maps stable text and tool identities with complete native output", () => {
  const output = "x".repeat(100_000);
  const messages = [
    OpenCodeMessageEnvelopeSchema.parse({
      info: { id: "msg_user", sessionID: "ses_old", role: "user", time: { created: 10 }, agent: "forge-worker", model: { providerID: "openai", modelID: "model" } },
      parts: [{ id: "prt_user", type: "text", text: "Inspect the repository" }],
    }),
    OpenCodeMessageEnvelopeSchema.parse({
      ...message,
      parts: [{ id: "prt_text", type: "text", text: "Complete" }, { id: "prt_tool", type: "tool", callID: "call_1", tool: "read", state: { status: "completed", input: { path: "/repo/file" }, output } }],
    }),
  ];
  expect(historyFromOpenCodeMessages([messages[1]!, messages[0]!])).toEqual([
    { id: "msg_user", role: "user", createdAt: 10, content: [{ id: "prt_user", type: "text", text: "Inspect the repository" }] },
    { id: "msg_result", role: "assistant", createdAt: 100, content: [
      { id: "prt_text", type: "text", text: "Complete" },
      { id: "prt_tool", type: "tool", name: "read", status: "completed", input: { path: "/repo/file" }, output, error: null },
    ] },
  ]);
});

import { expect, test } from "vitest";
import { OpenCodeMessageEnvelopeSchema } from "../src/runtimes/opencode/contracts.js";

import {
  createOpenCodeMessageID,
  createOpenCodePromptIntent,
  correlatedAssistants,
  openCodeModel,
  reconcileOpenCodePrompt,
  replayOpenCodePrompt,
  type OpenCodePromptReadPort,
} from "../src/runtimes/opencode/session.js";

const intent = createOpenCodePromptIntent({
  sessionID: "ses_task",
  directory: "/tmp/forge-opencode-task",
  model: { providerID: "openai", modelID: "gpt-5.6-luna" },
  agent: "forge-root",
  variant: "max",
  prompt: "Inspect the task and report the result.",
  messageID: "msg_task",
});

const session = {
  id: "ses_task",
  projectID: "project",
  directory: "/tmp/forge-opencode-task",
  title: "Task",
  version: "1.18.29",
  time: { created: 1, updated: 2 },
};
const user = {
  id: "msg_task",
  sessionID: "ses_task",
  role: "user" as const,
  time: { created: 3 },
  agent: "forge-root",
  model: { providerID: "openai", modelID: "gpt-5.6-luna" },
};

function assistant(input: {
  id: string;
  created: number;
  completed?: number;
  finish?: string;
  parentID?: string;
  agent?: string;
  summary?: boolean;
  parts?: unknown[];
  error?: { name: string; data?: Record<string, unknown> };
}) {
  return {
    info: {
      id: input.id,
      sessionID: "ses_task",
      role: "assistant" as const,
      time: { created: input.created, ...(input.completed === undefined ? {} : { completed: input.completed }) },
       parentID: input.parentID ?? "msg_task",
       modelID: "gpt-5.6-luna",
       providerID: "openai",
       mode: "build",
       agent: input.agent ?? "forge-root",
       ...(input.summary === undefined ? {} : { summary: input.summary }),
      path: { cwd: "/tmp/forge-opencode-task", root: "/tmp/forge-opencode-task" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(input.finish === undefined ? {} : { finish: input.finish }),
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    parts: input.parts ?? [],
  };
}

function port(input: {
  messages: unknown[];
  status?: { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number };
  fail?: boolean;
  failStatus?: boolean;
  failPrompt?: boolean;
  prompts?: string[];
}): OpenCodePromptReadPort {
  return {
    getSession: async () => {
      if (input.fail) throw new Error("temporary server read failure");
      return session;
    },
    getMessages: async () => {
      if (input.fail) throw new Error("temporary message read failure");
      return input.messages;
    },
    getStatus: async () => {
      if (input.fail || input.failStatus) throw new Error("temporary status read failure");
      return { ses_task: input.status ?? { type: "idle" } };
    },
    promptAsync: async (request) => {
      input.prompts?.push(request.messageID);
      if (input.failPrompt) throw new Error("prompt request failed after claim");
    },
  };
}

const allowClaim = async () => true;

test("historical turn correlation excludes tools from a later assignment and needs the admitted prompt", () => {
  const laterUser = { ...user, id: "msg_later", time: { created: 6 } };
  const first = assistant({ id: "msg_first", parentID: "msg_task", created: 4, completed: 5, finish: "stop", parts: [{ type: "tool", callID: "first-tool", tool: "bash", state: { status: "completed", input: { command: "pnpm test" }, output: "passed" } }] });
  const later = assistant({ id: "msg_later_answer", parentID: "msg_later", created: 7, completed: 8, finish: "stop", parts: [{ type: "tool", callID: "later-tool", tool: "bash", state: { status: "completed", input: { command: "pnpm lint" }, output: "passed" } }] });
  const history = [{ info: user, parts: [{ type: "text", text: intent.prompt }] }, first, { info: laterUser, parts: [{ type: "text", text: "Second assignment" }] }, later].map(value => OpenCodeMessageEnvelopeSchema.parse(value));
  expect(correlatedAssistants(history, "msg_task")).toMatchObject({ promptFound: true, messages: [{ info: { id: "msg_first" } }] });
  expect(correlatedAssistants(history, "missing")).toMatchObject({ promptFound: false, messages: [] });
});

test.each(["pending", "running"])("a final assistant does not complete a turn with a %s tool", async (status) => {
  const result = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_final", created: 4, completed: 6, finish: "stop", parts: [
      { type: "tool", callID: "call-active", tool: "bash", state: { status, input: {}, title: "active", time: { start: 5 } } },
    ] }),
  ] }), intent);
  expect(result).toMatchObject({ state: "running", reason: "tool_pending_or_running", retry: "forbidden" });
});

test("a later user does not hide an exact-parent final response", async () => {
  const result = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    { info: { ...user, id: "msg_later_user", time: { created: 4 } }, parts: [{ type: "text", text: "A queued follow-up" }] },
    assistant({ id: "msg_original_final", parentID: intent.messageID, created: 5, completed: 6, finish: "stop" }),
  ] }), intent);
  expect(result).toMatchObject({ state: "completed", assistantMessageID: "msg_original_final", retry: "forbidden" });
});

test("a final assistant does not hide an unfinished correlated assistant", async () => {
  const result = await reconcileOpenCodePrompt(port({ status: { type: "busy" }, messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_unfinished", created: 4 }),
    assistant({ id: "msg_final", created: 5, completed: 6, finish: "stop" }),
  ] }), intent);
  expect(result).toMatchObject({ state: "running", retry: "forbidden" });
});

test("generated prompt IDs use OpenCode's ascending native message format", () => {
  const first = createOpenCodeMessageID(1_788_576_300_000);
  const second = createOpenCodeMessageID(1_788_576_300_000);

  expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect(second).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect(first < second).toBe(true);
});

test("native final response completes only after a preceding tool step", async () => {
  const result = await reconcileOpenCodePrompt(port({
    messages: [
      { info: user, parts: [{ type: "text", text: intent.prompt }] },
      assistant({ id: "msg_tool_step", created: 4, completed: 5, finish: "tool-calls", parts: [{ type: "tool", callID: "call-1", tool: "bash", state: { status: "completed", input: {}, output: "read-only result", title: "bash", metadata: {}, time: { start: 4, end: 5 } } }] }),
      assistant({ id: "msg_final", created: 6, completed: 7, finish: "stop", parts: [{ type: "text", text: "The task is complete." }] }),
    ],
  }), intent);

  expect(result).toMatchObject({
    state: "completed",
    admission: "observed",
    retry: "forbidden",
    assistantMessageID: "msg_final",
    native: { providerID: "openai", modelID: "gpt-5.6-luna", finish: "stop" },
  });
  expect(result.assistantMessageIDs).toEqual(["msg_tool_step", "msg_final"]);
});

test("a completed tool step is not a completed turn while its tool is running", async () => {
  const result = await reconcileOpenCodePrompt(port({
    status: { type: "busy" },
    messages: [
      { info: user, parts: [{ type: "text", text: intent.prompt }] },
      assistant({ id: "msg_tool_step", created: 4, completed: 5, finish: "tool-calls", parts: [
        { type: "tool", callID: "call-1", tool: "read", state: { status: "completed", input: {}, output: "first result", title: "read", metadata: {}, time: { start: 4, end: 5 } } },
        { type: "tool", callID: "call-2", tool: "bash", state: { status: "running", input: {}, title: "sleep", time: { start: 5 } } },
      ] }),
    ],
  }), intent);

  expect(result.state).toBe("running");
  expect(result.assistantMessageID).toBe("msg_tool_step");
  expect(result.reason).toBe("tool_pending_or_running");
});

test("a completed tool step without a final response is recovered after native activity stops", async () => {
  const result = await reconcileOpenCodePrompt(port({
    messages: [
      { info: user, parts: [{ type: "text", text: intent.prompt }] },
      assistant({ id: "msg_tool_step", created: 4, completed: 5, finish: "tool-calls", parts: [{ type: "tool", callID: "call-1", tool: "bash", state: { status: "completed", input: {}, output: "done", title: "bash", metadata: {}, time: { start: 4, end: 5 } } }] }),
    ],
  }), intent);

  expect(result.state).toBe("interrupted");
  expect(result.assistantMessageID).toBe("msg_tool_step");
  expect(result.reason).toBe("native_idle_incomplete");
});

test("native assistant errors distinguish provider failure from interruption", async () => {
  const error = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_error", created: 4, completed: 5, error: { name: "ProviderAuthError", data: { providerID: "openai", message: "authentication failed" } } }),
  ] }), intent);
  const interrupted = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_interrupted", created: 4, completed: 5, error: { name: "MessageAbortedError", data: { message: "aborted" } } }),
  ] }), intent);

  expect(error.state).toBe("error");
  expect(interrupted.state).toBe("interrupted");
});

test.each([
  ["length", "terminal_incomplete"],
  ["content-filter", "terminal_incomplete"],
] as const)("native %s finish is terminal incomplete, not an admitted forever state", async (finish, state) => {
  const result = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_incomplete", created: 4, completed: 5, finish, parts: [{ type: "text", text: "partial" }] }),
  ] }), intent);

  expect(result.state).toBe(state);
  expect(result.assistantMessageID).toBe("msg_incomplete");
});

test("a native stop is terminal even when it has no text part", async () => {
  const result = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_empty_final", created: 4, completed: 5, finish: "stop" }),
  ] }), intent);

  expect(result.state).toBe("completed");
});

test("automatic compaction follows the synthetic continuation without accepting its summary", async () => {
  const compactionUser = {
    info: { ...user, id: "msg_compaction", time: { created: 6 } },
    parts: [{ type: "compaction", auto: true }],
  };
  const syntheticContinuation = {
    info: { ...user, id: "msg_synthetic_continuation", time: { created: 9 } },
    parts: [{ type: "text", synthetic: true, text: "Continue if you have next steps." }],
  };
  const result = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_tool_before_compaction", created: 4, completed: 5, finish: "tool-calls", parts: [{ type: "tool", callID: "call-1", tool: "read", state: { status: "completed", input: {}, output: "done", title: "read", metadata: {}, time: { start: 4, end: 5 } } }] }),
    compactionUser,
    assistant({ id: "msg_compaction_summary", created: 7, completed: 8, finish: "stop", agent: "compaction", summary: true, parentID: "msg_compaction", parts: [{ type: "text", text: "A summary that is not the task result." }] }),
    syntheticContinuation,
    assistant({ id: "msg_continued_final", created: 10, completed: 11, finish: "stop", parentID: "msg_synthetic_continuation", parts: [{ type: "text", text: "The task is complete." }] }),
  ] }), intent);

  expect(result).toMatchObject({ state: "completed", assistantMessageID: "msg_continued_final" });
  expect(result.assistantMessageIDs).toEqual(["msg_tool_before_compaction", "msg_continued_final"]);
});

test("an unresolved compaction continuation is explicit unknown", async () => {
  const result = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    { info: { ...user, id: "msg_compaction_only", time: { created: 6 } }, parts: [{ type: "compaction", auto: true }] },
    assistant({ id: "msg_compaction_only_summary", created: 7, completed: 8, finish: "stop", agent: "compaction", summary: true, parentID: "msg_compaction_only" }),
  ] }), intent);

  expect(result).toMatchObject({ state: "unknown", admission: "observed", retry: "forbidden", reason: "continuation_ambiguous" });
});

test("a later real user ends the assignment boundary", async () => {
  const laterUser = { info: { ...user, id: "msg_later_real_user", time: { created: 5 } }, parts: [{ type: "text", text: "Start a different task." }] };
  const result = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    laterUser,
    assistant({ id: "msg_later_real_answer", created: 6, completed: 7, finish: "stop", parentID: "msg_later_real_user", parts: [{ type: "text", text: "Unrelated answer." }] }),
  ] }), intent);

  expect(result).toMatchObject({ state: "unknown", admission: "observed", retry: "forbidden", reason: "later_user_boundary" });
  expect(result.assistantMessageID).toBeUndefined();
});

test("a native content-filter error is an error, not a missing continuation", async () => {
  const result = await reconcileOpenCodePrompt(port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_filtered", created: 4, completed: 5, error: { name: "ContentFilterError", data: { message: "filtered" } } }),
  ] }), intent);

  expect(result.state).toBe("error");
});

test("a terminal native message remains authoritative when the status read fails", async () => {
  const result = await reconcileOpenCodePrompt(port({ failStatus: true, messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_final_without_status", created: 4, completed: 5, finish: "stop", parts: [{ type: "text", text: "done" }] }),
  ] }), intent);

  expect(result).toMatchObject({ state: "completed", assistantMessageID: "msg_final_without_status", retry: "forbidden" });
  expect(result.status).toBeUndefined();
});

test("missing status certainty forbids a new dispatch", async () => {
  const prompts: string[] = [];
  const result = await reconcileOpenCodePrompt(port({ failStatus: true, messages: [], prompts }), intent);

  expect(result).toMatchObject({ state: "unknown", retry: "forbidden", reason: "native_status_unavailable" });
  await expect(replayOpenCodePrompt(port({ failStatus: true, messages: [], prompts }), intent, allowClaim)).rejects.toMatchObject({ code: "replay_blocked" });
  expect(prompts).toEqual([]);
});

test("transient server or native reads remain unknown and cannot be replayed", async () => {
  const prompts: string[] = [];
  const result = await reconcileOpenCodePrompt(port({ fail: true, messages: [], prompts }), intent);

  expect(result).toMatchObject({ state: "unknown", admission: "unknown", retry: "forbidden" });
  await expect(replayOpenCodePrompt(port({ fail: true, messages: [], prompts }), intent, allowClaim)).rejects.toMatchObject({ code: "replay_blocked" });
  expect(prompts).toEqual([]);
});

test("a never-submitted intent can dispatch after a successful absent-message read", async () => {
  const prompts: string[] = [];
  const reader = port({ messages: [], status: { type: "idle" }, prompts });
  const result = await reconcileOpenCodePrompt(reader, intent);
  expect(result).toMatchObject({ state: "unknown", admission: "not_observed", retry: "allowed" });

  await expect(replayOpenCodePrompt(reader, intent, allowClaim)).resolves.toEqual({ messageID: "msg_task" });
  expect(prompts).toEqual(["msg_task"]);
});

test("dispatch sends role instructions as a system prompt without changing the server scope", async () => {
  const reader = port({ messages: [], status: { type: "idle" } });
  let system: string | undefined;
  reader.promptAsync = async input => { system = input.system; };
  await replayOpenCodePrompt(reader, { ...intent, system: "Coordinator owns planning and independent review." }, allowClaim);
  expect(system).toBe("Coordinator owns planning and independent review.");
});

test("an omitted entry in a successful status map means idle, not an unavailable read", async () => {
  const reader = port({ messages: [] });
  reader.getStatus = async () => ({});
  await expect(reconcileOpenCodePrompt(reader, intent)).resolves.toMatchObject({ retry: "allowed" });
  await expect(reconcileOpenCodePrompt(reader, { ...intent, dispatch: "ambiguous" })).resolves.toMatchObject({ retry: "forbidden" });
});

test("malformed tool records cannot fall through as unknown part types", async () => {
  const reader = port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_bad_tool", created: 4, completed: 5, finish: "stop", parts: [{ type: "tool", callID: "call", tool: "bash" }] }),
  ] });
  await expect(reconcileOpenCodePrompt(reader, intent)).resolves.toMatchObject({ state: "unknown", reason: "native_read_unavailable" });
});

test("an ambiguous lost acknowledgement stays fenced while native admission is delayed", async () => {
  let reads = 0;
  const prompts: string[] = [];
  const delayed = port({ messages: [], status: { type: "idle" }, prompts });
  delayed.getMessages = async () => {
    reads += 1;
    return reads === 1 ? [] : [{ info: { ...user, time: { created: Date.now() } }, parts: [{ type: "text", text: intent.prompt }] }];
  };
  const ambiguous = { ...intent, dispatch: "ambiguous" as const };

  const beforeAdmission = await reconcileOpenCodePrompt(delayed, ambiguous);
  const afterAdmission = await reconcileOpenCodePrompt(delayed, ambiguous);

  expect(beforeAdmission).toMatchObject({ state: "unknown", admission: "not_observed", retry: "forbidden", reason: "admission_ambiguous" });
  expect(afterAdmission).toMatchObject({ state: "admitted", admission: "observed", retry: "forbidden" });
  await expect(replayOpenCodePrompt(delayed, ambiguous, allowClaim)).rejects.toMatchObject({ code: "replay_blocked" });
  expect(prompts).toEqual([]);
});

test("two replay callers use one durable atomic claim and only one posts", async () => {
  const prompts: string[] = [];
  const reader = port({ messages: [], status: { type: "idle" }, prompts });
  let claimed = false;
  const claim = async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  };

  const results = await Promise.allSettled([
    replayOpenCodePrompt(reader, intent, claim),
    replayOpenCodePrompt(reader, intent, claim),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(prompts).toEqual(["msg_task"]);
});

test("a failed POST after durable claim stays ambiguous and cannot be replayed", async () => {
  const prompts: string[] = [];
  const reader = port({ failPrompt: true, messages: [], status: { type: "idle" }, prompts });
  let dispatch: "not_submitted" | "ambiguous" = "not_submitted";
  const claim = async () => {
    if (dispatch !== "not_submitted") return false;
    dispatch = "ambiguous";
    return true;
  };

  await expect(replayOpenCodePrompt(reader, intent, claim)).rejects.toThrow("prompt request failed after claim");
  await expect(replayOpenCodePrompt(reader, { ...intent, dispatch }, claim)).rejects.toMatchObject({ code: "replay_blocked" });
  expect(prompts).toEqual(["msg_task"]);
});

test("message IDs and prompt text are correlated before a retry", async () => {
  const mismatch = await reconcileOpenCodePrompt(port({ messages: [
    { info: { ...user, id: "msg_task" }, parts: [{ type: "text", text: "different prompt" }] },
  ] }), intent);

  expect(mismatch).toMatchObject({ state: "unknown", admission: "unknown", retry: "forbidden", reason: "message_id_conflict" });
});

test("session identity and canonical directory are checked before absence can be replayable", async () => {
  const wrongSession = port({ messages: [], status: { type: "idle" } });
  wrongSession.getSession = async () => ({ ...session, id: "ses_other" });
  await expect(reconcileOpenCodePrompt(wrongSession, intent)).resolves.toMatchObject({ reason: "session_identity_conflict", retry: "forbidden" });

  const wrongDirectory = port({ messages: [], status: { type: "idle" } });
  wrongDirectory.getSession = async () => ({ ...session, directory: "/tmp/another-task" });
  await expect(reconcileOpenCodePrompt(wrongDirectory, intent)).resolves.toMatchObject({ reason: "session_directory_mismatch", retry: "forbidden" });
});

test.skipIf(process.platform !== "darwin")("deliberately treats macOS /tmp and /private/tmp as one canonical directory", async () => {
  const macOSAlias = port({ messages: [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_alias_final", created: 4, completed: 5, finish: "stop", parts: [{ type: "text", text: "done" }] }),
  ], status: { type: "idle" } });
  macOSAlias.getSession = async () => ({ ...session, directory: `/private${intent.directory}` });

  await expect(reconcileOpenCodePrompt(macOSAlias, {
    ...intent,
    dispatch: "not_submitted",
  })).resolves.toMatchObject({ admission: "observed", state: "completed", assistantMessageID: "msg_alias_final" });
});

test("the same native session history remains authoritative after a client restart", async () => {
  const history = [
    { info: user, parts: [{ type: "text", text: intent.prompt }] },
    assistant({ id: "msg_final", created: 6, completed: 7, finish: "stop", parts: [{ type: "text", text: "done" }] }),
  ];
  const first = await reconcileOpenCodePrompt(port({ messages: history }), intent);
  const afterRestart = await reconcileOpenCodePrompt(port({ messages: history }), intent);

  expect(afterRestart).toMatchObject({ state: "completed", assistantMessageID: first.assistantMessageID, native: first.native });
});

test("an idle unfinished assistant becomes an interrupted turn without replay", async () => {
  const reader = port({ messages: [{ info: user, parts: [{ type: "text", text: intent.prompt }] }, assistant({ id: "msg_empty", created: 4 })] });
  await expect(reconcileOpenCodePrompt(reader, intent)).resolves.toMatchObject({ state: "interrupted", reason: "native_idle_incomplete", admission: "observed", retry: "forbidden", interruptedExecution: { lastActivityAt: 4 } });
});

test.each(["busy", "retry", "unavailable", "recent"])("does not recover an unfinished turn while native state is %s", async condition => {
  const reader = port({ messages: [{ info: user, parts: [{ type: "text", text: intent.prompt }] }, assistant({ id: "msg_empty", created: condition === "recent" ? Date.now() : 4 })], ...(condition === "busy" ? { status: { type: "busy" as const } } : condition === "retry" ? { status: { type: "retry" as const, attempt: 1, message: "retry", next: Date.now() } } : {}), failStatus: condition === "unavailable" });
  expect((await reconcileOpenCodePrompt(reader, intent)).state).not.toBe("interrupted");
});


test("native activity appearing during the idle confirmation prevents recovery", async () => {
  let checks = 0;
  const reader = port({ messages: [{ info: user, parts: [{ type: "text", text: intent.prompt }] }, assistant({ id: "msg_empty", created: 4 })] });
  reader.getStatus = async () => ({ ses_task: { type: ++checks === 1 ? "idle" : "busy" } });
  expect((await reconcileOpenCodePrompt(reader, intent)).state).toBe("running");
});

test("a failed tool receipt alone does not prove execution stopped", async () => {
  const reader = port({ messages: [{ info: user, parts: [{ type: "text", text: intent.prompt }] }, assistant({ id: "msg_tool", created: 4, completed: 5, finish: "tool-calls", parts: [{ type: "tool", callID: "call-1", tool: "bash", state: { status: "error", input: {}, error: "Command timed out", time: { start: 4, end: 5 } } }] }), assistant({ id: "msg_empty", created: 6 })] });
  expect(await reconcileOpenCodePrompt(reader, intent)).toMatchObject({ state: "running", unsettledTools: true, retry: "forbidden" });
});

test("a vendor-qualified model id reaches OpenCode as its own provider and bare model", () => {
  expect(openCodeModel("openai/gpt-5.6-luna")).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" });
  expect(openCodeModel("github-copilot/claude-fable-5/preview")).toEqual({ providerID: "github-copilot", modelID: "claude-fable-5/preview" });
  expect(() => openCodeModel("gpt-5.6-luna")).toThrow(/vendor-qualified/);
  expect(() => openCodeModel("/gpt-5.6-luna")).toThrow(/vendor-qualified/);
});

// A fake `agy` for tests. `agy acp` speaks ACP 1 on stdio with the session
// options, permission requests, and sign-in errors that Suplex relies on.
// FAKE_AGY_STATE keeps sessions across processes; FAKE_AGY_LOG records what
// the client sent. FAKE_AGY_MODE selects `signed-out`, `auth-once`, or
// `old` behavior.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE ?? "";
const version = mode === "old" ? "1.4.2" : "1.5.12";
const state = process.env.FAKE_AGY_STATE;
const log = (entry) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`);
};

if (args[0] === "--version") {
  process.stdout.write(`agy ${version}\n`);
  process.exit(0);
}
if (args[0] !== "acp") process.exit(2);
log({ argv: args, cwd: process.cwd(), path: (process.env.PATH ?? "").split(":")[0], browser: process.env.BROWSER, rootToken: Boolean(process.env.SUPLEX_ROOT_TOKEN) });

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
let authenticated = mode !== "auth-once";
let nextId = 1000;
const pending = new Map();
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ id, method, params });
});

const sessionFile = (id) => join(state, `${id}.json`);
const loadSession = (id) => existsSync(sessionFile(id)) ? JSON.parse(readFileSync(sessionFile(id), "utf8")) : null;
const saveSession = (session) => { mkdirSync(state, { recursive: true }); writeFileSync(sessionFile(session.id), JSON.stringify(session)); };
const options = (session) => [
  { id: "model", name: "Model", type: "select", currentValue: session.model, options: [{ value: "gemini-a", name: "Gemini A" }, { group: "partner", name: "Partner", options: [{ value: "gemini-b", name: "Gemini B" }] }] },
  { id: "thinking", name: "Thinking level", category: "thought_level", type: "select", currentValue: session.thinking, options: ["low", "medium", "high", "extra", "max"].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })) },
];

async function handle(message) {
  const { id, method, params } = message;
  log({ method, params });
  const reply = (result) => send({ id, result });
  const fail = (code, text) => send({ id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentInfo: { name: "antigravity", title: "Antigravity ACP Server", version }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "gemini-api-key", name: "Gemini API key" }] });
    case "authenticate":
      if (mode === "signed-out") {
        process.stdout.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?state=x\n");
        return;
      }
      authenticated = true;
      return reply({});
    case "session/new": {
      if (mode === "signed-out" || !authenticated) return fail(-32000, "Authentication required");
      const session = { id: `native-${Math.random().toString(16).slice(2)}`, model: "gemini-a", thinking: "medium", turns: 0 };
      saveSession(session);
      return reply({ sessionId: session.id, configOptions: options(session) });
    }
    case "session/resume": {
      const session = loadSession(params.sessionId);
      if (!session) return fail(-32002, "Session not found");
      return reply({ configOptions: options(session) });
    }
    case "session/set_config_option": {
      const session = loadSession(params.sessionId);
      if (params.configId === "model") session.model = params.value;
      else session.thinking = params.value;
      saveSession(session);
      return reply({ configOptions: options(session) });
    }
    case "session/prompt": {
      const session = loadSession(params.sessionId);
      session.turns += 1;
      saveSession(session);
      const text = params.prompt.map((block) => block.text ?? "").join("");
      const sid = params.sessionId;
      update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking." } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Turn ${session.turns} on ${session.model}/${session.thinking}.` } });
      if (text.includes("SLOW")) {
        update(sid, { sessionUpdate: "tool_call", toolCallId: "slow_1", title: "Run sleep", kind: "execute", status: "in_progress", rawInput: { CommandLine: "sleep 600" } });
        return;
      }
      for (const [marker, call] of [
        ["RUN_TOOL", { toolCallId: "call_run", title: "Run pnpm test", kind: "execute", rawInput: { CommandLine: "pnpm test" } }],
        ["EDIT", { toolCallId: "call_edit", title: "Edit a.rs", kind: "edit", locations: [{ path: "a.rs" }] }],
        ["MCP", { toolCallId: "call_mcp", title: "Run mcp_suplex_root_observe", kind: "other", rawInput: { ServerName: "suplex_root", ToolName: "observe", Arguments: { taskId: "task_1" } } }],
      ]) {
        if (!text.includes(marker)) continue;
        update(sid, { sessionUpdate: "tool_call", status: "pending", ...call });
        const answer = await request("session/request_permission", { sessionId: sid, toolCall: call, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
        const allowed = answer.outcome?.optionId === "allow" || answer.outcome?.optionId === "always";
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "2 passed" : "denied" } }], ...(call.rawInput?.ServerName && allowed ? { rawOutput: { content: [{ type: "text", text: "observed" }] } } : {}) });
      }
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Done." } });
      return reply({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, thoughtTokens: 5, totalTokens: 125 } });
    }
    default:
      if (id === undefined) return;
      return fail(-32601, `Unknown ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? {});
    pending.delete(message.id);
    return;
  }
  void handle(message);
});
lines.on("close", () => process.exit(0));

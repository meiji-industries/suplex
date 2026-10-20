#!/usr/bin/env node
// Deterministic Claude Code process stand-in for the isolated Standard browser journey.
// It prints Claude Code's stream-json turn output, appends the session transcript under
// CLAUDE_CONFIG_DIR, and exercises the real Root MCP and Worker Git path without a model.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sessionId = option("--session-id") ?? option("--resume");
const model = option("--model") ?? "haiku";
const configDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const transcript = join(configDirectory, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let parentUuid = null;

const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);
async function record(type, content) {
  const uuid = randomUUID();
  const entry = { type, uuid, parentUuid, timestamp: new Date().toISOString(), sessionId, message: type === "assistant" ? { id: `msg_${uuid}`, role: type, model, content, usage } : { role: type, content } };
  parentUuid = uuid;
  await appendFile(transcript, `${JSON.stringify(entry)}\n`);
  if (type !== "user" || typeof content !== "string") print({ ...entry, session_id: sessionId });
}

async function inputPrompt() {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  return prompt;
}

async function command(executable, commandArgs, options = {}) {
  const child = spawn(executable, commandArgs, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", chunk => output.push(chunk));
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) throw new Error(`${executable} ${commandArgs[0] ?? ""} exited ${code}`);
  return Buffer.concat(output).toString();
}

async function tool(name, input, run) {
  const id = `toolu_${randomUUID().replaceAll("-", "")}`;
  await record("assistant", [{ type: "tool_use", id, name, input }]);
  const output = await run();
  await record("user", [{ type: "tool_result", tool_use_id: id, content: typeof output === "string" ? output : JSON.stringify(output) }]);
  return output;
}

async function rootTool(server, kind, fields = {}) {
  return tool(`mcp__suplex_root__suplex_root`, { kind, ...fields }, async () => {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "deterministic-claude-fixture", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "suplex_root", arguments: { kind, ...fields } } },
    ];
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.resume();
    child.stdin.end(`${requests.map(request => JSON.stringify(request)).join("\n")}\n`);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (code !== 0) throw new Error(`Root MCP ${kind} exited ${code}`);
    const call = Buffer.concat(output).toString().split("\n").filter(Boolean).map(row => JSON.parse(row)).find(response => response.id === 2);
    if (!call || call.result?.isError !== false || !call.result.structuredContent) throw new Error(`Root MCP ${kind} failed`);
    return call.result.structuredContent;
  });
}

async function root(server) {
  const observed = await rootTool(server, "observe");
  if (!observed.workerResult) {
    await rootTool(server, "delegate_worker", {
      plan: "Append the requested README line, run the project test, and commit it locally.",
      acceptanceCriteria: ["README contains the requested line", "Project test passes", "Change is committed"],
      instruction: "Append `Verified by Suplex Standard task.` to README.md, run pnpm test, and commit the change. Do not deliver; the Root will review and request delivery.",
    });
    return "Assigned the local change and test to the Worker.";
  }
  const evidence = await rootTool(server, "read_worker_evidence", { turnId: observed.workerResult.turnId });
  if (!JSON.stringify(evidence).includes("pnpm test")) throw new Error("Worker test evidence is missing");
  const head = (await command("git", ["rev-parse", "HEAD"])).trim();
  await rootTool(server, "request_delivery", { operation: "complete_local_work", expectedHead: head });
  return "Reviewed Worker evidence and completed local delivery.";
}

async function worker() {
  const addition = "Verified by Suplex Standard task.";
  const readme = await tool("Read", { file_path: join(process.cwd(), "README.md") }, () => readFile("README.md", "utf8"));
  if (!readme.includes(addition)) await tool("Edit", { file_path: join(process.cwd(), "README.md") }, async () => { await writeFile("README.md", `${readme.replace(/\n?$/, "\n")}${addition}\n`); return "Updated README.md"; });
  await tool("Bash", { command: "pnpm test" }, () => command("pnpm", ["test"]));
  await tool("Bash", { command: "git add README.md && git commit -m 'Append verified README line'" }, async () => {
    await command("git", ["add", "README.md"]);
    return command("git", ["commit", "-m", "Append verified README line"], { env: { ...process.env, GIT_AUTHOR_NAME: "Suplex fixture", GIT_AUTHOR_EMAIL: "suplex-fixture@example.invalid", GIT_COMMITTER_NAME: "Suplex fixture", GIT_COMMITTER_EMAIL: "suplex-fixture@example.invalid" } });
  });
  return "README line committed after pnpm test passed.";
}

// The host probes the sign-in with `claude auth status --json`, as Settings does. Claude Code answers it without a session.
if (args[0] === "auth" && args[1] === "status") {
  print({ loggedIn: true, authMethod: "claude.ai", email: "suplex-fixture@example.invalid" });
  process.exit(0);
}

try {
  if (!sessionId) throw new Error("A session identity is necessary");
  await mkdir(join(transcript, ".."), { recursive: true });
  print({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model, tools: [] });
  await record("user", await inputPrompt());
  const mcpConfig = option("--mcp-config") ?? '{"mcpServers":{}}';
  const servers = JSON.parse(mcpConfig.trim().startsWith("{") ? mcpConfig : await readFile(mcpConfig, "utf8")).mcpServers;
  const text = servers.suplex_root ? await root(servers.suplex_root) : await worker();
  await record("assistant", [{ type: "text", text }]);
  print({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, uuid: randomUUID() });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  print({ type: "result", subtype: "error_during_execution", is_error: true, result: message, session_id: sessionId ?? "unknown" });
  process.exitCode = 1;
}

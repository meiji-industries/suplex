import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run-command.js";

type Server = { command: string; args: string[]; environment: Record<string, string> };

export async function runMcpProcess(server: Server, environment: NodeJS.ProcessEnv, requests: unknown[]): Promise<{ responses: unknown[]; stderr: string; exitCode: number | null }> {
  const directory = await mkdtemp(join(tmpdir(), "suplex-mcp-process-"));
  const inputPath = join(directory, "requests.jsonl");
  await writeFile(inputPath, `${requests.map(request => JSON.stringify(request)).join("\n")}\n`, { mode: 0o600 });
  try {
    const result = await runCommand({ taskId: null, stepId: null, command: "/bin/sh", args: ["-c", "input=$1; shift; exec \"$@\" < \"$input\"", "suplex-mcp-process", inputPath, server.command, ...server.args], env: environment, expectNonZero: true });
    const responses = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { responses, stderr: result.stderr, exitCode: result.exitCode };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const initializeAndList = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
];

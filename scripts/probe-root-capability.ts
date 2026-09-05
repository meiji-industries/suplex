import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { herdrRuntime } from "../src/agent-providers/herdr-runtime.js";
import type { RootBridgeConfig } from "../src/root-contracts.js";

async function command(file: string, args: string[], cwd?: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-1024 * 1024);
      process.stderr.write(`[${file} ${stream}] ${text}`);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

async function main(): Promise<void> {
  const denialsOnly = process.argv.includes("--denials-only");
  const root = await mkdtemp(join(tmpdir(), "forge-root-capability-"));
  let receivedFixtureRequests = 0;
  const fixture = createServer((_request, response) => {
    receivedFixtureRequests += 1;
    response.writeHead(404).end("fixture rejects every request");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("Local Git fixture did not allocate a port");
    const login = await command("codex", ["login", "status"]);
    if (login.exitCode !== 0) throw new Error("Codex login is unavailable");
    await command("git", ["init", "-q"], root);
    await command("git", ["config", "user.email", "root-probe@example.invalid"], root);
    await command("git", ["config", "user.name", "Root probe"], root);
    await writeFile(join(root, "README.md"), "root capability fixture\n");
    await command("git", ["add", "README.md"], root);
    await command("git", ["commit", "-qm", "fixture"], root);
    await command("git", ["remote", "add", "origin", `http://127.0.0.1:${address.port}/forge-capability-fixtures/does-not-exist.git`], root);
    await command("git", ["ls-remote", "origin"], root);
    if (receivedFixtureRequests === 0) throw new Error("Unsandboxed Git did not reach the local fixture");
    receivedFixtureRequests = 0;
    const binding = join(root, "root.binding.json");
    const mcpCalls = join(root, "mcp-calls.json");
    const bridgeServer = join(process.cwd(), "scripts", "root-bridge-probe-server.ts");
    const config: RootBridgeConfig = {
      version: 1,
      root: { taskId: "probe_task", sessionId: "probe_session", generation: 1 },
      server: { command: join(process.cwd(), "node_modules", ".bin", "tsx"), args: [bridgeServer, binding, mcpCalls] },
    };
    await writeFile(binding, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const runtimeArgs = herdrRuntime("codex").launchArgs(
      { model: "gpt-5.6-terra", reasoningLevel: "medium", serviceTier: "default" },
      null,
      false,
      undefined,
      { kind: "root", bridgeConfig: config, bridgeConfigPath: join(root, "root.mcp.json") },
    );
    const execArgs = runtimeArgs.filter((value, index, values) =>
      value !== "--ask-for-approval" && value !== "never" && values[index - 1] !== "--ask-for-approval",
    );
    execArgs.push("-c", 'approval_policy="never"', "--json");
    if (!denialsOnly) {
      const mcpProbe = await command("codex", [
        "exec", "-C", root, ...execArgs,
        "Use the forge_root MCP tool twice. First call it with {\"kind\":\"observe\"}. Then call it with {\"kind\":\"delegate_worker\",\"instruction\":\"Inspect the current diff.\"}. Report both structured results.",
      ]);
      if (mcpProbe.exitCode !== 0) throw new Error(`Codex MCP probe failed: ${mcpProbe.output}`);
      const calls = await readFile(mcpCalls, "utf8");
      if (!calls.includes('"kind":"observe"') || !calls.includes('"kind":"delegate_worker"'))
        throw new Error("Codex did not discover and call both scoped Forge MCP operations");
      if (!mcpProbe.output.includes("forge_root")) throw new Error("Codex did not emit a structured forge_root tool event");
    }
    const denied = async (shellCommand: string): Promise<string> => {
      const result = await command("codex", [
        "sandbox", "-c", 'sandbox_mode="read-only"', "--log-denials", "--",
        "/bin/zsh", "-lc", `cd ${JSON.stringify(root)} && ${shellCommand}`,
      ]);
      if (result.exitCode === 0) throw new Error(`Codex read-only sandbox unexpectedly succeeded running ${shellCommand}`);
      return result.output;
    };
    const write = await denied("touch direct-write");
    const commit = await denied("git commit --allow-empty -m denied");
    const push = await denied("git push origin HEAD:denied-root-probe");
    const github = await denied("GH_HOST=localhost GH_ENTERPRISE_TOKEN=probe gh pr create --repo localhost/forge-capability-fixtures/does-not-exist --title denied --body denied");
    const herdr = await denied("herdr agent start root-probe-denied --kind codex --pane no-such-pane -- --dangerously-bypass-approvals-and-sandbox");
    await stat(join(root, "direct-write")).then(
      () => { throw new Error("Codex Root created a repository file"); },
      (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
    );
    const commits = await command("git", ["rev-list", "--all", "--count"], root);
    if (commits.exitCode !== 0 || commits.output.trim() !== "1") throw new Error("Codex Root created a Git commit");
    if (!write.includes("Operation not permitted") || !commit.includes("Operation not permitted"))
      throw new Error("Codex read-only sandbox did not emit filesystem denials");
    if (!push.includes("Operation not permitted") || receivedFixtureRequests !== 0)
      throw new Error("Codex read-only sandbox did not deny direct git push before the local fixture received a request");
    if (!/Operation not permitted|error connecting/.test(github))
      throw new Error("Codex Root did not emit a network or OS denial for the local fake GitHub endpoint");
    if (!/Operation not permitted|PermissionDenied|Permission denied/.test(herdr))
      throw new Error("Codex Root did not emit an OS denial for raw Herdr launch");
    process.stdout.write(denialsOnly
      ? "Root capability denial probe passed. Repository write, Git commit and push, local-fake GitHub PR creation, and raw Herdr launch were denied.\n"
      : "Root capability probe passed. Native MCP discovery and scoped observe/delegate calls succeeded. Repository write, Git commit and push, local-fake GitHub PR creation, and raw Herdr launch were denied.\n");
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

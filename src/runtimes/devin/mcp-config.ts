import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { runCommand } from "../../platform/command-runner.js";
import { environmentBridgeServer, resolvedGhCommand } from "../task-harness.js";

const DevinMcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const LOCAL_CONFIG_PATH = ".devin/mcp_config.local.json";
// The trailing * also hides the pending file written beside the config.
const EXCLUDE_PATTERN = `/${LOCAL_CONFIG_PATH}*`;
// ponytail: process-global lock on info/exclude appends; per-repository locks if this ever contends.
let excludeQueue: Promise<void> = Promise.resolve();

async function readConfig(path: string): Promise<z.infer<typeof DevinMcpConfigSchema>> {
  try {
    return DevinMcpConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    return {};
  }
}

async function gitCommonDirectory(directory: string): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["rev-parse", "--git-common-dir"], cwd: directory, expectNonZero: true });
  if (result.exitCode !== 0) throw new Error("Devin MCP configuration requires a Git worktree");
  const value = result.stdout.trim();
  if (!value) throw new Error("Git did not report its common directory");
  return isAbsolute(value) ? value : resolve(directory, value);
}

async function ensureExcluded(directory: string): Promise<void> {
  const excludePath = join(await gitCommonDirectory(directory), "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  const appendExclusion = async (): Promise<void> => {
    let current = "";
    try { current = await readFile(excludePath, "utf8"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (current.split(/\r?\n/).includes(EXCLUDE_PATTERN)) return;
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await appendFile(excludePath, `${separator}${EXCLUDE_PATTERN}\n`);
  };
  const update = excludeQueue.then(appendExclusion, appendExclusion);
  excludeQueue = update.then(() => undefined, () => undefined);
  await update;
}

export async function ensureDevinMcpConfig(directory: string): Promise<string> {
  await ensureExcluded(directory);
  const path = join(directory, LOCAL_CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const current = await readConfig(path);
  const ghCommand = await resolvedGhCommand();
  const root = environmentBridgeServer("root", ghCommand);
  const advisor = environmentBridgeServer("advisor", ghCommand);
  const next = {
    ...current,
    mcpServers: {
      ...current.mcpServers,
      suplex_root: { command: root.command, args: root.args, env: root.environment },
      suplex_advisor: { command: advisor.command, args: advisor.args, env: advisor.environment },
    },
  };
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  let existing: string | null = null;
  try { existing = await readFile(path, "utf8"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  if (existing !== serialized) {
    const pending = `${path}.${randomUUID()}.pending`;
    await writeFile(pending, serialized, { mode: 0o600 });
    await rename(pending, path);
  }
  return path;
}

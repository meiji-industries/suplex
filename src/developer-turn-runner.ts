import { CancelledFailure, Context } from "@temporalio/activity";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ForgeConfig } from "./config.js";
import type { ProcessController } from "./process-manager.js";
import { requestDeveloperSupervisor, spawnDeveloperSupervisor } from "./developer-supervisor.js";
import { DeveloperSupervisorInvocationSchema, DeveloperSupervisorSnapshotSchema, validateSupervisorResult, type DeveloperSupervisorInvocation } from "./developer-supervisor-protocol.js";
import { jsonRequired } from "./task-utils.js";

export type DeveloperTurnKind = "implementation" | "repair" | "merge_conflict_resolution";

export interface DeveloperTurnRunInput {
  database: import("./database.js").ForgeDatabase;
  config: ForgeConfig;
  executionId: string;
  developerAttempt: number;
  planRevision: number;
  turnKind: DeveloperTurnKind;
  companyId: string;
  taskId: string;
  workflowId: string;
  canonicalWorktreePath: string;
  worktreeIdentityHash: string;
  command: string;
  args: string[];
  stdin?: string;
  cwd: string;
  env: Record<string, string>;
  controller?: ProcessController;
  spawnSupervisor?: typeof spawnDeveloperSupervisor;
  onMilestone?: (status: "active" | "reconnecting" | "result_pending_claim" | "cancellation_requested" | "cancelling") => Promise<void>;
  onStart?: (pid: number, startedAt: string) => Promise<void>;
  onLine?: (line: string) => Promise<void>;
}

export interface DeveloperTurnRunResult {
  executionId: string;
  resultHash: string;
  exitCode: number | null;
  exitSignal: string | null;
  lines: string[];
  outputTruncated: boolean;
  terminal: "result" | "interrupted";
  lastHeartbeatAt: string | null;
}

export function deriveDeveloperExecutionId(workflowId: string, planRevision: number, developerAttempt: number, turnKind: DeveloperTurnKind): string {
  return `developer_${createHash("sha256").update(`${workflowId}\0${planRevision}\0${developerAttempt}\0${turnKind}`).digest("hex").slice(0, 24)}`;
}

async function lines(root: string): Promise<string[]> {
  const events = await readFile(join(root, "events.jsonl"), "utf8").catch(() => "");
  return events.split(/\r?\n/).flatMap((line) => {
    try { const event = jsonRequired(line) as { stream?: string; line?: string }; return event.stream === "stdout" && typeof event.line === "string" ? [event.line] : []; } catch { return []; }
  });
}

async function sleep(milliseconds: number): Promise<void> {
  try { await Context.current().sleep(milliseconds); } catch (error) { if (error instanceof CancelledFailure) throw error; await new Promise((resolve) => setTimeout(resolve, milliseconds)); }
}

export async function runDeveloperTurn(input: DeveloperTurnRunInput): Promise<DeveloperTurnRunResult> {
  const root = join(input.config.runtimeRoot, "developer-executions", input.executionId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const invocation: DeveloperSupervisorInvocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId: input.executionId, command: input.command, args: input.args, cwd: input.cwd, env: Object.fromEntries(Object.entries(input.env).filter(([key]) => key === "PATH" || key === "FORGE_GIT_REAL_BIN" || key === "FORGE_GIT_GUARD_DIR" || key === "MISE_TRUSTED_CONFIG_PATHS" || ["CARGO_TARGET_DIR", "PNPM_STORE_PATH", "npm_config_cache", "GOCACHE", "PIP_CACHE_DIR", "UV_CACHE_DIR", "CCACHE_DIR"].includes(key))) });
  await writeFile(join(root, "invocation.json"), `${JSON.stringify(invocation)}\n`, { flag: "a", mode: 0o600 });
  const prompt = input.stdin ?? input.args.at(-1);
  if (!prompt || prompt === "-") throw new Error("Builder prompt is missing");
  await writeFile(join(root, "prompt.txt"), prompt, { flag: "a", mode: 0o600 });
  await writeFile(join(root, "events.jsonl"), "", { flag: "a", mode: 0o600 });
  const snapshot = await readFile(join(root, "supervisor.json"), "utf8").then((value) => DeveloperSupervisorSnapshotSchema.parse(jsonRequired(value))).catch(() => undefined);
  if (!snapshot) (input.spawnSupervisor ?? spawnDeveloperSupervisor)(root);
  await input.onMilestone?.(snapshot ? "reconnecting" : "active");
  let startedPid: number | undefined;
  for (;;) {
    const result = await readFile(join(root, "result.json"), "utf8").then((value) => validateSupervisorResult(jsonRequired(value))).catch(() => undefined);
    if (result) {
      const output = await lines(root);
      await input.onMilestone?.("result_pending_claim");
      return { executionId: input.executionId, resultHash: result.resultHash, exitCode: result.exitCode, exitSignal: result.exitSignal, lines: output, outputTruncated: result.outputTruncated, terminal: "result", lastHeartbeatAt: result.finishedAt };
    }
    const current = await readFile(join(root, "supervisor.json"), "utf8").then((value) => DeveloperSupervisorSnapshotSchema.parse(jsonRequired(value))).catch(() => undefined);
    const child = current?.child;
    if (child && child.pid !== startedPid) {
      startedPid = child.pid;
      input.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET process_pid = ?, heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(child.pid, current.heartbeatAt, input.executionId));
      await input.onStart?.(child.pid, child.startTime);
    }
    const status = await requestDeveloperSupervisor(root, { version: 1, command: "status", executionId: input.executionId }).catch(() => null);
    if (status?.status === "failed") return { executionId: input.executionId, resultHash: "", exitCode: null, exitSignal: null, lines: await lines(root), outputTruncated: false, terminal: "interrupted", lastHeartbeatAt: current?.heartbeatAt ?? null };
    await sleep(500);
  }
}

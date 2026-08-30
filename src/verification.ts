import { dirname } from "node:path";

import { StructuredLogger, redact } from "./logging.js";
import { runCommand } from "./command-runner.js";
import { createGitCommandGuard, type GitCommandGuard, withWorktreeMiseTrust } from "./worktrees.js";

const logger = new StructuredLogger();
const runtimeNodeBinEnvironmentVariable = "FORGE_PINNED_VERIFICATION_RUNTIME_NODE_BIN";
const runtimeNodePathPrelude = `export PATH="$${runtimeNodeBinEnvironmentVariable}:$PATH"; `;
const tail = (value: string): string => value.length > 64 * 1024 ? value.slice(-64 * 1024) : value;
const truncateBytes = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  const marker = "…";
  if (bytes.length <= maxBytes) return value;
  const budget = maxBytes - Buffer.byteLength(marker, "utf8");
  let suffix = "";
  let used = 0;
  for (const character of [...value].reverse()) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > budget) break;
    suffix = character + suffix;
    used += size;
  }
  return `${marker}${suffix}`;
};
const boundedEvidence = (commands: VerificationCommandEvidence[]): VerificationCommandEvidence[] => commands.map((command) => ({ ...command, stdout: truncateBytes(command.stdout, 8 * 1024), stderr: truncateBytes(command.stderr, 8 * 1024) }));
const failureSummary = (display: string, stdout: string, stderr: string): string => {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const detail = [...lines].reverse().find((line) => /^(?:error(?::|\[)|fatal:|failures:|test result: FAILED|thread .+ panicked|command timed out)/i.test(line));
  const outputTail = truncateBytes(lines.slice(-40).join("\n"), 3 * 1024);
  return `${display} did not complete successfully${detail ? `: ${detail.slice(0, 240)}` : ""}. Check the project's verification command.${outputTail ? `\nOutput tail:\n${outputTail}` : ""}`;
};

export function commandArgv(command: string): readonly string[] | undefined {
  const trimmed = command.trim();
  // Commands are operator-owned project configuration, not an allowlist.  Keep
  // the single-line/no-secret validation in projects.ts and execute through sh
  // so normal shell quoting and arguments remain available.
  return trimmed && !/[\r\n]/.test(trimmed) ? ["sh", "-lc", trimmed] : undefined;
}

const runtimePinnedCommandArgv = (command: string): readonly string[] | undefined => {
  const argv = commandArgv(command);
  return argv ? [argv[0]!, argv[1]!, `${runtimeNodePathPrelude}${argv[2]!}`] : undefined;
};

export type VerificationBlockerCode = "verification_failed" | "verification_timed_out" | "verification_evidence_too_large";

export interface VerificationCommandEvidence {
  command: string;
  argv: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface VerificationResult {
  outcome: "passed" | "failed";
  code?: VerificationBlockerCode;
  summary: string;
  commands: VerificationCommandEvidence[];
}

interface ExecuteOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  shell: false;
}

type Execute = (command: string, args: string[], options: ExecuteOptions) => Promise<{ stdout: string; stderr: string }>;

export interface PinnedVerificationInput {
  /** Present for task execution: makes the individual shell-outs visible in Activity. */
  taskId?: string;
  stepId?: string;
  worktreePath: string;
  setupCommand: string;
  verificationCommand: string;
  runtimeRoot?: string;
}

export interface VerificationDependencies {
  execute?: (command: string, args: string[], options: ExecuteOptions) => Promise<{ stdout: string; stderr: string }>;
  guard?: GitCommandGuard;
  now?: () => string;
}

const defaultExecute: Execute = async (command, args, options) => {
  // Standalone callers (for example project validation) intentionally remain
  // usable without a task. Task execution always supplies these coordinates.
  const result = await runCommand({ taskId: null, stepId: null, command, args, cwd: options.cwd, env: options.env, timeout: options.timeout });
  if (result.exitCode === 0 && !result.timedOut) return result;
  throw Object.assign(new Error(`${command} exited with status ${result.exitCode ?? "unknown"}`), { code: result.exitCode, killed: result.timedOut, stdout: result.stdout, stderr: result.stderr });
};

export async function runPinnedVerification(input: PinnedVerificationInput, dependencies: VerificationDependencies = {}): Promise<VerificationResult> {
  const setupArgv = runtimePinnedCommandArgv(input.setupCommand);
  const verificationArgv = runtimePinnedCommandArgv(input.verificationCommand);
  const rebuildArgv = runtimePinnedCommandArgv("pnpm rebuild")!;
  if (!setupArgv || !verificationArgv) return { outcome: "failed", code: "verification_failed", summary: "Project verification commands must be non-empty single lines", commands: [] };
  const execute = dependencies.execute ?? (input.taskId && input.stepId
    ? async (command: string, args: string[], options: ExecuteOptions) => {
      const result = await runCommand({ taskId: input.taskId!, stepId: input.stepId!, command, args, cwd: options.cwd, env: options.env, timeout: options.timeout });
      if (result.exitCode === 0 && !result.timedOut) return result;
      throw Object.assign(new Error(`${command} exited with status ${result.exitCode ?? "unknown"}`), { code: result.exitCode, killed: result.timedOut, stdout: result.stdout, stderr: result.stderr });
    }
    : defaultExecute);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const ownedGuard = dependencies.guard ? undefined : await createGitCommandGuard(input.runtimeRoot ?? input.worktreePath);
  const guard = dependencies.guard ?? ownedGuard!;
  const evidence: VerificationCommandEvidence[] = [];
  try {
    const runStage = async (display: string, argv: readonly string[], timeout: number): Promise<VerificationCommandEvidence> => {
      const startedAt = now();
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = 0;
      let signal: string | null = null;
      let timedOut = false;
      try {
        const result = await execute(argv[0]!, [...argv.slice(1)], {
          cwd: input.worktreePath,
          env: {
            ...withWorktreeMiseTrust(guard.env, input.worktreePath),
            [runtimeNodeBinEnvironmentVariable]: dirname(process.execPath),
          },
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          shell: false,
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
        stdout = typeof failure.stdout === "string" ? failure.stdout : "";
        stderr = typeof failure.stderr === "string" ? failure.stderr : "";
        exitCode = typeof failure.code === "number" ? failure.code : 1;
        signal = typeof failure.signal === "string" ? failure.signal : null;
        timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
      }
      return { command: display, argv: [...argv], startedAt, finishedAt: now(), exitCode, signal, timedOut, stdout: truncateBytes(String(redact(tail(stdout))), 8 * 1024), stderr: truncateBytes(String(redact(tail(stderr))), 8 * 1024) };
    };
    const failed = (command: VerificationCommandEvidence): boolean => command.timedOut || command.exitCode !== 0;
    const result = (command: VerificationCommandEvidence): VerificationResult => ({
      outcome: "failed",
      code: command.timedOut ? "verification_timed_out" : "verification_failed",
      summary: failureSummary(command.command, command.stdout, command.stderr),
      commands: evidence,
    });
    const record = (command: VerificationCommandEvidence): VerificationResult | undefined => {
      evidence.push(command);
      if (Buffer.byteLength(JSON.stringify({ commands: evidence }), "utf8") > 256 * 1024) return { outcome: "failed", code: "verification_evidence_too_large", summary: "Verification evidence exceeded the safe artifact limit", commands: boundedEvidence(evidence) };
      return undefined;
    };
    const setup = await runStage(input.setupCommand, setupArgv, 10 * 60_000);
    const setupLimit = record(setup);
    if (setupLimit) return setupLimit;
    if (failed(setup)) return result(setup);

    const verification = await runStage(input.verificationCommand, verificationArgv, 20 * 60_000);
    const verificationLimit = record(verification);
    if (verificationLimit) return verificationLimit;
    if (!failed(verification)) return { outcome: "passed", summary: "Project setup and verification passed", commands: evidence };
    if (!/NODE_MODULE_VERSION|was compiled against a different Node\.js version|ERR_DLOPEN_FAILED/.test(`${verification.stdout}\n${verification.stderr}`)) return result(verification);

    logger.info("Native module ABI mismatch detected; rebuilding dependencies before retrying verification", input.taskId ? { taskId: input.taskId } : {});
    const rebuild = await runStage("pnpm rebuild", rebuildArgv, 20 * 60_000);
    const rebuildLimit = record(rebuild);
    if (rebuildLimit) return rebuildLimit;
    if (failed(rebuild)) return result(rebuild);

    const retry = await runStage(input.verificationCommand, verificationArgv, 20 * 60_000);
    const retryLimit = record(retry);
    if (retryLimit) return retryLimit;
    if (failed(retry)) return result(retry);
    return { outcome: "passed", summary: "Project setup and verification passed", commands: evidence };
  } finally {
    await ownedGuard?.cleanup();
  }
}

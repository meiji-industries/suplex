import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { redact } from "./logging.js";
import { createGitCommandGuard, type GitCommandGuard, withWorktreeMiseTrust } from "./worktrees.js";

const execFileAsync = promisify(execFile);
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

const commands = new Map<string, readonly string[]>([
  ["pnpm install", ["pnpm", "install"]],
  ["pnpm install --frozen-lockfile", ["pnpm", "install", "--frozen-lockfile"]],
  ["npm install", ["npm", "install"]],
  ["npm ci", ["npm", "ci"]],
  ["yarn install", ["yarn", "install"]],
  ["yarn install --immutable", ["yarn", "install", "--immutable"]],
  ["bun install", ["bun", "install"]],
  ["mise run setup", ["mise", "run", "setup"]],
  ["cargo fetch --locked", ["cargo", "fetch", "--locked"]],
  ["pnpm test", ["pnpm", "test"]],
  ["pnpm typecheck", ["pnpm", "typecheck"]],
  ["pnpm lint", ["pnpm", "lint"]],
  ["npm test", ["npm", "test"]],
  ["npm run typecheck", ["npm", "run", "typecheck"]],
  ["npm run lint", ["npm", "run", "lint"]],
  ["yarn test", ["yarn", "test"]],
  ["yarn typecheck", ["yarn", "typecheck"]],
  ["yarn lint", ["yarn", "lint"]],
  ["bun test", ["bun", "test"]],
  ["mise run test", ["mise", "run", "test"]],
  ["mise run typecheck", ["mise", "run", "typecheck"]],
  ["mise run lint", ["mise", "run", "lint"]],
  ["cargo test", ["cargo", "test"]],
  ["make test", ["make", "test"]],
  ["make setup", ["make", "setup"]],
  ["make test-local", ["make", "test-local"]],
  ["make check", ["make", "check"]],
] as const);

export function commandArgv(command: string): readonly string[] | undefined {
  return commands.get(command.trim());
}

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

const defaultExecute: Execute = async (command, args, options) => execFileAsync(command, args, options);

export async function runPinnedVerification(input: PinnedVerificationInput, dependencies: VerificationDependencies = {}): Promise<VerificationResult> {
  const setupArgv = commandArgv(input.setupCommand);
  const verificationArgv = commandArgv(input.verificationCommand);
  if (!setupArgv || !verificationArgv) return { outcome: "failed", code: "verification_failed", summary: "Pinned verification command is not an accepted literal", commands: [] };
  const execute = dependencies.execute ?? defaultExecute;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const ownedGuard = dependencies.guard ? undefined : await createGitCommandGuard(input.runtimeRoot ?? input.worktreePath);
  const guard = dependencies.guard ?? ownedGuard!;
  const evidence: VerificationCommandEvidence[] = [];
  try {
    const stages: Array<readonly [string, readonly string[], number]> = [
      ...(setupArgv[0] === "mise" || verificationArgv[0] === "mise" ? [["mise trust", ["mise", "trust"], 60_000] as const] : []),
      [input.setupCommand, setupArgv, 10 * 60_000],
      [input.verificationCommand, verificationArgv, 20 * 60_000],
    ];
    for (const [display, argv, timeout] of stages) {
      const startedAt = now();
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = 0;
      let signal: string | null = null;
      let timedOut = false;
      try {
        const result = await execute(argv[0]!, [...argv.slice(1)], { cwd: input.worktreePath, env: withWorktreeMiseTrust(guard.env, input.worktreePath), timeout, maxBuffer: 4 * 1024 * 1024, shell: false });
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
      const commandEvidence: VerificationCommandEvidence = {
        command: display,
        argv: [...argv],
        startedAt,
        finishedAt: now(),
        exitCode,
        signal,
        timedOut,
        stdout: truncateBytes(String(redact(tail(stdout))), 8 * 1024),
        stderr: truncateBytes(String(redact(tail(stderr))), 8 * 1024),
      };
      evidence.push(commandEvidence);
      const serialized = JSON.stringify({ commands: evidence });
      if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) return { outcome: "failed", code: "verification_evidence_too_large", summary: "Verification evidence exceeded the safe artifact limit", commands: boundedEvidence(evidence) };
      if (timedOut || exitCode !== 0) return { outcome: "failed", code: timedOut ? "verification_timed_out" : "verification_failed", summary: failureSummary(display, commandEvidence.stdout, commandEvidence.stderr), commands: evidence };
    }
    return { outcome: "passed", summary: "Pinned setup and verification passed", commands: evidence };
  } finally {
    await ownedGuard?.cleanup();
  }
}

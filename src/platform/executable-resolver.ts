import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface ExecutableSpec {
  /** Product name for messages, such as "OpenCode". */
  label: string;
  /** Binary name searched on PATH. */
  binary: string;
  /** Environment variable that pins an absolute executable path. */
  envVar: string;
  /** Standard install locations relative to the home directory. */
  homePaths: string[][];
}

export const OPENCODE_EXECUTABLE: ExecutableSpec = { label: "OpenCode", binary: "opencode", envVar: "FORGE_OPENCODE_COMMAND", homePaths: [[".opencode", "bin", "opencode"]] };
export const CLAUDE_EXECUTABLE: ExecutableSpec = { label: "Claude Code", binary: "claude", envVar: "FORGE_CLAUDE_COMMAND", homePaths: [[".local", "bin", "claude"], [".claude", "local", "claude"]] };

async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) return false;
    throw error;
  }
}

export interface ResolveExecutableInput {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export async function resolveExecutable(spec: ExecutableSpec, input: ResolveExecutableInput = {}): Promise<string> {
  const env = input.env ?? process.env;
  const configured = input.executable ?? env[spec.envVar];
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error(`${spec.label} executable must be an absolute path. Check ${spec.envVar}.`);
    if (!await executableFile(configured)) throw new Error(`${spec.label} executable cannot be executed. Check ${spec.envVar}.`);
    return configured;
  }
  const home = input.homeDirectory ?? homedir();
  const candidates = [
    ...(env.PATH ?? "").split(delimiter).filter(isAbsolute).map((directory) => join(directory, spec.binary)),
    ...spec.homePaths.map((segments) => join(home, ...segments)),
  ];
  for (const candidate of candidates) if (await executableFile(candidate)) return candidate;
  throw new Error(`Install ${spec.label} or set ${spec.envVar} to its absolute executable path.`);
}

export const resolveOpenCodeExecutable = (input: ResolveExecutableInput = {}): Promise<string> => resolveExecutable(OPENCODE_EXECUTABLE, input);
export const resolveClaudeExecutable = (input: ResolveExecutableInput = {}): Promise<string> => resolveExecutable(CLAUDE_EXECUTABLE, input);

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) return false;
    throw error;
  }
}

export async function resolveOpenCodeExecutable(input: {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): Promise<string> {
  const env = input.env ?? process.env;
  const configured = input.executable ?? env.FORGE_OPENCODE_COMMAND;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error("OpenCode executable must be an absolute path. Check FORGE_OPENCODE_COMMAND.");
    if (!await executableFile(configured)) throw new Error("OpenCode executable cannot be executed. Check FORGE_OPENCODE_COMMAND.");
    return configured;
  }
  const candidates = [
    ...(env.PATH ?? "").split(delimiter).filter(isAbsolute).map((directory) => join(directory, "opencode")),
    join(input.homeDirectory ?? homedir(), ".opencode", "bin", "opencode"),
  ];
  for (const candidate of candidates) if (await executableFile(candidate)) return candidate;
  throw new Error("Install OpenCode or set FORGE_OPENCODE_COMMAND to its absolute executable path.");
}

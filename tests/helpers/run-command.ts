import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function runCommand(input: { command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv; expectNonZero?: boolean; taskId?: null; stepId?: null }) {
  try {
    const result = await execute(input.command, [...input.args], { cwd: input.cwd, env: input.env, maxBuffer: 16 * 1024 * 1024 });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (!input.expectNonZero) throw error;
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: typeof result.code === "number" ? result.code : null };
  }
}


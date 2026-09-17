import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../platform/command-runner.js";
import type { ProjectExecution } from "../projects/execution-configuration.js";
import { taskEvidenceRoot } from "../coordination/workflow-evidence.js";
import { excludeEnvironmentKeys } from "../runtimes/project-environment.js";

export function taskPreparationDirectory(databasePath: string, taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw new Error("Invalid task preparation identity");
  return join(dirname(databasePath), "runtime", "task-preparation", taskId);
}

export function sharedResourceCommand(): string {
  const candidates = [new URL("../../scripts/shared-resource-command.py", import.meta.url), new URL("../../../scripts/shared-resource-command.py", import.meta.url)].map(url => fileURLToPath(url));
  const path = candidates.find(existsSync);
  if (!path) throw new Error("The shared resource command is missing from this Forge installation");
  return path;
}

export function setupEnvironment(configured: Record<string, string>, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTH)/i.test(key) && !/^(?:CLAUDE|ANTHROPIC|AWS|GOOGLE|AZURE|FORGE)_/.test(key))), ...configured };
}

export async function prepareProjectWorkspace(input: { databasePath: string; taskId: string; directory: string; execution: ProjectExecution; setupCommand: string; excludedEnvironmentKeys?: string[]; command?: typeof runCommand }): Promise<void> {
  const directory = taskPreparationDirectory(input.databasePath, input.taskId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const context = ["Project instructions", input.execution.instructions];
  const generated = join(taskEvidenceRoot(input.databasePath), input.taskId, "generated");
  await mkdir(generated, { recursive: true, mode: 0o700 });
  context.push(`Worker: capture real Before command output before edits, then After output against the reviewed commit. Preserve passing evidence; do not invent output or repeat checks just to make a receipt. Write ${join(generated, "delivery-evidence.json")} with {"headSha":"40-character reviewed Git SHA","summary":"What changed","before":[{"command":"exact command","output":"full output"}],"after":[{"command":"exact command","output":"full output"}],"howToVerify":["steps"],"screenshots":[{"filename":"basename.png","phase":"before or after"}]}. Screenshots are optional unless this task requires them. Put any screenshots beside the manifest. Keep these artifacts outside delivered commits. Coordinator: read the manifest and source, assess the actual evidence independently, and request repairs for gaps. Forge owns remote publication.`);
  for (const source of input.execution.skillDirectories) {
    try {
      const canonical = await realpath(source);
      if (!(await lstat(canonical)).isDirectory()) throw new Error("Skill source must be a directory");
      const destination = join(directory, "skills", `${basename(canonical)}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`);
      await cp(canonical, destination, { recursive: true, force: true, filter: async path => {
        if ((await lstat(path)).isSymbolicLink()) throw new Error("Skill directories cannot contain symbolic links");
        return true;
      } });
      context.push(`Read the SKILL.md files and their referenced resources under ${destination} before using these skills. These files are local task context, not delivered source.`);
    } catch (error) {
      context.push(`Skill preparation needs repair for ${source}: ${error instanceof Error ? error.message : "copy failed"}. Resolve the source path or ask for the specific missing access.`);
    }
  }
  if (input.setupCommand.trim()) {
    const log = join(directory, "setup.log");
    try {
      const result = await (input.command ?? runCommand)({ taskId: input.taskId, stepId: null, command: "python3", args: [sharedResourceCommand(), "--resource", await realpath(input.directory), "--", "/bin/sh", "-c", '"$0" -c "$1" > "$2" 2>&1', "/bin/sh", input.setupCommand, log], cwd: input.directory, env: excludeEnvironmentKeys(setupEnvironment(input.execution.environment), input.excludedEnvironmentKeys), timeout: 30 * 60_000, expectNonZero: true });
      context.push(`Configured setup exited ${result.exitCode ?? result.signal ?? "without a status"}. Full output: ${log}.`);
      if (result.exitCode !== 0) {
        const output = await readFile(log, "utf8").catch(() => result.stderr);
        context.push(`Preparation failed. Delegate a bounded repair and rerun the idempotent setup before implementation. Output tail (up to 8000 characters):\n${output.slice(-8_000)}`);
      }
    } catch (error) {
      context.push(`Preparation could not finish: ${error instanceof Error ? error.message : "command failed"}. Inspect ${log}, repair the cause, and rerun the idempotent setup before implementation.`);
    }
  }
  await writeFile(join(directory, "context.md"), context.join("\n\n"), { mode: 0o600 });
}

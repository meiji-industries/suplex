import { isAbsolute, relative, resolve, sep } from "node:path";
import { runCommand } from "../../platform/command-runner.js";
import { stopDiscoveredProcesses, taskOwnedProcessIds } from "../../platform/process-manager.js";

async function observe(command: string, args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command, args });
  if (result.exitCode !== 0) throw new Error(`Could not inspect task processes with ${command}: ${result.stderr}`);
  return result.stdout;
}

async function worktreeProcesses(path: string): Promise<Set<number>> {
  const stdout = await observe("lsof", ["-a", "-u", String(process.getuid!()), "-d", "cwd", "-Fpn"]);
  const result = new Set<number>(await taskOwnedProcessIds(path));
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n") || !pid || pid === process.pid) continue;
    const child = relative(resolve(path), line.slice(1));
    if (child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))) result.add(pid);
  }
  const tree = await observe("ps", ["-axo", "pid=,ppid="]);
  const parents = tree.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  let previousSize = -1;
  while (previousSize !== result.size) {
    previousSize = result.size;
    for (const [child, parent] of parents) {
      if (child && child !== process.pid && parent && result.has(parent)) result.add(child);
    }
  }
  return result;
}

export async function stopWorktreeProcesses(path: string, reason = "worktree cleanup"): Promise<void> {
  await stopDiscoveredProcesses(() => worktreeProcesses(path), reason);
}

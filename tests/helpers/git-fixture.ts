import { runCommand } from "./run-command.js";

const identity = { name: "Suplex", email: "suplex@example.invalid" };

export async function initializeGitFixture(directory: string, branch: string, bare = false): Promise<void> {
  await command(directory, ["init", `--initial-branch=${branch}`, ...(bare ? ["--bare"] : [])], bare);
  await command(directory, ["config", "user.name", identity.name], bare);
  await command(directory, ["config", "user.email", identity.email], bare);
  await command(directory, ["config", "commit.gpgsign", "false"], bare);
}

export async function commitGitFixture(directory: string, message: string, files: readonly string[]): Promise<string> {
  if (files.length > 0) await command(directory, ["add", "--", ...files]);
  await command(directory, ["commit", "--allow-empty", "-m", message]);
  return (await command(directory, ["rev-parse", "HEAD"])).trim();
}

async function command(directory: string, args: readonly string[], bare = false): Promise<string> {
  const result = await runCommand({ command: "git", args: [bare ? "--git-dir" : "-C", directory, ...args] });
  return result.stdout;
}

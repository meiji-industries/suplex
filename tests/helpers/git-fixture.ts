import * as fs from "node:fs";
import { join } from "node:path";
import * as git from "isomorphic-git";

const identity = { name: "Forge", email: "forge@example.invalid" };

export async function initializeGitFixture(directory: string, branch: string, bare = false): Promise<void> {
  await git.init({ fs, dir: directory, defaultBranch: branch, bare });
  const gitdir = bare ? directory : join(directory, ".git");
  await git.setConfig({ fs, dir: directory, gitdir, path: "user.name", value: identity.name });
  await git.setConfig({ fs, dir: directory, gitdir, path: "user.email", value: identity.email });
  await git.setConfig({ fs, dir: directory, gitdir, path: "commit.gpgsign", value: "false" });
}

export async function commitGitFixture(directory: string, message: string, files: readonly string[]): Promise<string> {
  for (const filepath of files) await git.add({ fs, dir: directory, filepath });
  return git.commit({ fs, dir: directory, message, author: identity, committer: identity });
}

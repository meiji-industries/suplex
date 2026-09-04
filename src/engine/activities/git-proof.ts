import type { GithubReleasePort } from "../../github-release.js";
import { runCommand } from "../../command-runner.js";

export type GitRevisionProof = {
  proven: boolean;
  head: string | null;
  headTree: string | null;
  branch: string | null;
  clean: boolean;
  baseIsAncestor?: boolean;
  reason?: string;
};

export async function proveRevisionInGit(githubRelease: Pick<GithubReleasePort, "inspectLocalRevision">, input: { worktreePath: string; branchName: string; commit: string; tree: string; baseSha?: string }): Promise<GitRevisionProof> {
  try {
    const revision = await githubRelease.inspectLocalRevision({ cwd: input.worktreePath });
    const base = input.baseSha
      ? await runCommand({ taskId: null, stepId: null, command: "git", args: ["merge-base", "--is-ancestor", input.baseSha, input.commit], cwd: input.worktreePath, timeout: 8_000, expectedExitCodes: [1] })
      : undefined;
    const baseIsAncestor = base ? base.exitCode === 0 : undefined;
    const proven = revision.clean
      && revision.branch === input.branchName
      && revision.headSha.toLowerCase() === input.commit.toLowerCase()
      && revision.treeSha.toLowerCase() === input.tree.toLowerCase()
      && baseIsAncestor !== false;
    return { proven, head: revision.headSha, headTree: revision.treeSha, branch: revision.branch, clean: revision.clean, ...(baseIsAncestor === undefined ? {} : { baseIsAncestor }), ...(proven ? {} : { reason: "local revision does not match the reviewed revision" }) };
  } catch {
    return { proven: false, head: null, headTree: null, branch: null, clean: false, reason: "local revision could not be inspected" };
  }
}

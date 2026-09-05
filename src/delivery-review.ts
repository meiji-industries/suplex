import { runCommand } from "./command-runner.js";
import type { DeliveryReview } from "./root-contracts.js";

export async function inspectDeliveryDiff(cwd: string, baseSha: string, headSha: string) {
  if (![baseSha, headSha].every(sha => /^[a-f0-9]{40,64}$/i.test(sha))) throw new Error("GitHub delivery revisions are not valid");
  const git = (args: string[]) => runCommand({ taskId: null, stepId: null, command: "git", cwd, args, timeout: 30_000 });
  const base = await runCommand({ taskId: null, stepId: null, command: "git", cwd, args: ["cat-file", "-e", `${baseSha}^{commit}`], expectNonZero: true });
  if (base.exitCode !== 0) await git(["fetch", "--no-tags", "origin", baseSha]);
  const [files, commits, patch] = await Promise.all([
    git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", `${baseSha}...${headSha}`, "--"]),
    git(["rev-list", `${baseSha}..${headSha}`]),
    git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", `${baseSha}...${headSha}`, "--"]),
  ]);
  return { baseSha, headSha, files: files.stdout.split("\0").filter(Boolean), commits: commits.stdout.trim().split("\n").filter(Boolean), patch: patch.stdout.slice(0, 64_000), patchTruncated: patch.stdout.length > 64_000 };
}

export function matchesDeliveryReview(review: DeliveryReview, actual: DeliveryReview): boolean {
  const same = (left: string[], right: string[]) => {
    const sortedRight = [...right].sort();
    return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index]);
  };
  return review.baseSha === actual.baseSha && review.headSha === actual.headSha && same(review.files, actual.files) && same(review.commits, actual.commits);
}

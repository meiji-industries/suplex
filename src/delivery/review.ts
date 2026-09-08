import { runCommand } from "../platform/command-runner.js";
import { createHash } from "node:crypto";
import { rangeDifferences, sameRange, type ReviewRange } from "../coordination/workflows.js";

const shaPattern = /^[a-f0-9]{40,64}$/i;
const gitTimeout = 30_000;

const git = (cwd: string, args: string[], expectNonZero = false) => runCommand({ taskId: null, stepId: null, command: "git", cwd, args, timeout: gitTimeout, ...(expectNonZero ? { expectNonZero: true } : {}) });

async function ensureCommit(cwd: string, sha: string): Promise<void> {
  const present = await git(cwd, ["cat-file", "-e", `${sha}^{commit}`], true);
  if (present.exitCode === 0) return;
  const fetched = await git(cwd, ["fetch", "--no-tags", "origin", sha], true);
  if (fetched.exitCode !== 0) throw new Error(`Git could not obtain reviewed revision ${sha.slice(0, 12)}`);
}

export async function inspectDeliveryDiff(cwd: string, baseSha: string, headSha: string) {
  if (![baseSha, headSha].every(sha => shaPattern.test(sha))) throw new Error("GitHub delivery revisions are not valid");
  await Promise.all([ensureCommit(cwd, baseSha), ensureCommit(cwd, headSha)]);
  const [files, commits, patch] = await Promise.all([
    git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", `${baseSha}...${headSha}`, "--"]),
    git(cwd, ["rev-list", `${baseSha}..${headSha}`]),
    git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", `${baseSha}...${headSha}`, "--"]),
  ]);
  return { baseSha, headSha, files: files.stdout.split("\0").filter(Boolean), commits: commits.stdout.trim().split("\n").filter(Boolean), patchDigest: createHash("sha256").update(patch.stdout).digest("hex"), patch: patch.stdout.slice(0, 64_000), patchTruncated: patch.stdout.length > 64_000 };
}

/**
 * Review equivalence: a reviewed range still authorizes delivery onto a different base when (A) the range is real in Git,
 * (B) the delivered commit set is unchanged, and (C) the exact content the integration introduces onto the new base equals
 * the reviewed patch. File names, counts, and the truncated display patch are never sufficient.
 */
export async function reviewEquivalence(cwd: string, accepted: ReviewRange, baseSha: string): Promise<{ ok: true; range: ReviewRange } | { ok: false; reason: string }> {
  if (![accepted.baseSha, baseSha, accepted.headSha].every(sha => shaPattern.test(sha))) return { ok: false, reason: "Git delivery revisions are not valid" };
  try {
    await Promise.all([ensureCommit(cwd, accepted.baseSha), ensureCommit(cwd, baseSha), ensureCommit(cwd, accepted.headSha)]);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Git could not obtain the reviewed revisions" };
  }

  const reviewed = await inspectDeliveryDiff(cwd, accepted.baseSha, accepted.headSha);
  if (!sameRange(accepted, reviewed)) return { ok: false, reason: `The accepted range no longer matches Git: ${rangeDifferences(accepted, reviewed).join(", ")}.` };
  const range = (diff: Awaited<ReturnType<typeof inspectDeliveryDiff>>): ReviewRange => ({ baseSha: diff.baseSha, headSha: diff.headSha, files: diff.files, commits: diff.commits, patchDigest: diff.patchDigest });
  if (baseSha === accepted.baseSha) return { ok: true, range: range(reviewed) };

  const merged = await git(cwd, ["merge-tree", "--write-tree", "--no-messages", baseSha, accepted.headSha], true);
  if (merged.exitCode !== 0) {
    const files = merged.stdout.split("\n").filter(line => /^\d+\t/.test(line)).map(line => line.split("\t").at(-1)!).filter(Boolean);
    if (!files.length) {
      const names = await git(cwd, ["merge-tree", "--write-tree", "--name-only", baseSha, accepted.headSha], true);
      files.push(...names.stdout.split("\n").filter(Boolean));
    }
    return { ok: false, reason: `Integrating the reviewed head onto base ${baseSha.slice(0, 12)} conflicts in: ${files.join(", ") || "unknown files"}.` };
  }
  const fresh = await inspectDeliveryDiff(cwd, baseSha, accepted.headSha);
  if (!sameRange(reviewed, fresh)) return { ok: false, reason: `The base branch advanced and changed the reviewed range (${rangeDifferences(reviewed, fresh).join(", ")}).` };
  return { ok: true, range: range(fresh) };
}

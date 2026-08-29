import { expect, test } from "vitest";

import { buildDraftPullRequestProjection, createGithubReleasePort, GithubReleaseFailure, mapGithubPullRequestObservation, sanitizePublicText, type GithubCommandSpec, type GithubCommandResult } from "../src/github-release.js";
import { ReleaseFailureCodeSchema } from "../src/release-failures.js";
import { jsonRequired } from "../src/task-utils.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function pull(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    html_url: "https://github.com/acme/forge/pull/7",
    state: "open",
    draft: true,
    merged_at: null,
    head: { ref: "issue/7", sha: headSha, repo: { full_name: "acme/forge" } },
    base: { ref: "main", sha: baseSha, repo: { full_name: "acme/forge" } },
    ...overrides,
  });
}

function pullList(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{ number: 7, url: "https://github.com/acme/forge/pull/7", isDraft: true, state: "OPEN", headRefName: "issue/7", headRefOid: headSha, baseRefName: "main", baseRefOid: baseSha, ...overrides }]);
}

type ScriptResponse = GithubCommandResult & { error?: boolean };

function runnerFor(responses: ScriptResponse[]): { calls: GithubCommandSpec[]; runner: (input: GithubCommandSpec) => Promise<GithubCommandResult> } {
  const calls: GithubCommandSpec[] = [];
  let index = 0;
  return {
    calls,
    runner: async (input) => {
      calls.push(input);
      const response = responses[index++];
      if (!response) throw new Error(`unexpected command ${input.args.join(" ")}`);
      if (response.error) throw { stdout: response.stdout, stderr: response.stderr };
      return response;
    },
  };
}

test("uses supported gh commands and parses branch and pull observations", async () => {
  const value = runnerFor([
    { stdout: "ok\n", stderr: "" },
    { stdout: "git@github.com:Acme/Forge.git\n", stderr: "" },
    { stdout: "issue/7\n", stderr: "" },
    { stdout: `${headSha}\n`, stderr: "" },
    { stdout: `${"c".repeat(40)}\n`, stderr: "" },
    { stdout: "", stderr: "" },
    { stdout: "", stderr: "" },
    { stdout: JSON.stringify({ commit: { sha: baseSha } }), stderr: "" },
    { stdout: pullList(), stderr: "" },
    { stdout: pullList({ state: "MERGED", isDraft: false }), stderr: "" },
    { stdout: pull({ title: "Improve releases", body: "Useful description" }), stderr: "" },
    { stdout: JSON.stringify(jsonRequired(pull({ number: 8, html_url: "https://github.com/acme/forge/pull/8" }))), stderr: "" },
  ]);
  const github = createGithubReleasePort({ ghCommand: "gh", gitCommand: "git", runner: value.runner });

  await github.checkAuthentication();
  expect(await github.getRemoteRepository({ cwd: "/worktree" })).toBe("acme/forge");
  expect(await github.inspectLocalRevision({ cwd: "/worktree" })).toEqual({ branch: "issue/7", headSha, treeSha: "c".repeat(40), clean: true });
  await github.pushNormal({ cwd: "/worktree", branch: "issue/7" });
  expect(await github.getBranchHead({ repository: "acme/forge", branch: "main" })).toBe(baseSha);
  expect(await github.listPullRequests({ repository: "acme/forge", owner: "acme", headBranch: "issue/7", baseBranch: "main" })).toHaveLength(1);
  expect((await github.listPullRequests({ repository: "acme/forge", owner: "acme", headBranch: "issue/7", baseBranch: "main" }))[0]?.state).toBe("merged");
  expect((await github.updateDraftPullRequest!({ repository: "acme/forge", number: 7, title: "Improve releases", body: "Useful description" })).number).toBe(7);
  expect((await github.getPullRequest({ repository: "acme/forge", number: 8 })).number).toBe(8);

  expect(value.calls.map(({ command, args }) => [command, ...args])).toEqual([
    ["gh", "auth", "status", "--hostname", "github.com"],
    ["git", "remote", "get-url", "origin"],
    ["git", "symbolic-ref", "--short", "HEAD"],
    ["git", "rev-parse", "HEAD"],
    ["git", "rev-parse", "HEAD^{tree}"],
    ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    ["git", "push", "--set-upstream", "origin", "HEAD:refs/heads/issue/7"],
    ["gh", "api", "repos/acme/forge/branches/main"],
    ["gh", "pr", "list", "--repo", "acme/forge", "--head", "issue/7", "--state", "open", "--limit", "100", "--json", "number,url,isDraft,state,headRefName,headRefOid,baseRefName,baseRefOid"],
    ["gh", "pr", "list", "--repo", "acme/forge", "--head", "issue/7", "--state", "open", "--limit", "100", "--json", "number,url,isDraft,state,headRefName,headRefOid,baseRefName,baseRefOid"],
    ["gh", "api", "--method", "PATCH", "repos/acme/forge/pulls/7", "-f", "title=Improve releases", "-f", "body=Useful description"],
    ["gh", "api", "repos/acme/forge/pulls/8"],
  ]);
  expect(value.calls.flatMap((call) => [call.command, ...call.args]).join(" ")).not.toMatch(/--force|--force-with-lease|\brebase\b|\breset\b|\bclean\b|\bamend\b|\bmerge\b|pr ready|auto-merge/);

  const mismatchedUpdate = runnerFor([{ stdout: pull({ title: "Wrong title", body: "Useful description" }), stderr: "" }]);
  await expect(createGithubReleasePort({ runner: mismatchedUpdate.runner }).updateDraftPullRequest({ repository: "acme/forge", number: 7, title: "Improve releases", body: "Useful description" })).rejects.toMatchObject({ code: "invalid-provider-response" });
});

test("maps GitHub's pull-request observation into Forge's provider truth", () => {
  expect(mapGithubPullRequestObservation({
    number: 1484,
    url: "https://github.com/acme/forge/pull/1484",
    state: "OPEN",
    isDraft: false,
    headRefOid: headSha,
    baseRefOid: baseSha,
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    reviewDecision: "APPROVED",
    author: { login: "acme", avatarUrl: "https://avatars.githubusercontent.com/acme" },
    changedFiles: 31,
    additions: 221,
    deletions: 5,
    statusCheckRollup: [
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "IN_PROGRESS", conclusion: null },
      { status: "COMPLETED", conclusion: "FAILURE" },
    ],
  })).toEqual({
    exists: true, number: 1484, url: "https://github.com/acme/forge/pull/1484", state: "open", isDraft: false,
    headSha, baseSha, mergeable: "MERGEABLE", author: { login: "acme", avatarUrl: "https://avatars.githubusercontent.com/acme" }, changedFiles: 31, additions: 221, deletions: 5, autoMergeEnabled: false, reviewDecision: "APPROVED",
    checks: { total: 3, pending: 1, failing: 1, successful: 1 },
  });
});

test("summarizes only the latest check run and classic commit statuses", () => {
  const observe = (statusCheckRollup: unknown[]) => mapGithubPullRequestObservation({
    number: 488, url: "https://github.com/meiji-industries/sampler/pull/488", state: "OPEN", isDraft: false, headRefOid: headSha, baseRefOid: baseSha,
    mergeable: "MERGEABLE", autoMergeRequest: null, reviewDecision: null, author: null, changedFiles: 0, additions: 0, deletions: 0, statusCheckRollup,
  }).checks;

  expect(observe([
    { __typename: "CheckRun", name: "claude-review", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-24T23:45:26Z", completedAt: "2026-08-24T23:45:27Z" },
    { __typename: "CheckRun", name: "claude-review", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-24T23:45:36Z", completedAt: "2026-08-24T23:46:17Z" },
    { __typename: "CheckRun", name: "[code]smith", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-08-24T23:45:24Z", completedAt: "2026-08-24T23:45:24Z" },
  ])).toEqual({ total: 2, pending: 0, failing: 0, successful: 2 });
  expect(observe([
    { name: "test", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-08-24T23:45:27Z" },
    { name: "test", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-24T23:46:17Z" },
  ])).toEqual({ total: 1, pending: 0, failing: 0, successful: 1 });
  expect(observe([
    { name: "cancelled", status: "COMPLETED", conclusion: "CANCELLED", completedAt: "2026-08-24T23:45:27Z" },
    { name: "failed", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-08-24T23:45:27Z" },
  ])).toEqual({ total: 2, pending: 0, failing: 2, successful: 0 });
  expect(observe([
    { __typename: "StatusContext", context: "CI (Linux)", state: "SUCCESS", updatedAt: "2026-08-24T23:45:27Z" },
    { __typename: "StatusContext", context: "CI (Windows)", state: "PENDING", updatedAt: "2026-08-24T23:45:27Z" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-24T23:45:27Z" },
  ])).toEqual({ total: 3, pending: 1, failing: 0, successful: 2 });
});

test("maps nullable authors, avatar fallbacks, and change stats", () => {
  const observation = {
    number: 1484, url: "https://github.com/acme/forge/pull/1484", state: "OPEN" as const, isDraft: false,
    headRefOid: headSha, baseRefOid: baseSha, mergeable: "MERGEABLE", autoMergeRequest: null, reviewDecision: null,
    changedFiles: 4, additions: 12, deletions: 3, statusCheckRollup: null,
  };
  expect(mapGithubPullRequestObservation({ ...observation, author: null })).toMatchObject({ author: null, changedFiles: 4, additions: 12, deletions: 3 });
  expect(mapGithubPullRequestObservation({ ...observation, author: { login: "octocat", avatarUrl: null } }).author).toEqual({ login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/octocat" });
});

test("reconciles a manually advanced branch by rebasing before a normal push", async () => {
  const value = runnerFor([
    { stdout: "", stderr: "" },
    { stdout: "", stderr: "", error: true },
    { stdout: "", stderr: "", error: true },
    { stdout: "", stderr: "" },
    { stdout: "issue/7\n", stderr: "" },
    { stdout: `${headSha}\n`, stderr: "" },
    { stdout: `${"c".repeat(40)}\n`, stderr: "" },
    { stdout: "", stderr: "" },
  ]);
  const revision = await createGithubReleasePort({ runner: value.runner }).reconcileBranch!({ cwd: "/worktree", repository: "acme/forge", branch: "issue/7" });
  expect(revision).toEqual({ branch: "issue/7", headSha, treeSha: "c".repeat(40), clean: true });
  expect(value.calls.map(({ args }) => args)).toEqual([
    ["fetch", "origin", "refs/heads/issue/7:refs/remotes/origin/issue/7"],
    ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/issue/7"],
    ["merge-base", "--is-ancestor", "refs/remotes/origin/issue/7", "HEAD"],
    ["rebase", "refs/remotes/origin/issue/7"],
    ["symbolic-ref", "--short", "HEAD"],
    ["rev-parse", "HEAD"],
    ["rev-parse", "HEAD^{tree}"],
    ["status", "--porcelain=v1", "--untracked-files=all"],
  ]);
});

test("adopts absent branch observations and validates rate limits", async () => {
  const absent = runnerFor([{ stdout: JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest/branches", status: 404 }), stderr: "", error: true }]);
  expect(await createGithubReleasePort({ runner: absent.runner }).getBranchHead({ repository: "acme/forge", branch: "missing" })).toBeNull();

  const missingPullRequest = runnerFor([{ stdout: JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest", status: 404 }), stderr: "", error: true }]);
  await expect(createGithubReleasePort({ runner: missingPullRequest.runner }).getPullRequest({ repository: "acme/forge", number: 7 })).rejects.toMatchObject({ code: "provider-unavailable", summary: "GitHub resource was not found or is inaccessible" });

  const plainNotFound = runnerFor([{ stdout: "", stderr: "Not Found", error: true }]);
  expect(await createGithubReleasePort({ runner: plainNotFound.runner }).getBranchHead({ repository: "acme/forge", branch: "missing" })).toBeNull();

  const reset = Math.floor(Date.now() / 1_000) + 600;
  const limited = runnerFor([
    { stdout: JSON.stringify({ message: "rate limit", documentation_url: "https://docs.github.com/rest", status: 403 }), stderr: "rate limited", error: true },
    { stdout: JSON.stringify({ resources: { core: { reset } } }), stderr: "" },
  ]);
  await expect(createGithubReleasePort({ runner: limited.runner }).getBranchHead({ repository: "acme/forge", branch: "main" })).rejects.toMatchObject({ code: "provider-rate-limited", retryAt: new Date(reset * 1_000).toISOString() });
});

test("uses the supported gh command to mark a draft pull request ready", async () => {
  const value = runnerFor([{ stdout: pull(), stderr: "" }, { stdout: "✓ Pull request acme/forge#7 is now ready for review\n", stderr: "" }]);
  await createGithubReleasePort({ runner: value.runner }).markReadyForReview({ repository: "acme/forge", number: 7 });
  expect(value.calls.map(({ command, args }) => [command, ...args])).toEqual([["gh", "api", "repos/acme/forge/pulls/7"], ["gh", "pr", "ready", "7", "--repo", "acme/forge"]]);
});

test("enables protected auto-merge for the exact reviewed commit", async () => {
  const value = runnerFor([
    { stdout: pull({ draft: false }), stderr: "" },
    { stdout: JSON.stringify({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true }), stderr: "" },
    { stdout: "✓ Pull request acme/forge#7 will be automatically merged when all requirements are met\n", stderr: "" },
  ]);
  await createGithubReleasePort({ runner: value.runner }).enableAutoMerge!({ repository: "acme/forge", number: 7, headSha });
  expect(value.calls.map(({ command, args }) => [command, ...args])).toEqual([["gh", "api", "repos/acme/forge/pulls/7"], ["gh", "api", "repos/acme/forge"], ["gh", "pr", "merge", "7", "--repo", "acme/forge", "--auto", "--merge", "--match-head-commit", headSha]]);

  const squashOnly = runnerFor([
    { stdout: pull({ draft: false }), stderr: "" },
    { stdout: JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" },
    { stdout: "✓ Pull request acme/forge#7 will be automatically merged when all requirements are met\n", stderr: "" },
  ]);
  await createGithubReleasePort({ runner: squashOnly.runner }).enableAutoMerge!({ repository: "acme/forge", number: 7, headSha });
  expect(squashOnly.calls[2]!.args).toContain("--squash");
});

test("adopts GitHub pull URLs and repository casing while retaining provider failure summaries", async () => {
  const malformed = runnerFor([{ stdout: pull({ html_url: "https://evil.example/pull/7" }), stderr: "" }]);
  expect((await createGithubReleasePort({ runner: malformed.runner }).getPullRequest({ repository: "acme/forge", number: 7 })).url).toBe("https://evil.example/pull/7");

  const mixedCaseRepository = runnerFor([{ stdout: pull({ head: { ref: "issue/7", sha: headSha, repo: { full_name: "AcMe/FoRgE" } }, base: { ref: "main", sha: baseSha, repo: { full_name: "AcMe/FoRgE" } } }), stderr: "" }]);
  expect((await createGithubReleasePort({ runner: mixedCaseRepository.runner }).getPullRequest({ repository: "acme/forge", number: 7 })).repository).toBe("acme/forge");

  const failed = runnerFor([{ stdout: "", stderr: "/Users/dev/private/repo token=secret_value prompt=do-not-persist", error: true }]);
  try { await createGithubReleasePort({ runner: failed.runner }).pushNormal({ cwd: "/worktree", branch: "issue/7" }); } catch (error) {
    expect(error).toBeInstanceOf(GithubReleaseFailure);
    expect((error as GithubReleaseFailure).summary).toBe("/Users/dev/private/repo token=secret_value prompt=do-not-persist");
  }
});

test("sanitizes public PR text without removing delivery evidence", () => {
  expect(sanitizePublicText("line\u0000\nnext\u007f")).toBe("linenext");
  expect(sanitizePublicText("Bearer token-value gho_abcdef github_pat_abcdef sk-abcdef token=abc password: xyz secret = value api-key=key")).toBe("[redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted]");
  expect(sanitizePublicText(`commit ${headSha} https://github.com/acme/forge /Users/dev/code/forge`)).toContain(`commit ${headSha} https://github.com/acme/forge /Users/dev/code/forge`);
  const truncated = sanitizePublicText("🌟".repeat(200), 300);
  expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(300);
  expect(truncated).toMatch(/…$/);
});

test("builds a deterministic bounded public projection", () => {
  const projection = buildDraftPullRequestProjection({ taskTitle: "Original task title", pullRequestTitle: "Improve release publishing", pullRequestDescription: "Give reviewers clear context before they open the diff.", deliverySummary: "Implemented the approved release presentation.", changes: ["Use the approved plan for public Git metadata.", "Use the approved plan for public Git metadata."], filesChanged: ["src/main.ts", "src/main.ts"], commandsRun: ["pnpm test", "pnpm test"], testResults: ["2 passed"] });
  expect(projection.title).toBe("Improve release publishing");
  expect(projection.body).toBe(`## Summary

Give reviewers clear context before they open the diff.

Implemented the approved release presentation.

## Changes

- Use the approved plan for public Git metadata.

## Testing

- \`pnpm test\`
- 2 passed
`);
  expect(projection.body).not.toMatch(/^(?:Title|Body):/m);
  expect(Buffer.byteLength(projection.body)).toBeLessThanOrEqual(20_000);

  const bounded = buildDraftPullRequestProjection({
    taskTitle: "Bound a large delivery",
    pullRequestDescription: "\ud83c\udf1f".repeat(2_000),
    changes: Array.from({ length: 50 }, (_, index) => `${index} ${"\ud83c\udf1f".repeat(500)}`),
    filesChanged: Array.from({ length: 50 }, (_, index) => `src/${index}-${"x".repeat(450)}.ts`),
    commandsRun: Array.from({ length: 50 }, (_, index) => `command-${index} ${"`".repeat(200)}`),
    testResults: Array.from({ length: 50 }, (_, index) => `${index} ${"\ud83c\udf1f".repeat(500)} passed`),
  });
  expect(Buffer.byteLength(bounded.body)).toBeLessThanOrEqual(20_000);
  expect(bounded.body).toContain("```");

  expect(() => buildDraftPullRequestProjection({ taskTitle: "Improve Forge releases", filesChanged: ["src/main.ts"] })).not.toThrow();

  const evidence = buildDraftPullRequestProjection({ taskTitle: "Safe title", pullRequestDescription: "Expose task_1234567890abcdef", filesChanged: ["/Users/dev/private.txt"], commandsRun: [`git show ${headSha}`, "token=secret_value"] });
  expect(evidence.body).toContain("/Users/dev/private.txt");
  expect(evidence.body).toContain(headSha);
  expect(evidence.body).toContain("task_1234567890abcdef");
  expect(evidence.body).toContain("[redacted]");
});

test("keeps the historical public projection failure parseable", () => {
  expect(ReleaseFailureCodeSchema.parse("public-projection-unsafe")).toBe("public-projection-unsafe");
});

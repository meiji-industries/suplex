import { expect, test } from "vitest";
import { createGithubReleasePort, mapGithubPullRequestObservation } from "../src/github-delivery.js";

test.each([
  [{ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }, "--squash"],
  [{ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: false }, "--merge"],
  [{ allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true }, "--rebase"],
] as const)("merge uses a repository-supported method %s", async (settings, method) => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    return { stdout: input.args[0] === "api" ? JSON.stringify(settings) : "", stderr: "" };
  } });
  await port.mergePullRequest({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) });
  expect(calls).toEqual([["api", "repos/owner/repo"], ["pr", "merge", "7", "--repo", "owner/repo", method, "--match-head-commit", "a".repeat(40)]]);
});

test("GitHub outages are not interpreted as missing branches", async () => {
  const port = createGithubReleasePort({ runner: async () => { throw Object.assign(new Error("Network failure"), { stderr: "connect: connection refused" }); } });
  await expect(port.getBranchHead({ repository: "owner/repo", branch: "task" })).rejects.toThrow("connection refused");
});

test("an explicit GitHub 404 is an absent branch", async () => {
  const port = createGithubReleasePort({ runner: async () => { throw Object.assign(new Error("Not found"), { stderr: "gh: Not Found (HTTP 404)" }); } });
  await expect(port.getBranchHead({ repository: "owner/repo", branch: "task" })).resolves.toBeNull();
});

test("check observations retain actionable CI names and log links", () => {
  const observed = mapGithubPullRequestObservation({ number: 7, url: "https://github.com/owner/repo/pull/7", state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), mergeable: "MERGEABLE", autoMergeRequest: null, reviewDecision: null, author: null, changedFiles: 1, additions: 1, deletions: 0, statusCheckRollup: [
    { name: "unit", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/owner/repo/actions/runs/1" },
    { context: "deploy", state: "PENDING", targetUrl: "https://example.com/deploy" },
  ] });
  expect(observed.checks).toEqual({ total: 2, pending: 1, failing: 1, successful: 0, runs: [
    { name: "unit", status: "failing", conclusion: "FAILURE", url: "https://github.com/owner/repo/actions/runs/1" },
    { name: "deploy", status: "pending", url: "https://example.com/deploy" },
  ] });
});

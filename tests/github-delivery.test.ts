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

test.each([
  [{ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }, "squash"],
  [{ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: false }, "merge"],
  [{ allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true }, "rebase"],
] as const)("direct merge conditionally uses %s", async (settings, method) => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => { calls.push(input.args); return { stdout: JSON.stringify(input.args.some(value => value.includes("/merge")) ? { merged: true, message: "ok", sha: "b".repeat(40) } : settings), stderr: "" }; } });
  await expect(port.mergePullRequestDirect!({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).resolves.toEqual({ merged: true, sha: "b".repeat(40) });
  expect(calls).toEqual([["api", "repos/owner/repo"], ["api", "--method", "PUT", "repos/owner/repo/pulls/7/merge", "-f", `sha=${"a".repeat(40)}`, "-f", `merge_method=${method}`]]);
});

test("direct merge does not retry a not-ready or malformed response", async () => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => { calls.push(input.args); return { stdout: JSON.stringify(input.args.some(value => value.includes("/merge")) ? { merged: false, message: "not ready" } : { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" }; } });
  await expect(port.mergePullRequestDirect!({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).resolves.toEqual({ merged: false, sha: null });
  expect(calls).toHaveLength(2);
});

test("GitHub outages are not interpreted as missing branches", async () => {
  const port = createGithubReleasePort({ runner: async () => { throw Object.assign(new Error("Network failure"), { stderr: "connect: connection refused" }); } });
  await expect(port.getBranchHead({ repository: "owner/repo", branch: "task" })).rejects.toThrow("connection refused");
});

test("an explicit GitHub 404 is an absent branch", async () => {
  const port = createGithubReleasePort({ runner: async () => { throw Object.assign(new Error("Not found"), { stderr: "gh: Not Found (HTTP 404)" }); } });
  await expect(port.getBranchHead({ repository: "owner/repo", branch: "task" })).resolves.toBeNull();
});

test("bounded open pull request queries remain unchanged", async () => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    return { stdout: JSON.stringify([{ number: 7, url: "https://github.com/owner/repo/pull/7", isDraft: false, state: "OPEN", headRefName: "feature", headRefOid: "a".repeat(40), baseRefName: "main", baseRefOid: "b".repeat(40), title: "Existing query", body: "", author: { login: "octo" }, isCrossRepository: false }]), stderr: "" };
  } });
  await expect(port.listOpenPullRequests({ repository: "owner/repo", limit: 1000 })).resolves.toMatchObject([{ number: 7, title: "Existing query" }]);
  expect(calls).toEqual([["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "100", "--json", "number,url,isDraft,state,headRefName,headRefOid,baseRefName,baseRefOid,title,body,author,updatedAt,isCrossRepository"]]);
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

test("issue context reads every comment page and validates provider data", async () => {
  const calls: string[][] = [];
  const issue = { number: 42, url: "https://github.com/owner/repo/issues/42", title: "Search", body: "", author: null, state: "OPEN", labels: [], assignees: [], milestone: null, updatedAt: "2026-09-07" };
  const comment = { html_url: issue.url + "#issuecomment-1", body: "Detail", user: null, created_at: "2026-09-07" };
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    return { stdout: JSON.stringify(input.args[0] === "api" ? [[comment], [{ ...comment, body: "Last page" }]] : input.args[1] === "list" ? [issue] : issue), stderr: "" };
  } });
  expect(await port.listOpenIssues({ repository: "owner/repo", limit: 100 })).toEqual([issue]);
  expect((await port.getIssue({ repository: "owner/repo", number: 42 })).comments.map(row => row.body)).toEqual(["Detail", "Last page"]);
  expect(calls[2]).toEqual(["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"]);
  const malformed = createGithubReleasePort({ runner: async () => ({ stdout: '{"number":"invalid"}', stderr: "" }) });
  await expect(malformed.getIssue({ repository: "owner/repo", number: 42 })).rejects.toThrow();
});

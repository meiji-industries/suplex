import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createGithubReleasePort, mapGithubPullRequestObservation } from "../src/integrations/github/delivery.js";

test.each([
  [{ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }, "squash"],
  [{ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: false }, "merge"],
  [{ allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true }, "rebase"],
] as const)("merge uses a repository-supported method %s", async (settings, method) => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    return { stdout: JSON.stringify(input.args.some(value => value.includes("/merge")) ? { merged: true, message: "ok", sha: "b".repeat(40) } : settings), stderr: "" };
  } });
  await port.mergePullRequest({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) });
  expect(calls).toEqual([["api", "repos/owner/repo"], ["api", "--method", "PUT", "repos/owner/repo/pulls/7/merge", "-f", `sha=${"a".repeat(40)}`, "-f", `merge_method=${method}`]]);
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

test.each([
  ["fail", "blocked"],
  ["pending", "waiting"],
] as const)("direct merge reports a required %s check as %s with native evidence", async (bucket, disposition) => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    if (input.args.some(value => value.includes("/merge"))) throw Object.assign(new Error("not mergeable"), {
      stdout: JSON.stringify({ message: "Pull Request is not mergeable", documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request", status: "405" }),
      stderr: "gh: Pull Request is not mergeable (HTTP 405)",
    });
    if (input.args[0] === "pr" && input.args[1] === "view") return { stdout: JSON.stringify({ id: "PR_7", headRefOid: "a".repeat(40), baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }), stderr: "" };
    if (input.args[0] === "pr" && input.args[1] === "checks") {
      const stdout = JSON.stringify([{ name: "unit", bucket, state: bucket === "fail" ? "FAILURE" : "PENDING", link: "https://github.com/owner/repo/actions/runs/1" }]);
      throw Object.assign(new Error("checks incomplete"), { stdout, stderr: "" });
    }
    if (input.args.some(value => value.includes("/rules/branches/main"))) return { stdout: "[]", stderr: "" };
    return { stdout: JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" };
  } });
  await expect(port.mergePullRequestDirect!({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).resolves.toEqual({ merged: false, sha: null, disposition, message: expect.stringMatching(/unit.*FAILURE|unit.*PENDING/) });
  expect(calls).toContainEqual(["pr", "checks", "7", "--repo", "owner/repo", "--required", "--json", "name,bucket,state,link"]);
});

test("direct merge reports a native conflict instead of waiting", async () => {
  const port = createGithubReleasePort({ runner: async input => {
    if (input.args.some(value => value.includes("/merge"))) throw Object.assign(new Error("not mergeable"), {
      stdout: JSON.stringify({ message: "Pull Request is not mergeable", documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request", status: "405" }),
      stderr: "gh: Pull Request is not mergeable (HTTP 405)",
    });
    if (input.args[0] === "pr" && input.args[1] === "view") return { stdout: JSON.stringify({ id: "PR_7", headRefOid: "a".repeat(40), baseRefName: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), stderr: "" };
    if (input.args[0] === "pr" && input.args[1] === "checks") return { stdout: "[]", stderr: "" };
    if (input.args.some(value => value.includes("/rules/branches/main"))) return { stdout: "[]", stderr: "" };
    return { stdout: JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" };
  } });
  await expect(port.mergePullRequestDirect!({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).resolves.toMatchObject({ merged: false, disposition: "blocked", message: expect.stringMatching(/conflict/i) });
});

test("direct merge is blocked without enqueueing when the base requires a merge queue", async () => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    if (input.args.some(value => value.includes("/merge"))) throw Object.assign(new Error("not mergeable"), {
      stdout: JSON.stringify({ message: "Pull Request is not mergeable", documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request", status: "405" }),
      stderr: "gh: Pull Request is not mergeable (HTTP 405)",
    });
    if (input.args[0] === "pr" && input.args[1] === "view") return { stdout: JSON.stringify({ id: "PR_7", headRefOid: "a".repeat(40), baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }), stderr: "" };
    if (input.args[0] === "pr" && input.args[1] === "checks") return { stdout: "[]", stderr: "" };
    if (input.args.some(value => value.includes("/rules/branches/main"))) return { stdout: JSON.stringify([{ type: "merge_queue" }]), stderr: "" };
    if (input.args[0] === "api" && input.args[1] === "graphql") throw new Error("direct merge must not enqueue");
    return { stdout: JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" };
  } });
  await expect(port.mergePullRequestDirect!({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).resolves.toMatchObject({ merged: false, disposition: "blocked", message: expect.stringMatching(/merge queue.*direct trigger/i) });
  expect(calls.some(args => args[0] === "api" && args[1] === "graphql")).toBe(false);
  expect(calls.flat().join(" ")).not.toContain("--auto");
});

test("ordinary merge enqueues the exact reviewed head when the base requires a merge queue", async () => {
  const calls: string[][] = [];
  const port = createGithubReleasePort({ runner: async input => {
    calls.push(input.args);
    if (input.args.some(value => value.includes("/merge"))) throw Object.assign(new Error("not mergeable"), {
      stdout: JSON.stringify({ message: "Pull Request is not mergeable", documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request", status: "405" }),
      stderr: "gh: Pull Request is not mergeable (HTTP 405)",
    });
    if (input.args[0] === "pr" && input.args[1] === "view") return { stdout: JSON.stringify({ id: "PR_7", headRefOid: "a".repeat(40), baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }), stderr: "" };
    if (input.args[0] === "pr" && input.args[1] === "checks") return { stdout: "[]", stderr: "" };
    if (input.args.some(value => value.includes("/rules/branches/main"))) return { stdout: JSON.stringify([{ type: "merge_queue" }]), stderr: "" };
    if (input.args[0] === "api" && input.args[1] === "graphql") return { stdout: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_1" } } } }), stderr: "" };
    return { stdout: JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" };
  } });
  await expect(port.mergePullRequest({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).resolves.toBeUndefined();
  expect(calls.at(-1)).toEqual(expect.arrayContaining(["graphql", "-f", `expectedHeadOid=${"a".repeat(40)}`]));
});

test.each([
  ["403", "authentication-required"],
  ["409", "provider-unavailable"],
] as const)("direct merge preserves GitHub HTTP %s as %s", async (status, code) => {
  const port = createGithubReleasePort({ runner: async input => {
    if (!input.args.some(value => value.includes("/merge"))) return { stdout: JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" };
    throw Object.assign(new Error("merge failed"), {
      stdout: JSON.stringify({ message: "merge failed", documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request", status }),
      stderr: `gh: merge failed (HTTP ${status})`,
    });
  } });
  await expect(port.mergePullRequestDirect!({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).rejects.toMatchObject({ code });
});

test("GitHub outages are not interpreted as missing branches", async () => {
  const port = createGithubReleasePort({ runner: async () => { throw Object.assign(new Error("Network failure"), { stderr: "connect: connection refused" }); } });
  await expect(port.getBranchHead({ repository: "owner/repo", branch: "task" })).rejects.toThrow("connection refused");
});

test("a missing GitHub executable reports its path and code", async () => {
  const command = "/definitely/missing/gh";
  const port = createGithubReleasePort({ ghCommand: command });
  await expect(port.getBranchHead({ repository: "owner/repo", branch: "task" })).rejects.toMatchObject({ code: "executable-missing", message: expect.stringContaining(`${command} could not start (ENOENT)`) });
});

test("transient GitHub observations retry through a third attempt", async () => {
  let observations = 0;
  const port = createGithubReleasePort({ retryPausesMs: [0, 0], runner: async input => {
    if (input.args.some(value => value.includes("/merge"))) throw Object.assign(new Error("not mergeable"), { stdout: JSON.stringify({ message: "not mergeable", status: "405" }), stderr: "HTTP 405" });
    if (input.args[0] === "pr" && input.args[1] === "view") {
      observations += 1;
      if (observations < 3) throw Object.assign(new Error("offline"), { stderr: "offline" });
      return { stdout: JSON.stringify({ id: "PR_7", headRefOid: "a".repeat(40), baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }), stderr: "" };
    }
    if (input.args[0] === "pr" && input.args[1] === "checks") return { stdout: "[]", stderr: "" };
    if (input.args.some(value => value.includes("/rules/branches/main"))) return { stdout: "[]", stderr: "" };
    return { stdout: JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" };
  } });
  await expect(port.mergePullRequestDirect!({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).resolves.toMatchObject({ merged: false, disposition: "blocked" });
  expect(observations).toBe(3);
});

test("transient GitHub observations stop after the configured retries", async () => {
  let observations = 0;
  const port = createGithubReleasePort({ retryPausesMs: [0], runner: async input => {
    if (input.args.some(value => value.includes("/merge"))) throw Object.assign(new Error("not mergeable"), { stdout: JSON.stringify({ message: "not mergeable", status: "405" }), stderr: "HTTP 405" });
    if (input.args[0] === "pr" && input.args[1] === "view") {
      observations += 1;
      throw Object.assign(new Error("offline"), { stderr: "offline" });
    }
    return { stdout: JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }), stderr: "" };
  } });
  await expect(port.mergePullRequestDirect!({ repository: "owner/repo", number: 7, headSha: "a".repeat(40) })).rejects.toMatchObject({ code: "provider-unavailable" });
  expect(observations).toBe(2);
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
    { name: "unit", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/owner/repo/actions/runs/1", workflowName: "CI", startedAt: "2026-09-13T04:57:33Z", completedAt: "2026-09-13T04:58:33Z" },
    { context: "deploy", state: "PENDING", targetUrl: "https://example.com/deploy" },
    { name: "lint", status: "IN_PROGRESS", startedAt: "2026-09-13T04:57:33Z", completedAt: "0001-01-01T00:00:00Z" },
  ] });
  expect(observed.checks).toEqual({ total: 3, pending: 2, failing: 1, successful: 0, runs: [
    { name: "unit", status: "failing", conclusion: "FAILURE", url: "https://github.com/owner/repo/actions/runs/1", workflow: "CI", startedAt: "2026-09-13T04:57:33.000Z", completedAt: "2026-09-13T04:58:33.000Z" },
    { name: "deploy", status: "pending", url: "https://example.com/deploy", workflow: null, startedAt: null, completedAt: null },
    { name: "lint", status: "pending", url: null, workflow: null, startedAt: "2026-09-13T04:57:33.000Z", completedAt: null },
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

test.each([false, true])("trigger inspection preserves large JSON through the real command runner (task-bound: %s)", async taskBound => {
  const directory = await mkdtemp(join(tmpdir(), "suplex-large-github-"));
  try {
    const command = join(directory, "gh-fixture");
    const repo = { id: 9, full_name: "owner/repo" };
    const pull = { number: 7, html_url: "https://github.com/owner/repo/pull/7", state: "open", draft: false, changed_files: 1, labels: [{ name: "needs review" }], title: "Large patch", head: { ref: "feature", sha: "a".repeat(40), repo }, base: { ref: "main", sha: "b".repeat(40), repo } };
    const files = [{ sha: "c".repeat(40), filename: "large.ts", status: "added", additions: 1, deletions: 0, changes: 1, blob_url: "https://github.com/owner/repo/blob/large.ts", raw_url: "https://github.com/owner/repo/raw/large.ts", contents_url: "https://api.github.com/repos/owner/repo/contents/large.ts", patch: "x".repeat(400_000) }];
    await writeFile(command, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.some(arg => arg.includes('/files?')) ? ${JSON.stringify(files)} : ${JSON.stringify(pull)}));\n`);
    await chmod(command, 0o755);
    const port = createGithubReleasePort({ ghCommand: command, ...(taskBound ? { taskId: "task", stepId: "inspection" } : {}) });
    await expect(port.inspectPullRequest({ repository: "owner/repo", number: 7 })).resolves.toMatchObject({ number: 7, changedFiles: 1, files: [{ filename: "large.ts" }] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

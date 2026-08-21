import { describe, expect, it } from "vitest";

import { buildCiPolicy, createGithubCiProvider, evaluateExactHead, selectLatestCheckRuns } from "../src/ci.js";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const base = "c".repeat(40);
const now = "2026-08-11T12:00:00.000Z";
const propagation = "2026-08-11T12:05:00.000Z";
const overall = "2026-08-11T13:00:00.000Z";

const pullRequest = (overrides: Record<string, unknown> = {}) => ({ repository: "acme/forge", number: 7, url: "https://github.com/acme/forge/pull/7", state: "open" as const, draft: true, baseBranch: "main", baseSha: base, headBranch: "feature/task", headSha: head, ...overrides });
const check = (overrides: Record<string, unknown> = {}) => ({ providerCheckId: "1", name: "Tests / unit", headSha: head, status: "completed" as const, conclusion: "success" as const, detailsUrl: null, startedAt: now, completedAt: now, summary: "ok", ...overrides });
const evaluate = (overrides: Record<string, unknown> = {}) => evaluateExactHead({ repository: "acme/forge", pullRequestNumber: 7, expectedRepository: "acme/forge", expectedPullRequestNumber: 7, expectedHeadSha: head, expectedBaseBranch: "main", expectedHeadBranch: "feature/task", requiredChecks: ["Tests / unit"], observedPullRequest: pullRequest(), checks: [check()], now, propagationDeadline: propagation, overallDeadline: overall, ...overrides });

describe("exact-head CI evaluator", () => {
  it.each([
    ["success", "passed", false],
    ["failure", "failed", true],
    ["cancelled", "cancelled", false],
    ["timed_out", "timed_out", false],
    ["neutral", "non_success", false],
    ["skipped", "passed", false],
    ["action_required", "non_success", false],
    ["stale", "non_success", false],
  ])("classifies %s", (conclusion, outcome, repairable) => {
    const result = evaluate({ checks: [check({ conclusion })] });
    expect(result.outcome).toBe(outcome);
    expect(result.repairable).toBe(repairable);
  });

  it("distinguishes propagation, active checks, missing checks, stale heads, and exhausted windows", () => {
    expect(evaluate({ checks: [], now: now }).outcome).toBe("waiting");
    expect(evaluate({ checks: [], now: propagation }).outcome).toBe("waiting");
    expect(evaluate({ checks: [check({ headSha: otherHead })], now }).outcome).toBe("waiting");
    expect(evaluate({ checks: [check({ status: "in_progress", conclusion: null })] }).outcome).toBe("waiting");
    expect(evaluate({ checks: [check({ status: "queued", conclusion: null })] }).outcome).toBe("waiting");
    expect(evaluate({ observedPullRequest: pullRequest({ headSha: otherHead }) }).reason).toBe("pull_request_head_changed");
    expect(evaluate({ now: overall }).reason).toBe("checks_passed");
  });

  it.each([
    ["repository", { repository: "other/forge" }, "pull_request_identity_changed"],
    ["number", { number: 8 }, "pull_request_identity_changed"],
    ["base branch", { baseBranch: "develop" }, "pull_request_base_branch_changed"],
    ["head branch", { headBranch: "other/task" }, "pull_request_head_branch_changed"],
    ["closed state", { state: "closed" }, "pull_request_not_open"],
  ])("rejects a changed PR %s", (_label, changed, reason) => {
    expect(evaluate({ observedPullRequest: pullRequest(changed) }).reason).toBe(reason);
  });

  it("continues evaluating an open PR after it becomes ready for review", () => {
    expect(evaluate({ observedPullRequest: pullRequest({ draft: false }) }).outcome).toBe("passed");
  });

  it("accepts a merged exact PR as the completion authority", () => {
    const merged = pullRequest({ state: "closed", mergedAt: "2026-08-11T12:01:00.000Z" });
    expect(evaluate({ observedPullRequest: merged })).toMatchObject({ outcome: "passed", reason: "checks_passed_merged" });
    expect(evaluate({ observedPullRequest: merged, checks: [check({ conclusion: "failure" })] })).toMatchObject({ outcome: "passed", reason: "checks_passed_merged" });
  });

  it("treats a configured check that never reports as not applicable once GitHub reports a clean merge state", () => {
    const clean = pullRequest({ mergeStateStatus: "CLEAN" });
    const required = ["Tests / unit", "Mintlify Deployment"];
    expect(evaluate({ observedPullRequest: clean, requiredChecks: required, now: propagation })).toMatchObject({ outcome: "passed", reason: "checks_passed_not_applicable" });
    expect(evaluate({ observedPullRequest: clean, requiredChecks: required, now: propagation }).summary).toContain("Mintlify Deployment");
    expect(evaluate({ observedPullRequest: clean, requiredChecks: required, checks: [check({ conclusion: "failure" })], now: propagation })).toMatchObject({ outcome: "failed", reason: "required_check_failed" });
    expect(evaluate({ observedPullRequest: clean, requiredChecks: required, checks: [], now: propagation })).toMatchObject({ outcome: "waiting", reason: "required_check_missing" });
    expect(evaluate({ requiredChecks: required, now: propagation })).toMatchObject({ outcome: "waiting", reason: "required_check_missing" });
  });

  it("routes a failed required check to repair even while another required check is missing", () => {
    const required = ["CI (Linux)", "CI (Windows)", "Mintlify Deployment"];
    const checks = [
      check({ providerCheckId: "10", name: "CI (Linux)", conclusion: "success" }),
      check({ providerCheckId: "11", name: "CI (Windows)", conclusion: "failure" }),
    ];
    expect(evaluate({ observedPullRequest: pullRequest({ mergeStateStatus: "UNSTABLE" }), requiredChecks: required, checks, now })).toMatchObject({ outcome: "failed", reason: "required_check_failed", owner: "lead", repairable: true });
  });

  it("keeps observing after the initial CI window instead of stranding a merged PR", () => {
    expect(evaluate({ checks: [], now: overall })).toMatchObject({ outcome: "waiting", reason: "poll_window_exhausted", owner: "system" });
  });

  it("selects the latest exact-head provider run and preserves all observations", () => {
    const selected = selectLatestCheckRuns([
      check({ providerCheckId: "1", conclusion: "failure" }),
      check({ providerCheckId: "2", conclusion: "success" }),
      check({ providerCheckId: "99", headSha: otherHead, conclusion: "failure" }),
    ], ["Tests / unit"], head);
    expect(selected.filter((row) => row.selectedForEvaluation).map((row) => row.providerCheckId)).toEqual(["2"]);
    expect(selected).toHaveLength(3);
  });

  it("selects a newer failure over an old pass without losing integer precision", () => {
    const selected = selectLatestCheckRuns([
      check({ providerCheckId: "90071992547409931", conclusion: "success" }),
      check({ providerCheckId: "90071992547409932", conclusion: "failure" }),
    ], ["Tests / unit"], head);
    expect(selected.find((row) => row.selectedForEvaluation)).toMatchObject({ providerCheckId: "90071992547409932", conclusion: "failure" });
  });

  it("uses dates then opaque IDs as deterministic tie breakers", () => {
    const dated = selectLatestCheckRuns([
      check({ providerCheckId: "old", completedAt: null, startedAt: now }),
      check({ providerCheckId: "new", completedAt: "2026-08-11T12:01:00.000Z", startedAt: null }),
    ], ["Tests / unit"], head);
    expect(dated.find((row) => row.selectedForEvaluation)?.providerCheckId).toBe("new");
    const opaque = selectLatestCheckRuns([
      check({ providerCheckId: "opaque-a", completedAt: null, startedAt: null }),
      check({ providerCheckId: "opaque-b", completedAt: null, startedAt: null }),
    ], ["Tests / unit"], head);
    expect(opaque.find((row) => row.selectedForEvaluation)?.providerCheckId).toBe("opaque-b");
  });

  it("canonicalizes policy and rejects an empty required-check set", () => {
    const first = buildCiPolicy("revision-1", [" Browser ", "Tests", "Browser"]);
    const second = buildCiPolicy("revision-1", ["Tests", "Browser"]);
    expect(first.policy.requiredChecks).toEqual(["Browser", "Tests"]);
    expect(first.policyHash).toBe(second.policyHash);
    expect(() => buildCiPolicy("revision-1", [" "])).toThrow("CI invalid-policy");
  });
});

describe("GitHub CI adapter", () => {
  it("uses the bounded API port and normalizes pull requests and checks", async () => {
    const calls: string[][] = [];
    const provider = createGithubCiProvider({ runner: async (args) => {
      calls.push(args);
      if (args[1]?.includes("/pulls/")) return { stdout: JSON.stringify({ number: 7, html_url: "https://github.com/acme/forge/pull/7", state: "open", draft: true, base: { ref: "main", sha: base }, head: { ref: "feature/task", sha: head, repo: { full_name: "acme/forge" } } }), stderr: "" };
      return { stdout: JSON.stringify({ total_count: 1, check_runs: [{ id: 2, name: "Tests / unit", head_sha: head, status: "completed", conclusion: "success", html_url: "https://github.com/acme/forge/actions/runs/2", started_at: now, completed_at: now, output: { summary: "ok" } }] }), stderr: "" };
    } });
    await expect(provider.getPullRequest?.({ repository: "acme/forge", pullRequestNumber: 7 })).resolves.toMatchObject({ headSha: head });
    await expect(provider.listChecks?.({ repository: "acme/forge", headSha: head })).resolves.toEqual([expect.objectContaining({ providerCheckId: "2", name: "Tests / unit", conclusion: "success" })]);
    expect(calls[0]).toEqual(["api", "repos/acme/forge/pulls/7", "--include"]);
    expect(calls[1]).toEqual(["api", `repos/acme/forge/commits/${head}/check-runs?per_page=100`, "--include", "--paginate", "--slurp"]);
  });

  it("combines every paginated check-run page", async () => {
    const page = (id: number, name: string) => ({ total_count: 2, check_runs: [{ id, name, head_sha: head, status: "completed", conclusion: "success", html_url: null, started_at: now, completed_at: now, output: { summary: "ok" } }] });
    const provider = createGithubCiProvider({ runner: async () => ({ stdout: JSON.stringify([page(1, "Tests"), page(2, "Browser")]), stderr: "" }) });
    await expect(provider.listChecks({ repository: "acme/forge", headSha: head })).resolves.toEqual([
      expect.objectContaining({ providerCheckId: "1", name: "Tests" }),
      expect.objectContaining({ providerCheckId: "2", name: "Browser" }),
    ]);
  });

  it.each([
    ["missing repository", { number: 7, html_url: "https://github.com/acme/forge/pull/7", state: "open", draft: true, base: { ref: "main", sha: base }, head: { ref: "feature/task", sha: head } }],
    ["missing head SHA", { number: 7, html_url: "https://github.com/acme/forge/pull/7", state: "open", draft: true, base: { ref: "main", sha: base }, head: { ref: "feature/task", repo: { full_name: "acme/forge" } } }],
  ])("rejects a PR with %s", async (_label, payload) => {
    const provider = createGithubCiProvider({ runner: async () => ({ stdout: JSON.stringify(payload), stderr: "" }) });
    await expect(provider.getPullRequest({ repository: "acme/forge", pullRequestNumber: 7 })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    ["unknown status", { status: "mystery", conclusion: "success" }],
    ["unknown conclusion", { status: "completed", conclusion: "mystery" }],
  ])("rejects a check with %s", async (_label, changed) => {
    const provider = createGithubCiProvider({ runner: async () => ({ stdout: JSON.stringify({ check_runs: [{ id: 1, name: "Tests", head_sha: head, html_url: null, started_at: now, completed_at: now, output: {}, ...changed }] }), stderr: "" }) });
    await expect(provider.listChecks({ repository: "acme/forge", headSha: head })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds and strips controls from check summaries", async () => {
    const provider = createGithubCiProvider({ runner: async () => ({ stdout: JSON.stringify({ check_runs: [{ id: 1, name: "Tests", head_sha: head, status: "completed", conclusion: "success", html_url: null, started_at: now, completed_at: now, output: { summary: `safe\u0000\n${"x".repeat(800)}` } }] }), stderr: "" }) });
    const [observed] = await provider.listChecks({ repository: "acme/forge", headSha: head });
    expect(observed?.summary).not.toMatch(/[\u0000-\u001f]/);
    expect(observed?.summary).toHaveLength(500);
  });

  it.each([
    ["Retry-After", "Retry-After: 30", "2026-08-11T12:00:30.000Z"],
    ["X-RateLimit-Reset", `X-RateLimit-Reset: ${Date.parse(now) / 1_000 + 45}`, "2026-08-11T12:00:45.000Z"],
  ])("uses the authoritative %s rate-limit header", async (_label, header, retryAt) => {
    const provider = createGithubCiProvider({ now: () => new Date(now), runner: async () => { throw Object.assign(new Error("API rate limit exceeded"), { status: 429, stderr: `HTTP/2 429\n${header}` }); } });
    await expect(provider.getPullRequest({ repository: "acme/forge", pullRequestNumber: 7 })).rejects.toMatchObject({ code: "rate_limited", retryAt });
  });

  it("does not invent a retry time for an unbounded rate limit", async () => {
    const provider = createGithubCiProvider({ runner: async () => { throw Object.assign(new Error("API rate limit exceeded"), { status: 429, stderr: "HTTP/2 429\nX-RateLimit-Remaining: 0" }); } });
    await expect(provider.getPullRequest?.({ repository: "acme/forge", pullRequestNumber: 7 })).rejects.toMatchObject({ code: "rate_limit_unbounded", retryAt: null });
  });

  it.each([
    ["authentication", Object.assign(new Error("HTTP 401 denied"), { stderr: "secret response body" }), "authentication", "GitHub authentication or permission failed"],
    ["server failure", Object.assign(new Error("HTTP 503"), { status: 503, stderr: "secret response body" }), "transient", "GitHub is temporarily unavailable"],
    ["connection failure", Object.assign(new Error("ECONNRESET"), { stderr: "secret response body" }), "transient", "GitHub is temporarily unavailable"],
    ["process timeout", Object.assign(new Error("ETIMEDOUT"), { stderr: "secret response body" }), "transient", "GitHub is temporarily unavailable"],
  ])("maps %s to a bounded safe failure", async (_label, error, code, safeSummary) => {
    const provider = createGithubCiProvider({ runner: async () => { throw error; } });
    await expect(provider.getPullRequest({ repository: "acme/forge", pullRequestNumber: 7 })).rejects.toMatchObject({ code, safeSummary });
  });

  it("rejects malformed JSON without returning the provider body", async () => {
    const provider = createGithubCiProvider({ runner: async () => ({ stdout: "not-json secret-provider-body", stderr: "" }) });
    await expect(provider.getPullRequest({ repository: "acme/forge", pullRequestNumber: 7 })).rejects.toMatchObject({ code: "invalid_response", safeSummary: "Provider returned malformed JSON" });
  });
});

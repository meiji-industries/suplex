import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SuplexDatabase } from "../src/platform/database.js";
import { DELIVERY_WAIT_NEXT, DeliveryOperations, type DeliveryGithubPort } from "../src/delivery/operations.js";
import { createGithubReleasePort, GithubReleaseFailure, type GithubCommandRunner } from "../src/integrations/github/delivery.js";
import { RootController } from "../src/coordination/root-controller.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { cleanupDeliveryFixtures, fixture, git, pending, rater, reviewer, successful } from "./helpers/workflow-delivery-fixture.js";

afterEach(cleanupDeliveryFixtures);
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Advances the bare remote's main with a real merge commit from a disposable clone, as an external actor would. */
async function advanceMain(f: Fixture, name: string): Promise<string> {
  const clone = join(f.directory, `clone-${name}`);
  await git(f.directory, ["clone", "--quiet", f.bare, clone]);
  await git(clone, ["config", "user.email", "o@example.com"]); await git(clone, ["config", "user.name", "O"]);
  await writeFile(join(clone, `${name}.txt`), `${name}\n`); await git(clone, ["add", "."]); await git(clone, ["commit", "-q", "-m", name]); await git(clone, ["push", "-q", "origin", "main"]);
  const head = await git(clone, ["rev-parse", "HEAD"]);
  f.github.baseSha = head;
  return head;
}

/** Moves main to an existing commit, as an external fast-forward actor would. */
async function advanceMainTo(f: Fixture, sha: string): Promise<void> {
  const clone = join(f.directory, `clone-to-${sha.slice(0, 8)}`);
  await git(f.directory, ["clone", "--quiet", f.bare, clone]);
  await git(clone, ["push", "-q", "origin", `${sha}:main`]);
  f.github.baseSha = sha;
}

/** Advances main while changing an existing reviewed file. */
async function advanceMainTouching(f: Fixture, name: string, file: string, content: string): Promise<string> {
  const clone = join(f.directory, `clone-${name}`);
  await git(f.directory, ["clone", "--quiet", f.bare, clone]);
  await git(clone, ["config", "user.email", "o@example.com"]); await git(clone, ["config", "user.name", "O"]);
  await writeFile(join(clone, file), content); await git(clone, ["add", file]); await git(clone, ["commit", "-q", "-m", name]); await git(clone, ["push", "-q", "origin", "main"]);
  const head = await git(clone, ["rev-parse", "HEAD"]);
  f.github.baseSha = head;
  return head;
}

async function rateNine(f: Fixture) { await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); const session = f.store.currentSession("task", "worker")!; await f.finishDelegate(rater(9)); return session; }

test("D1: a negative, invalid, or rejected latest review after an accepted push makes a later external merge external, never a workflow completion", { timeout: 90_000 }, async () => {
  for (const variant of ["negative", "invalid"] as const) {
    const f = await fixture("refine_pull_request");
    await rateNine(f);
    expect(await f.request("push_branch")).toMatchObject({ kind: expect.stringMatching(/^(pushed|adopted)$/) });
    expect(f.store.get("task").workflowState.acceptedDelivery?.headSha).toBe(f.featureSha);
    await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
    await f.finishDelegate(variant === "negative" ? rater(6, ["src.ts: still wrong"]) : "no json here");
    f.github.state = "merged";
    await f.delivery.observe("task");
    const task = f.store.get("task");
    expect(task.status).toBe("delivered");
    expect(task.workflowState.completion).toMatchObject({ kind: "external_merge", pullRequestNumber: 7 });
    expect(task.workflowState.reviews.map(record => record.result && record.result.role === "rater" ? record.result.rating : null)).toEqual([9, variant === "negative" ? 6 : null]);
    await f.delivery.observe("task");
    expect(f.store.get("task").workflowState.completion?.kind).toBe("external_merge");
  }
  const g = await fixture("independent_review");
  await g.controller.delegateAdvisor(g.identity(), { role: "reviewer", brief: "Plan." }); await g.finishDelegate(reviewer(true));
  expect(await g.request("push_branch")).toMatchObject({ kind: expect.stringMatching(/^(pushed|adopted)$/) });
  await g.controller.delegateAdvisor(g.identity(), { role: "reviewer", brief: "Plan." }); await g.finishDelegate(reviewer(false, ["src.ts: regression"]));
  g.github.state = "merged";
  await g.delivery.observe("task");
  expect(g.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "external_merge" } } });
});

test("D1: passive observation of an open pull request completes when the accepted content remains equivalent after an unrelated base advance", { timeout: 90_000 }, async () => {
  const f = await fixture("independent_review");
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan." }); await f.finishDelegate(reviewer(true));
  // Accept the range through a push; the draft PR is then observed rather than adopted explicitly.
  expect(await f.request("push_branch")).toMatchObject({ kind: expect.stringMatching(/^(pushed|adopted)$/) });
  const accepted = f.store.get("task").workflowState.acceptedDelivery!;
  expect(accepted.headSha).toBe(f.featureSha);
  await writeFile(join(f.worktree.path, "scratch.txt"), "dirty");
  await f.delivery.observe("task");
  expect(f.store.get("task").status).toBe("active");
  await rm(join(f.worktree.path, "scratch.txt"));
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["Checks run"], instruction: "pnpm test" });
  await f.delivery.observe("task");
  expect(f.store.get("task").status).toBe("active");
  await f.finishDelegate("pnpm test passed.");
  await advanceMain(f, "base-advance");
  await f.delivery.observe("task");
  expect(f.store.get("task")).toMatchObject({ status: "delivered", pullRequest: { number: 7, state: "open" }, workflowState: { completion: { kind: "workflow", reviewedHead: f.featureSha } } });
  expect(f.store.get("task").workflowState.reviews).toHaveLength(1);
  await f.delivery.observe("task");
  expect(f.store.get("task").workflowState.completion?.kind).toBe("workflow");
});

test("D1: a direct expected-head merge completes as workflow even when main advances with a merge commit, while a changed range after a queue is external", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = successful;
  await f.request("push_branch");
  f.github.onMerge = head => {
    // The provider merges with a real merge commit, so the base ref moves as part of the merge.
    void head;
    return "merge";
  };
  const original = f.port.mergePullRequest;
  f.port.mergePullRequest = async input => {
    const clone = join(f.directory, "merge-clone");
    await git(f.directory, ["clone", "--quiet", f.bare, clone]);
    await git(clone, ["config", "user.email", "m@example.com"]); await git(clone, ["config", "user.name", "M"]);
    await git(clone, ["merge", "--no-ff", "-q", "-m", "Merge feature", input.headSha]); await git(clone, ["push", "-q", "origin", "main"]);
    f.github.state = "merged";
    f.calls.push(`merge:${input.headSha}`);
    void original;
  };
  expect(await f.request("merge_pull_request")).toMatchObject({ state: "merged" });
  expect(await git(f.bare, ["rev-parse", "refs/heads/main"])).not.toBe(f.featureSha);
  expect(await git(f.bare, ["rev-list", "--count", "refs/heads/main"])).toBe("3");
  expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: f.featureSha, pullRequestNumber: 7 } } });

  const g = await fixture("refine_pull_request");
  await rateNine(g);
  g.github.isDraft = false; g.github.checks = successful;
  await g.request("push_branch");
  g.github.onMerge = () => "queue";
  expect(await g.request("merge_pull_request")).toMatchObject({ kind: "merge_requested", wait: { reason: "merge_queue" } });
  expect(g.store.get("task").status).toBe("active");
  await g.delivery.observe("task");
  expect(g.store.get("task").status).toBe("active");
  // Someone pushes another commit before the queue merges; the merged head is not the reviewed head.
  const other = join(g.directory, "queue-clone");
  await git(g.directory, ["clone", "--quiet", g.bare, other]); await git(other, ["checkout", "-q", "feature"]);
  await git(other, ["config", "user.email", "o@example.com"]); await git(other, ["config", "user.name", "O"]);
  await writeFile(join(other, "late.txt"), "late\n"); await git(other, ["add", "."]); await git(other, ["commit", "-q", "-m", "late"]); await git(other, ["push", "-q", "origin", "feature"]);
  g.github.headSha = await git(other, ["rev-parse", "HEAD"]);
  g.github.state = "merged";
  expect(await g.delivery.observeDeliveryWait("task")).toBe("finished");
  expect(g.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "external_merge" }, deliveryWait: null } });
  await g.delivery.observe("task");
  expect(g.store.get("task").workflowState.completion?.kind).toBe("external_merge");
});

test("D2: final merge uses Git equivalence rather than PR-base metadata and retains source and cancellation guards", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = successful;
  await f.request("push_branch");
  const observe = f.port.observePullRequest;
  let hook: (() => Promise<void>) | null = null;
  let baseOverride: string | null | undefined;
  f.port.observePullRequest = async input => { const observed = await observe(input); if (hook) { const run = hook; hook = null; await run(); } return baseOverride === undefined ? observed : { ...observed, baseSha: baseOverride }; };
  // An unrelated base advance during the final observation remains equivalent.
  hook = async () => { baseOverride = await advanceMain(f, "preflight-advance"); };
  expect(await f.request("merge_pull_request")).toMatchObject({ state: "merged" });
  expect(f.calls.filter(call => call.startsWith("merge"))).toHaveLength(1);

  const g = await fixture("refine_pull_request");
  await rateNine(g);
  g.github.isDraft = false; g.github.checks = successful;
  await g.request("push_branch");
  const observeG = g.port.observePullRequest;
  let nullBase = false; let dirty = false; let cancel = false;
  g.port.observePullRequest = async input => {
    const observed = await observeG(input);
    if (dirty) { dirty = false; await writeFile(join(g.worktree.path, "late-edit.txt"), "edited during await\n"); }
    if (cancel) { cancel = false; g.store.cancel("task"); }
    return nullBase ? { ...observed, baseSha: null } : observed;
  };
  // PR base metadata is an observation only; a null observation is harmless.
  nullBase = true;
  expect(await g.request("merge_pull_request")).toMatchObject({ state: "merged" });

  const h = await fixture("refine_pull_request");
  await rateNine(h);
  h.github.isDraft = false; h.github.checks = successful;
  await h.request("push_branch");
  const observeH = h.port.observePullRequest;
  h.port.observePullRequest = async input => {
    const observed = await observeH(input);
    if (dirty) { dirty = false; await writeFile(join(h.worktree.path, "late-edit.txt"), "edited during await\n"); }
    if (cancel) { cancel = false; h.store.cancel("task"); }
    return observed;
  };
  dirty = true;
  await expect(h.request("merge_pull_request")).rejects.toMatchObject({ code: "worktree_dirty" });
  await rm(join(h.worktree.path, "late-edit.txt"));
  cancel = true;
  await expect(h.request("merge_pull_request")).rejects.toThrow();
  expect(h.calls.filter(call => call.startsWith("merge"))).toEqual([]);
  expect(h.store.get("task").status).toBe("cancelled");
});

test("D2: a base advance that changes reviewed source content requires a fresh review", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = successful;
  await f.request("push_branch");
  const reviewed = await f.inspect();
  await advanceMainTouching(f, "source-advance", "src.ts", "export const value = 0; // base changed\n");
  await expect(f.controller.requestDelivery(f.identity(), "merge_pull_request", reviewed.headSha, reviewed.review)).rejects.toMatchObject({ code: "delivery_review_required", message: expect.stringContaining("src.ts") });
  expect(f.calls.filter(call => call.startsWith("merge"))).toEqual([]);
  await rateNine(f);
  expect(await f.request("merge_pull_request")).toMatchObject({ state: "merged" });
});

test("D5: unrelated base advance before the Coordinator re-inspects merges without a new review, push, or Worker, for stale and null PR base metadata", { timeout: 90_000 }, async () => {
  for (const variant of ["stale", "null"] as const) {
    const f = await fixture("refine_pull_request");
    const raterSession = await rateNine(f);
    f.github.isDraft = false; f.github.checks = successful;
    await f.request("push_branch");
    const oldBase = f.github.baseSha;
    const newBase = await advanceMain(f, `unrelated-${variant}`);
    if (variant === "stale") f.github.baseSha = oldBase;
    else {
      const observe = f.port.observePullRequest;
      f.port.observePullRequest = async input => ({ ...(await observe(input)), baseSha: null });
    }
    expect(await f.request("merge_pull_request")).toMatchObject({ state: "merged" });
    expect(f.calls.filter(call => call.startsWith("merge:"))).toHaveLength(1);
    expect(f.calls.filter(call => call.startsWith("push:"))).toHaveLength(0);
    expect(f.store.get("task").workflowState.reviews).toHaveLength(1);
    expect(f.store.sessions("task").filter(session => session.kind === "worker")).toHaveLength(1);
    expect(f.store.currentSession("task", "worker")!.id).toBe(raterSession.id);
    expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow" }, acceptedDelivery: { baseSha: newBase, patchDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
  }
});

test("D5: a merge-base move with identical file names requires a fresh review and names commits or patch content", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await f.commit("src.ts", "export const value = 3;\n");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = successful;
  await f.request("push_branch");
  const reviewed = await f.inspect();
  await advanceMainTo(f, f.featureSha);
  await expect(f.controller.requestDelivery(f.identity(), "merge_pull_request", reviewed.headSha, reviewed.review)).rejects.toMatchObject({ code: "delivery_review_required", message: expect.stringMatching(/commits|patch content/) });
  expect(f.calls.filter(call => call.startsWith("merge:"))).toEqual([]);
  await rateNine(f);
  expect(await f.request("merge_pull_request")).toMatchObject({ state: "merged" });
});

test("D5: passive draft completion after an unrelated base advance is the same for current, stale, and null PR base metadata; a merge-base move stays active", { timeout: 90_000 }, async () => {
  for (const variant of ["current", "stale", "null"] as const) {
    const f = await fixture("independent_review");
    await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan." });
    await f.finishDelegate(reviewer(true));
    await f.request("push_branch");
    const oldBase = f.github.baseSha;
    await advanceMain(f, `passive-${variant}`);
    if (variant === "stale") f.github.baseSha = oldBase;
    if (variant === "null") {
      const observe = f.port.observePullRequest;
      const get = f.port.getPullRequest;
      const list = f.port.listPullRequests;
      f.port.observePullRequest = async input => ({ ...(await observe(input)), baseSha: null });
      f.port.getPullRequest = async input => ({ ...(await get(input))!, baseSha: "0".repeat(40) });
      f.port.listPullRequests = async input => (await list(input)).map(pull => ({ ...pull, baseSha: "0".repeat(40) }));
    }
    await f.delivery.observe("task");
    expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: f.featureSha } } });
    expect(f.store.get("task").workflowState.reviews).toHaveLength(1);
    expect(f.calls.filter(call => /^(push|merge|ready|create)/.test(call))).toHaveLength(0);
  }
  const g = await fixture("independent_review");
  await g.commit("src.ts", "export const value = 3;\n");
  await g.controller.delegateAdvisor(g.identity(), { role: "reviewer", brief: "Plan." });
  await g.finishDelegate(reviewer(true));
  await g.request("push_branch");
  await advanceMainTo(g, g.featureSha);
  await g.delivery.observe("task");
  expect(g.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null } });
  await g.controller.delegateAdvisor(g.identity(), { role: "reviewer", brief: "Plan." });
  await g.finishDelegate(reviewer(true));
  expect(await g.request("create_or_adopt_pull_request")).toMatchObject({ number: 7 });
});

test("D5: an Advisor report survives an unrelated base advance during its turn", { timeout: 90_000 }, async () => {
  const f = await fixture("independent_review");
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan." });
  await advanceMain(f, "advisor-advance");
  await f.finishDelegate(reviewer(true));
  const review = f.store.get("task").workflowState.reviews.at(-1)!;
  expect(review).toMatchObject({ result: { approved: true }, invalidReason: null });
});

test("D5: a confirmed merge at the accepted head completes as workflow despite stale base metadata; another merged head is external", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f); await f.request("push_branch");
  f.github.state = "merged"; f.github.baseSha = "0".repeat(40);
  await f.delivery.observe("task");
  expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: f.featureSha } } });
  const g = await fixture("refine_pull_request");
  await rateNine(g); await g.request("push_branch");
  g.github.state = "merged"; g.github.baseSha = "0".repeat(40); g.github.headSha = "a".repeat(40);
  await g.delivery.observe("task");
  expect(g.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "external_merge" } } });
});

test("D5: an unavailable base observation persists an observation wait and resumes delivery when available", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = successful;
  await f.request("push_branch");
  const reviewed = await f.inspect();
  const head = f.port.getBranchHead;
  let attempts = 0;
  f.port.getBranchHead = async input => {
    if (input.branch !== "main") return head(input);
    attempts += 1;
    if (attempts === 1) return null;
    if (attempts === 2) throw new GithubReleaseFailure("provider-unavailable", "offline");
    return head(input);
  };
  await expect(f.controller.requestDelivery(f.identity(), "merge_pull_request", reviewed.headSha, reviewed.review)).resolves.toMatchObject({ kind: "waiting", wait: { reason: "observation" } });
  await expect(f.controller.requestDelivery(f.identity(), "merge_pull_request", reviewed.headSha, reviewed.review)).resolves.toMatchObject({ kind: "waiting", wait: { reason: "observation" } });
  expect(f.calls.filter(call => call.startsWith("merge:"))).toEqual([]);
  expect(f.store.get("task").workflowState.deliveryWait?.reason).toBe("observation");
  const before = f.rootTurns().length;
  expect(await f.delivery.observeDeliveryWait("task")).toBe("changed");
  expect(f.rootTurns()).toHaveLength(before + 1);
  expect(f.store.get("task").workflowState.deliveryWait).toBeNull();
  await f.drainRoot();
  expect(await f.request("merge_pull_request")).toMatchObject({ state: "merged" });
});

test("D5: a reopened store with stale observations merges and completes without human repair", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = successful;
  await f.request("push_branch");
  const oldBase = f.github.baseSha;
  await advanceMain(f, "reopened-advance");
  f.github.baseSha = oldBase;
  const reopened = new SuplexDatabase(join(f.directory, "suplex.sqlite"), { migrate: false });
  try {
    const store = new TaskControlStore(reopened, f.alive);
    const controller = new RootController(store, f.harness, new DeliveryOperations(store, f.port), undefined, { root: join(f.directory, "evidence") }, f.reader);
    const inspected = await controller.requestDelivery(f.identity(), "inspect_delivery_diff") as { baseSha: string; headSha: string; files: string[]; commits: string[]; patchDigest: string };
    const review = { baseSha: inspected.baseSha, headSha: inspected.headSha, files: inspected.files, commits: inspected.commits, patchDigest: inspected.patchDigest };
    expect(await controller.requestDelivery(f.identity(), "merge_pull_request", inspected.headSha, review)).toMatchObject({ state: "merged" });
    expect(store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow" } } });
  } finally { reopened.close(); }
});

test("D3: the real adapter classifies 401, missing login, permission 403, rate limits, and timeouts, and a persisted wait turns access failures into one question", { timeout: 60_000 }, async () => {
  const restError = (status: number, message: string) => JSON.stringify({ message, documentation_url: "https://docs.github.com/rest", status: String(status) });
  const scripted = (failures: Record<string, { stdout?: string; stderr?: string; timedOut?: boolean }>) => {
    const commands: string[] = [];
    const runner: GithubCommandRunner = async ({ args }) => {
      const key = `gh ${args.slice(0, 2).join(" ")}`;
      commands.push(key);
      const failure = Object.entries(failures).find(([prefix]) => key.startsWith(prefix))?.[1];
      if (failure) throw Object.assign(new Error("gh failed"), { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", killed: failure.timedOut ?? false });
      if (key.startsWith("gh api rate_limit")) return { stdout: JSON.stringify({ resources: { core: { reset: Math.floor(Date.now() / 1000) + 60 } } }), stderr: "" };
      return { stdout: "[]", stderr: "" };
    };
    return { runner, commands };
  };
  const classify = async (failure: { stdout?: string; stderr?: string; timedOut?: boolean }) => {
    const { runner } = scripted({ "gh pr view": failure, "gh api repos": failure });
    const port = createGithubReleasePort({ runner });
    const observed = await port.observePullRequest({ repository: "owner/repo", branch: "feature", pullRequestNumber: 7 }).then(() => null, error => error as GithubReleaseFailure);
    const fetched = await port.getPullRequest({ repository: "owner/repo", number: 7 }).then(() => null, error => error as GithubReleaseFailure);
    return { observe: observed && { code: observed.code, message: observed.message }, get: fetched && { code: fetched.code, message: fetched.message } };
  };
  expect(await classify({ stdout: restError(401, "Bad credentials") })).toMatchObject({ observe: { code: "authentication-required" }, get: { code: "authentication-required" } });
  expect(await classify({ stderr: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable" })).toMatchObject({ observe: { code: "authentication-required" }, get: { code: "authentication-required" } });
  expect(await classify({ stdout: restError(403, "Resource not accessible by integration") })).toMatchObject({ observe: { code: "authentication-required", message: expect.stringMatching(/permission|access/i) }, get: { code: "authentication-required" } });
  expect(await classify({ stdout: restError(403, "API rate limit exceeded for user ID 1.") })).toMatchObject({ observe: { code: "provider-rate-limited" }, get: { code: "provider-rate-limited" } });
  expect(await classify({ stderr: "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again." })).toMatchObject({ observe: { code: "provider-rate-limited" } });
  expect(await classify({ stdout: restError(429, "Too many requests") })).toMatchObject({ observe: { code: "provider-rate-limited" }, get: { code: "provider-rate-limited" } });
  expect(await classify({ stderr: "connect: network is unreachable", timedOut: true })).toMatchObject({ observe: { code: "provider-unavailable" }, get: { code: "provider-unavailable" } });
  expect((await classify({ stdout: restError(401, "Bad credentials ghp_secret_token_value") })).observe?.message).not.toContain("ghp_secret_token_value");

  for (const failure of [{ stdout: restError(401, "Bad credentials") }, { stdout: restError(403, "Resource not accessible by personal access token") }]) {
    const f = await fixture("refine_pull_request");
    await rateNine(f);
    f.github.isDraft = false; f.github.checks = pending;
    await f.request("push_branch");
    expect(await f.request("observe_checks")).toMatchObject({ wait: { reason: "checks" }, next: DELIVERY_WAIT_NEXT });
    f.github.onMerge = () => "queue";
    expect(await f.request("merge_pull_request")).toMatchObject({ wait: { reason: "merge_queue" } });
    const { runner, commands } = scripted({ "gh pr view": failure });
    const real = createGithubReleasePort({ runner });
    const port: DeliveryGithubPort = { ...f.port, observePullRequest: real.observePullRequest.bind(real) };
    const delivery = new DeliveryOperations(f.store, port);
    const turnsBefore = f.rootTurns().length; const callsBefore = f.calls.length;
    expect(await delivery.observeDeliveryWait("task")).toBe("changed");
    const task = f.store.get("task");
    expect(task).toMatchObject({ status: "waiting_human", humanQuestion: expect.stringMatching(/GitHub could not access this pull request\. Restore the GitHub CLI login or repository permission, then continue\./), workflowState: { deliveryWait: null } });
    expect(f.rootTurns()).toHaveLength(turnsBefore);
    expect(commands.filter(command => /push|merge|ready/.test(command))).toEqual([]);
    expect(f.calls.slice(callsBefore).filter(call => /^(push|merge)|ready/.test(call))).toEqual([]);
    f.store.answerHuman("task", task.humanQuestionId!, "Logged in again.");
    expect(f.store.get("task").status).toBe("active");
  }
  // A transient outage retains the wait and adds no turn.
  const t = await fixture("refine_pull_request");
  await rateNine(t);
  t.github.isDraft = false; t.github.checks = pending;
  await t.request("push_branch");
  t.github.onMerge = () => "queue";
  await t.request("merge_pull_request");
  const { runner } = scripted({ "gh pr view": { stderr: "connect: network is unreachable", timedOut: true } });
  const real = createGithubReleasePort({ runner });
  const before = t.rootTurns().length; const wait = t.store.get("task").workflowState.deliveryWait;
  await expect(new DeliveryOperations(t.store, { ...t.port, observePullRequest: real.observePullRequest.bind(real) }).observeDeliveryWait("task")).rejects.toMatchObject({ code: "provider-unavailable" });
  expect(t.store.get("task")).toMatchObject({ status: "active", workflowState: { deliveryWait: wait } });
  expect(t.rootTurns()).toHaveLength(before);
});

test("D4: two observers of one persisted wait produce one continuation, and cancellation or a replacement wait defeats a stale response", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = pending; f.github.mergeStateStatus = "UNKNOWN";
  await f.request("push_branch");
  f.github.onMerge = () => "queue";
  await f.request("merge_pull_request");
  await f.drainRoot();
  const original = f.store.get("task").workflowState.deliveryWait!;
  const barrier = () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let arrived = 0; let opened!: () => void; const both = new Promise<void>(resolve => { opened = resolve; }); return { gate, release, arrive: () => { arrived += 1; if (arrived === 2) opened(); }, both }; };
  const race = async (database: SuplexDatabase, mutate: (() => void) | null) => {
    const b = barrier();
    const gatedPort = (): DeliveryGithubPort => ({ ...f.port, observePullRequest: async input => { b.arrive(); await b.gate; return f.port.observePullRequest(input); } });
    const one = new DeliveryOperations(new TaskControlStore(database, f.alive), gatedPort());
    const two = new DeliveryOperations(new TaskControlStore(database, f.alive), gatedPort());
    const results = Promise.all([one.observeDeliveryWait("task"), two.observeDeliveryWait("task")]);
    await b.both;
    mutate?.();
    b.release();
    return results;
  };
  f.github.checks = successful; f.github.mergeStateStatus = "CLEAN";
  let turnsBefore = f.rootTurns().length;
  const results = await race(f.database, null);
  expect([...results].sort()).toEqual(["changed", "none"]);
  expect(f.rootTurns()).toHaveLength(turnsBefore + 1);
  expect(f.store.get("task").workflowState.deliveryWait).toBeNull();
  // Reopened store: install a new wait, race again, still one continuation.
  await f.drainRoot();
  f.github.checks = pending; f.github.mergeStateStatus = "UNKNOWN";
  await f.request("merge_pull_request");
  await f.drainRoot();
  const reopened = new SuplexDatabase(join(f.directory, "suplex.sqlite"), { migrate: false });
  try {
    f.github.checks = successful; f.github.mergeStateStatus = "CLEAN";
    turnsBefore = f.rootTurns().length;
    const again = await race(reopened, null);
    expect([...again].sort()).toEqual(["changed", "none"]);
    expect(f.rootTurns()).toHaveLength(turnsBefore + 1);
  } finally { reopened.close(); }
  // Unchanged polls add nothing and keep the 30-second schedule.
  await f.drainRoot();
  f.github.checks = pending; f.github.mergeStateStatus = "UNKNOWN";
  await f.request("merge_pull_request");
  await f.drainRoot();
  const stable = f.rootTurns().length;
  expect(await f.delivery.observeDeliveryWait("task")).toBe("unchanged");
  expect(f.rootTurns()).toHaveLength(stable);
  expect(Date.parse(f.store.get("task").wakeAt!) - Date.now()).toBeGreaterThan(20_000);
  // A replacement wait installed during the old response is preserved.
  const current = f.store.get("task").workflowState.deliveryWait!;
  f.github.checks = successful; f.github.mergeStateStatus = "CLEAN";
  const replaced = { ...current, since: new Date(Date.now() + 1000).toISOString(), fingerprint: "replacement-fingerprint" };
  const replacement = await race(f.database, () => f.store.updateWorkflowState("task", state => ({ ...state, deliveryWait: replaced })));
  expect(replacement).toEqual(["none", "none"]);
  expect(f.store.get("task").workflowState.deliveryWait).toEqual(replaced);
  expect(f.rootTurns()).toHaveLength(stable);
  // Cancellation during the old response never wakes the task.
  const cancelled = await race(f.database, () => f.store.cancel("task"));
  expect(cancelled).toEqual(["none", "none"]);
  expect(f.store.get("task").status).toBe("cancelled");
  expect(original.reason).toBe("merge_queue");
  expect(f.store.turns("task").filter(turn => turn.status === "pending_prompt")).toEqual([]);
});

// Final delivery guards (docs/plans/workflows-final-delivery-guards.md): every completion and publication revalidates after its last await.
type Port = Fixture["port"];
/** Runs `during` once, inside the awaited remote observation of `branch`, after the provider answered and before Suplex uses the answer. */
function duringBranchHead(f: Fixture, branch: string, during: () => Promise<void> | void): { fired: () => boolean; restore: () => void } {
  const original = f.port.getBranchHead;
  let fired = false;
  f.port.getBranchHead = async input => { const result = await original(input); if (input.branch === branch && !fired) { fired = true; await during(); } return result; };
  return { fired: () => fired, restore: () => { f.port.getBranchHead = original; } };
}
/** Runs `during` once after the next local revision observation returns, before the caller can act on it. */
function afterNextLocalInspection(f: Fixture, during: () => Promise<void> | void): { fired: () => boolean } {
  const original: Port["inspectLocalRevision"] = f.port.inspectLocalRevision;
  let fired = false;
  f.port.inspectLocalRevision = async input => { const result = await original(input); if (!fired) { fired = true; await during(); } return result; };
  return { fired: () => fired };
}
const dirtySource = (f: Fixture) => writeFile(join(f.worktree.path, "src.ts"), "export const value = 3; // edited during an await\n");
const restoreSource = (f: Fixture) => git(f.worktree.path, ["checkout", "--", "src.ts"]);
const porcelain = (f: Fixture) => git(f.worktree.path, ["status", "--porcelain"]);
const mutations = (f: Fixture) => f.calls.filter(call => /^(push|merge):|^(ready|create)$/.test(call));
async function approveAndAccept(f: Fixture): Promise<void> {
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan and criteria." }); await f.finishDelegate(reviewer(true));
  expect(await f.request("push_branch")).toMatchObject({ kind: expect.stringMatching(/^(pushed|adopted)$/) });
  expect(f.store.get("task").workflowState.acceptedDelivery?.headSha).toBe(f.featureSha);
}

test("F1a/F1b: a rejecting, invalid, or newly active Reviewer during the passive base observation blocks open completion and keeps every report", { timeout: 90_000 }, async () => {
  for (const variant of ["rejected", "invalid", "active"] as const) {
    const f = await fixture("independent_review");
    await approveAndAccept(f);
    const hook = duringBranchHead(f, "main", async () => {
      await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan again." });
      if (variant !== "active") await f.finishDelegate(variant === "rejected" ? reviewer(false, ["src.ts: regression"]) : "no json here");
    });
    await f.delivery.observe("task");
    expect(hook.fired()).toBe(true);
    const task = f.store.get("task");
    expect(task).toMatchObject({ status: "active", pullRequest: { number: 7, state: "open" }, workflowState: { completion: null } });
    expect(task.workflowState.reviews.map(record => record.result && record.result.role === "reviewer" ? record.result.approved : null)).toEqual(variant === "rejected" ? [true, false] : variant === "invalid" ? [true, null] : [true]);
    if (variant === "active") {
      expect(f.store.currentSession("task", "worker")).toMatchObject({ advisorRole: "reviewer", lifecycle: expect.stringMatching(/^(reserved|live)$/) });
      await f.finishDelegate(reviewer(true));
    }
    expect(mutations(f)).toEqual([]);
  }
});

test("F1c/F1f: a tracked file dirtied during the last base observation blocks draft and ready completion, and a clean retry with a current review completes once", { timeout: 90_000 }, async () => {
  for (const target of ["pull_request_draft", "pull_request_ready"] as const) {
    const f = await fixture("independent_review", { deliveryTarget: target });
    if (target === "pull_request_ready") f.github.isDraft = false;
    await approveAndAccept(f);
    const hook = duringBranchHead(f, "main", () => dirtySource(f));
    await f.delivery.observe("task");
    expect(hook.fired()).toBe(true);
    expect(f.store.get("task")).toMatchObject({ status: "active", pullRequest: { number: 7, state: "open" }, workflowState: { completion: null } });
    expect(await porcelain(f)).toBe("M src.ts");
    hook.restore();
    await restoreSource(f);
    await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan and criteria." }); await f.finishDelegate(reviewer(true));
    await f.delivery.observe("task");
    const completed = f.store.get("task");
    expect(completed).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: f.featureSha, pullRequestNumber: 7 } } });
    await f.delivery.observe("task");
    expect(f.store.get("task").workflowState.completion).toEqual(completed.workflowState.completion);
    expect(f.store.get("task").status).toBe("delivered");
    expect(mutations(f)).toEqual([]);
  }
});

test("F1d/F1e/F1f: local completion revalidates the source after its base observation, refuses cancellation, and completes once when clean and reviewed", { timeout: 90_000 }, async () => {
  const f = await fixture("independent_review", { deliveryTarget: "local_worktree" });
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan." }); await f.finishDelegate(reviewer(true));
  let hook = duringBranchHead(f, "main", () => dirtySource(f));
  await expect(f.controller.requestDelivery(f.identity(), "complete_local_work", f.featureSha)).rejects.toMatchObject({ code: "worktree_dirty" });
  expect(hook.fired()).toBe(true);
  expect(f.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null, acceptedDelivery: null } });
  expect(await porcelain(f)).toBe("M src.ts");
  hook.restore();
  await restoreSource(f);
  // F1e: the head changes during the await.
  hook = duringBranchHead(f, "main", async () => { await f.commit("late.ts"); });
  await expect(f.controller.requestDelivery(f.identity(), "complete_local_work", f.featureSha)).rejects.toMatchObject({ code: "head_diverged" });
  expect(f.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null } });
  hook.restore();
  const late = await git(f.worktree.path, ["rev-parse", "HEAD"]);
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan." }); await f.finishDelegate(reviewer(true));
  // F1e: the branch changes during the await.
  hook = duringBranchHead(f, "main", async () => { await git(f.worktree.path, ["checkout", "-q", "-b", "elsewhere"]); });
  await expect(f.controller.requestDelivery(f.identity(), "complete_local_work", late)).rejects.toMatchObject({ code: "head_diverged" });
  expect(f.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null } });
  hook.restore();
  await git(f.worktree.path, ["checkout", "-q", "feature"]); await git(f.worktree.path, ["branch", "-q", "-D", "elsewhere"]);
  // F1f: clean, on the branch, with a current approval for this head.
  expect(await f.controller.requestDelivery(f.identity(), "complete_local_work", late)).toMatchObject({ kind: "local_work_completed", headSha: late });
  const completed = f.store.get("task");
  expect(completed).toMatchObject({ status: "delivered", worktree: { headSha: late, dirty: false }, workflowState: { completion: { kind: "workflow", reviewedHead: late, pullRequestNumber: null } } });
  await f.delivery.observe("task");
  expect(f.store.get("task").workflowState.completion).toEqual(completed.workflowState.completion);

  // F1e: cancellation during the await writes no success record.
  const g = await fixture("independent_review", { deliveryTarget: "local_worktree" });
  await g.controller.delegateAdvisor(g.identity(), { role: "reviewer", brief: "Plan." }); await g.finishDelegate(reviewer(true));
  const cancel = duringBranchHead(g, "main", () => { g.store.cancel("task"); });
  await expect(g.controller.requestDelivery(g.identity(), "complete_local_work", g.featureSha)).rejects.toThrow();
  expect(cancel.fired()).toBe(true);
  expect(g.store.get("task")).toMatchObject({ status: "cancelled", workflowState: { completion: null } });
  expect(mutations(g)).toEqual([]);
});

test("F1g: a delegate reserved or a review replaced from a second connection after the final local inspection is seen by the completion transaction", { timeout: 90_000 }, async () => {
  const f = await fixture("independent_review");
  await approveAndAccept(f);
  const second = new SuplexDatabase(join(f.directory, "suplex.sqlite"), { migrate: false });
  try {
    const store = new TaskControlStore(second, f.alive);
    const root = f.identity();
    const reserve = afterNextLocalInspection(f, () => { store.launchWorker({ taskId: "task", rootSessionId: root.sessionId, rootGeneration: root.generation, instruction: "Run pnpm test" }); });
    await f.delivery.observe("task");
    expect(reserve.fired()).toBe(true);
    expect(f.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null } });
    expect(f.store.currentSession("task", "worker")).toMatchObject({ advisorRole: null, lifecycle: "reserved" });
  } finally { second.close(); }

  const g = await fixture("independent_review");
  await approveAndAccept(g);
  const other = new SuplexDatabase(join(g.directory, "suplex.sqlite"), { migrate: false });
  try {
    const store = new TaskControlStore(other, g.alive);
    const controller = new RootController(store, g.harness, new DeliveryOperations(store, g.port), undefined, { root: join(g.directory, "evidence") }, g.reader);
    const replace = afterNextLocalInspection(g, async () => {
      await controller.delegateAdvisor(g.identity(), { role: "reviewer", brief: "Plan again." });
      g.endRootTurn();
      await controller.recover("task");
      const message = g.harness.dispatched.at(-1)!.messageID;
      g.harness.finish(message, "completed", reviewer(false, ["src.ts: regression"]));
      await controller.recover("task");
    });
    await g.delivery.observe("task");
    expect(replace.fired()).toBe(true);
    const task = g.store.get("task");
    expect(task).toMatchObject({ status: "active", workflowState: { completion: null } });
    expect(task.workflowState.reviews.map(record => record.result && record.result.role === "reviewer" ? record.result.approved : null)).toEqual([true, false]);
    expect(mutations(g)).toEqual([]);
  } finally { other.close(); }
});

test("F2a/F2b/F2c/F2e: push revalidates source, branch, delegate, and review after the remote head observation and before the mutation", { timeout: 120_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await f.commit("repaired.ts");
  await rateNine(f);
  const pushes = () => f.calls.filter(call => call.startsWith("push"));
  // F2a: dirty tracked source during the remote head observation.
  let hook = duringBranchHead(f, "feature", () => dirtySource(f));
  await expect(f.request("push_branch")).rejects.toMatchObject({ code: "worktree_dirty" });
  expect(hook.fired()).toBe(true);
  expect(pushes()).toEqual([]);
  expect(await git(f.bare, ["rev-parse", "refs/heads/feature"])).toBe(f.featureSha);
  expect(await porcelain(f)).toBe("M src.ts");
  hook.restore(); await restoreSource(f);
  // F2b: a new commit during the observation.
  hook = duringBranchHead(f, "feature", async () => { await f.commit("late.ts"); });
  await expect(f.request("push_branch")).rejects.toMatchObject({ code: "head_diverged" });
  expect(pushes()).toEqual([]);
  hook.restore();
  await rateNine(f);
  // F2b: another branch checked out during the observation.
  hook = duringBranchHead(f, "feature", async () => { await git(f.worktree.path, ["checkout", "-q", "-b", "elsewhere"]); });
  await expect(f.request("push_branch")).rejects.toMatchObject({ code: "head_diverged" });
  expect(pushes()).toEqual([]);
  hook.restore();
  await git(f.worktree.path, ["checkout", "-q", "feature"]); await git(f.worktree.path, ["branch", "-q", "-D", "elsewhere"]);
  // F2c: a delegate admitted during the observation.
  hook = duringBranchHead(f, "feature", async () => { await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["Checks run"], instruction: "pnpm test" }); });
  await expect(f.request("push_branch")).rejects.toMatchObject({ code: "delegate_active" });
  expect(pushes()).toEqual([]);
  hook.restore();
  await f.finishDelegate("pnpm test passed.");
  // F2c: a rejecting Rater completed during the observation.
  hook = duringBranchHead(f, "feature", async () => { await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); await f.finishDelegate(rater(6, ["src.ts: still wrong"])); });
  await expect(f.request("push_branch")).resolves.toMatchObject({ kind: "pushed" });
  expect(hook.fired()).toBe(true);
  expect(f.store.get("task").status).toBe("active");
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required" });
  hook.restore();
  // F2e: no race, committed clean candidate, current 9.
  await rateNine(f);
  const head = await git(f.worktree.path, ["rev-parse", "HEAD"]);
  expect(await f.request("push_branch")).toMatchObject({ kind: "adopted", headSha: head });
  expect(pushes()).toEqual([`push:${head}`]);
  expect(await git(f.bare, ["rev-parse", "refs/heads/feature"])).toBe(head);
  expect(f.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null, acceptedDelivery: { headSha: head } } });
});

test("F2d/F2e: adoption of an already published head is guarded the same way, and the remote-branch target completes only through the final boundary", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  let hook = duringBranchHead(f, "feature", () => dirtySource(f));
  await expect(f.request("push_branch")).rejects.toMatchObject({ code: "worktree_dirty" });
  expect(hook.fired()).toBe(true);
  expect(mutations(f)).toEqual([]);
  expect(f.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null } });
  hook.restore(); await restoreSource(f);
  expect(await f.request("push_branch")).toMatchObject({ kind: "adopted", headSha: f.featureSha });
  expect(f.store.get("task").status).toBe("active");

  const r = await fixture("independent_review", { deliveryTarget: "remote_branch" });
  await r.controller.delegateAdvisor(r.identity(), { role: "reviewer", brief: "Plan." }); await r.finishDelegate(reviewer(true));
  hook = duringBranchHead(r, "feature", () => dirtySource(r));
  await expect(r.request("push_branch")).rejects.toMatchObject({ code: "worktree_dirty" });
  expect(hook.fired()).toBe(true);
  expect(r.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null } });
  hook.restore(); await restoreSource(r);
  hook = duringBranchHead(r, "feature", async () => { await r.controller.delegateAdvisor(r.identity(), { role: "reviewer", brief: "Plan." }); await r.finishDelegate(reviewer(false, ["src.ts: regression"])); });
  await expect(r.request("push_branch")).resolves.toMatchObject({ kind: "adopted" });
  expect(hook.fired()).toBe(true);
  expect(r.store.get("task")).toMatchObject({ status: "active", workflowState: { completion: null } });
  hook.restore();
  expect(mutations(r)).toEqual([]);
  await r.controller.delegateAdvisor(r.identity(), { role: "reviewer", brief: "Plan." }); await r.finishDelegate(reviewer(true));
  expect(await r.request("push_branch")).toMatchObject({ kind: "adopted", headSha: r.featureSha });
  expect(r.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: r.featureSha, pullRequestNumber: null } } });

  const p = await fixture("independent_review", { deliveryTarget: "remote_branch" });
  const head = await p.commit("extra.ts");
  await p.controller.delegateAdvisor(p.identity(), { role: "reviewer", brief: "Plan." }); await p.finishDelegate(reviewer(true));
  expect(await p.request("push_branch")).toMatchObject({ kind: "pushed", headSha: head });
  expect(await git(p.bare, ["rev-parse", "refs/heads/feature"])).toBe(head);
  expect(p.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: head, pullRequestNumber: null } } });
});

test("F3a/F3b: a merge result on another head is external, another identity is refused, and base-only retargeting is accepted", { timeout: 120_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = successful;
  await f.request("push_branch");
  const other = "a".repeat(40);
  const original = f.port.mergePullRequest;
  f.port.mergePullRequest = async input => { await original(input); f.github.headSha = other; };
  expect(await f.request("merge_pull_request")).toMatchObject({ state: "merged", headSha: other, reviewedHead: f.featureSha });
  const task = f.store.get("task");
  expect(task).toMatchObject({ status: "delivered", pullRequest: { number: 7, state: "merged", headSha: other }, workflowState: { completion: { kind: "external_merge", reviewedHead: f.featureSha, pullRequestNumber: 7 } } });
  expect(task.workflowState.reviews.map(record => record.range.headSha)).toEqual([f.featureSha]);
  expect(f.calls.filter(call => call.startsWith("merge"))).toEqual([`merge:${f.featureSha}`]);

  for (const variant of ["repository", "number", "cross"] as const) {
    const g = await fixture("refine_pull_request");
    await rateNine(g);
    g.github.isDraft = false; g.github.checks = successful;
    await g.request("push_branch");
    const merge = g.port.mergePullRequest; const get = g.port.getPullRequest;
    g.port.mergePullRequest = async input => {
      await merge(input);
      if (variant === "repository") g.github.repository = "someone/else";
      if (variant === "cross") g.github.crossRepository = true;
      if (variant === "number") g.port.getPullRequest = async input => ({ ...await get(input), number: 8, url: "https://github.com/owner/repo/pull/8" });
    };
    await expect(g.request("merge_pull_request")).rejects.toMatchObject({ code: "pull_request_ambiguous" });
    const state = g.store.get("task");
    expect(state).toMatchObject({ status: "active", pullRequest: { number: 7, repository: "owner/repo", state: "open" }, workflowState: { completion: null } });
    expect(g.calls.filter(call => call.startsWith("merge"))).toEqual([`merge:${g.featureSha}`]);
  }

  const retargeted = await fixture("refine_pull_request");
  await rateNine(retargeted);
  retargeted.github.isDraft = false; retargeted.github.checks = successful;
  await retargeted.request("push_branch");
  const merge = retargeted.port.mergePullRequest;
  retargeted.port.mergePullRequest = async input => { await merge(input); retargeted.github.baseBranch = "release"; };
  await expect(retargeted.request("merge_pull_request")).resolves.toMatchObject({ state: "merged", number: 7 });
  expect(retargeted.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: retargeted.featureSha } } });
});

test("F3c/F3d: a matching squash-style merge completes the reviewed head, and cancellation during the merge request records a mismatched head as external", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await rateNine(f);
  f.github.isDraft = false; f.github.checks = successful;
  await f.request("push_branch");
  f.port.mergePullRequest = async input => {
    const clone = join(f.directory, "squash-clone");
    await git(f.directory, ["clone", "--quiet", f.bare, clone]);
    await git(clone, ["config", "user.email", "m@example.com"]); await git(clone, ["config", "user.name", "M"]);
    await git(clone, ["merge", "--squash", "-q", input.headSha]); await git(clone, ["commit", "-q", "-m", "Squash feature"]); await git(clone, ["push", "-q", "origin", "main"]);
    f.github.state = "merged";
    f.calls.push(`merge:${input.headSha}`);
  };
  expect(await f.request("merge_pull_request")).toMatchObject({ state: "merged", headSha: f.featureSha });
  expect(await git(f.bare, ["rev-parse", "refs/heads/main"])).not.toBe(f.featureSha);
  expect(await git(f.bare, ["rev-list", "--count", "refs/heads/main"])).toBe("2");
  expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: f.featureSha, pullRequestNumber: 7 } } });

  const g = await fixture("refine_pull_request");
  await rateNine(g);
  g.github.isDraft = false; g.github.checks = successful;
  await git(g.worktree.path, ["push", "-q", "origin", "feature"]);
  const late = "b".repeat(40);
  g.github.onMerge = () => { g.store.cancel("task"); return "merge"; };
  const merge = g.port.mergePullRequest;
  g.port.mergePullRequest = async input => { await merge(input); g.github.headSha = late; };
  await g.request("merge_pull_request").catch(() => undefined);
  expect(g.store.get("task")).toMatchObject({ status: "cancelled", pullRequest: { state: "merged", headSha: late }, workflowState: { completion: { kind: "external_merge", reviewedHead: g.featureSha, pullRequestNumber: 7 } } });
  expect(mutations(g)).toEqual([`merge:${g.featureSha}`]);
});

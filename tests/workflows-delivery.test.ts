import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ForgeDatabase } from "../src/platform/database.js";
import { DELIVERY_WAIT_NEXT, DeliveryOperations } from "../src/delivery/operations.js";
import { inspectDeliveryDiff } from "../src/delivery/review.js";
import { RootBridge } from "../src/coordination/root-bridge.js";
import { RootController } from "../src/coordination/root-controller.js";
import { TaskControlStore, type ProcessOwnerObservation } from "../src/coordination/root-session-store.js";
import { TaskHost } from "../src/tasks/host.js";
import { rangeDifferences, sameRange } from "../src/coordination/workflows.js";
import { cleanupDeliveryFixtures, failing, fixture, git, pending, rater, reviewer, successful } from "./helpers/workflow-delivery-fixture.js";

afterEach(cleanupDeliveryFixtures);

test("pending checks persist across restart and suppress idle Coordinator turns without pane metadata", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  f.github.checks = pending;
  f.github.mergeStateStatus = "UNKNOWN";

  const observation = await f.request("observe_checks");
  f.endRootTurn();
  await f.controller.recover("task");
  const turnsBefore = f.rootTurns().length;
  const dispatchesBefore = f.harness.dispatched.length;

  const reopened = new ForgeDatabase(join(f.directory, "forge.sqlite"), { migrate: false });
  const store = new TaskControlStore(reopened, f.alive);
  const delivery = new DeliveryOperations(store, f.port);
  const controller = new RootController(store, f.harness, delivery, undefined, { root: join(f.directory, "evidence") }, f.reader);
  const host = new TaskHost(reopened, { controller, delivery });
  try {
    for (const paneId of [null, "recreated-pane"] as const) {
      reopened.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET pane_id = ? WHERE id = ?").run(paneId, f.identity().sessionId));
      store.wakeIdleRoot("task");
      await host.recover("task");
      await host.recover("task");
    }

    expect(f.rootTurns()).toHaveLength(turnsBefore);
    expect(f.harness.dispatched).toHaveLength(dispatchesBefore);
    expect(store.get("task").workflowState.deliveryWait).toMatchObject({ headSha: f.featureSha, reason: "checks" });
    expect(observation).toMatchObject({
      checkSummary: "0 successful, 1 pending, 0 failing",
      wait: { headSha: f.featureSha, reason: "checks" },
      next: DELIVERY_WAIT_NEXT,
    });
  } finally {
    await host.stop();
    reopened.close();
  }
});

test("passing CI jobs do not wake Coordinator while another job is pending", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  const checks = (passed: number) => ({
    total: 4, pending: 4 - passed, failing: 0, successful: passed,
    runs: Array.from({ length: 4 }, (_, index) => ({ name: `job-${index}`, status: index < passed ? "successful" as const : "pending" as const, url: null })),
  });
  f.github.checks = checks(0);
  f.github.mergeStateStatus = "UNKNOWN";
  await f.request("observe_checks");
  f.endRootTurn();
  await f.controller.recover("task");
  const turnsBefore = f.rootTurns().length;
  const dispatchesBefore = f.harness.dispatched.length;

  const reopened = new ForgeDatabase(join(f.directory, "forge.sqlite"), { migrate: false });
  const store = new TaskControlStore(reopened, f.alive);
  const delivery = new DeliveryOperations(store, f.port);
  const controller = new RootController(store, f.harness, delivery, undefined, { root: join(f.directory, "evidence") }, f.reader);
  const host = new TaskHost(reopened, { controller, delivery });
  try {
    for (const [passed, paneId] of [[1, null], [2, "recreated-pane"], [3, null]] as const) {
      f.github.checks = checks(passed);
      reopened.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET pane_id = ? WHERE id = ?").run(paneId, f.identity().sessionId));
      store.wakeIdleRoot("task");
      await host.recover("task");
      await host.recover("task");
      expect(f.rootTurns()).toHaveLength(turnsBefore);
      expect(f.harness.dispatched).toHaveLength(dispatchesBefore);
      expect(store.get("task").workflowState.deliveryWait?.reason).toBe("checks");
    }
    f.github.checks = checks(4);
    expect(await delivery.observeDeliveryWait("task")).toBe("changed");
    expect(f.rootTurns()).toHaveLength(turnsBefore + 1);
  } finally {
    await host.stop();
    reopened.close();
  }
});

test("a persisted per-job fingerprint continues waiting through passing checks", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  f.github.mergeStateStatus = "UNKNOWN";
  f.github.checks = { total: 2, pending: 2, failing: 0, successful: 0, runs: [
    { name: "unit", status: "pending", url: null }, { name: "integration", status: "pending", url: null },
  ] };
  await f.request("observe_checks");
  const wait = f.store.get("task").workflowState.deliveryWait!;
  const legacy = JSON.stringify({ number: 7, head: f.featureSha, draft: true, review: null, mergeable: "MERGEABLE", mergeState: "UNKNOWN", state: "open", checks: ["integration:pending:", "unit:pending:"] });
  f.store.updateWorkflowState("task", state => ({ ...state, deliveryWait: { ...wait, fingerprint: legacy } }));
  f.github.checks = { total: 2, pending: 1, failing: 0, successful: 1, runs: [
    { name: "unit", status: "successful", url: null }, { name: "integration", status: "pending", url: null },
  ] };
  const turnsBefore = f.rootTurns().length;
  expect(await f.delivery.observeDeliveryWait("task")).toBe("unchanged");
  expect(f.rootTurns()).toHaveLength(turnsBefore);
  expect(f.store.get("task").workflowState.deliveryWait?.fingerprint).toBe(legacy);
});

test.each([
  { label: "all checks pass", checks: successful, remoteHead: null },
  { label: "a check fails", checks: failing, remoteHead: null },
  { label: "the remote head changes", checks: pending, remoteHead: "f".repeat(40) },
])("a pending-check wait resumes once when $label", { timeout: 60_000 }, async ({ checks, remoteHead }) => {
  const f = await fixture("refine_pull_request");
  f.github.checks = pending;
  f.github.mergeStateStatus = "UNKNOWN";
  await f.request("observe_checks");
  const turnsBefore = f.rootTurns().length;

  f.github.checks = checks;
  if (remoteHead) f.github.headSha = remoteHead;
  expect(await f.delivery.observeDeliveryWait("task")).toBe("changed");
  expect(await f.delivery.observeDeliveryWait("task")).toBe("none");
  expect(f.rootTurns()).toHaveLength(turnsBefore + 1);
  expect(f.store.get("task").workflowState.deliveryWait).toBeNull();
});

test("settled, failed, mixed failed-and-pending, closed, and different-head checks stay actionable", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  const noChecks = { total: 0, pending: 0, failing: 0, successful: 0, runs: [] };
  const failedAndPending = {
    total: 2,
    pending: 1,
    failing: 1,
    successful: 0,
    runs: [
      { name: "unit", status: "failing" as const, url: "https://ci.example/run/1", conclusion: "FAILURE" },
      { name: "integration", status: "pending" as const, url: null },
    ],
  };

  for (const checks of [noChecks, successful, failing, failedAndPending]) {
    f.github.checks = checks;
    const observation = await f.request("observe_checks");
    expect(observation).not.toHaveProperty("wait");
    expect(f.store.get("task").workflowState.deliveryWait).toBeNull();
  }

  f.github.state = "closed";
  f.github.checks = pending;
  expect(await f.request("observe_checks")).not.toHaveProperty("wait");
  expect(f.store.get("task").workflowState.deliveryWait).toBeNull();

  f.github.state = "open";
  f.github.checks = pending;
  f.github.headSha = "f".repeat(40);
  expect(await f.request("observe_checks")).toMatchObject({
    checkSummary: "0 successful, 1 pending, 0 failing",
    note: "The pull request head differs from the local head. Push the reviewed head before observing its checks.",
  });
  expect(f.store.get("task").workflowState.deliveryWait).toBeNull();
});

test("range equivalence uses the complete patch digest when bases differ", () => {
  const base = { baseSha: "a".repeat(40), headSha: "b".repeat(40), files: ["src.ts"], commits: ["b".repeat(40)], patchDigest: "c".repeat(64) };
  expect(rangeDifferences(base, base)).toEqual([]);
  expect(rangeDifferences(base, { ...base, baseSha: "d".repeat(40) })).toEqual([]);
  expect(rangeDifferences(base, { ...base, baseSha: "d".repeat(40), patchDigest: "e".repeat(64) })).toEqual(["patch content"]);
  expect(rangeDifferences(base, { ...base, baseSha: "d".repeat(40), patchDigest: undefined })).toEqual(["patch content"]);
  expect(rangeDifferences(base, { ...base, baseSha: "d".repeat(40), headSha: "e".repeat(40) })).toEqual(["head"]);
  expect(sameRange(base, { ...base, baseSha: "d".repeat(40) })).toBe(true);
});

test("inspectDeliveryDiff digests are stable across unrelated base moves and change when the merge-base moves", { timeout: 90_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await f.commit("src.ts", "export const value = 3;\n");
  const head = await git(f.worktree.path, ["rev-parse", "HEAD"]);
  const a = await inspectDeliveryDiff(f.worktree.path, f.baseSha, head);
  const clone = join(f.directory, "digest-advance");
  await git(f.directory, ["clone", "--quiet", f.bare, clone]);
  await git(clone, ["config", "user.email", "o@example.com"]); await git(clone, ["config", "user.name", "O"]);
  await writeFile(join(clone, "unrelated.txt"), "unrelated\n"); await git(clone, ["add", "."]); await git(clone, ["commit", "-q", "-m", "unrelated"]); await git(clone, ["push", "-q", "origin", "main"]);
  const newMain = await git(clone, ["rev-parse", "HEAD"]);
  const b = await inspectDeliveryDiff(f.worktree.path, newMain, head);
  expect(a.patchDigest).toBe(b.patchDigest);
  expect(a.commits).toEqual(b.commits);
  const c = await inspectDeliveryDiff(f.worktree.path, f.featureSha, head);
  expect(c.patchDigest).not.toBe(a.patchDigest);
  expect(c.files).toEqual(["src.ts"]);
  expect(c.commits).toHaveLength(1);
});

test("an existing pull request rated 7 is repaired until 9, pushed, waits for CI, repairs the CI failure, and merges the same pull request", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  const rate = async (rating: number, findings: string[] = []) => { await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); const session = f.store.currentSession("task", "worker")!; await f.finishDelegate(rater(rating, findings)); return session; };
  const repair = async (session: { id: string }, name: string) => { await f.controller.delegateWorker(f.identity(), { plan: `Repair ${name}`, acceptanceCriteria: ["Tests pass"], instruction: `Apply ${name}`, advisorSessionId: session.id }); const head = await f.commit(name); await f.finishDelegate(`Committed ${name} and ran pnpm test.`); return head; };
  const first = await rate(7, ["src.ts: off by one"]);
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required", message: expect.stringContaining("7/10") });
  await repair(first, "fix-one.ts");
  const second = await rate(8, ["src.ts: missing test"]);
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required", message: expect.stringContaining("8/10") });
  expect(f.calls.filter(call => call.startsWith("push"))).toEqual([]);
  const head9 = await repair(second, "fix-two.test.ts");
  await rate(9);
  f.github.onPush = () => { f.github.checks = pending; f.github.mergeStateStatus = "UNKNOWN"; };
  expect(await f.request("push_branch")).toMatchObject({ kind: "pushed", headSha: head9 });
  expect(await git(f.bare, ["rev-parse", "refs/heads/feature"])).toBe(head9);
  expect(f.store.get("task").workflowState.acceptedDelivery?.headSha).toBe(head9);
  expect(await f.request("create_or_adopt_pull_request")).toMatchObject({ number: 7, headSha: head9, state: "open" });
  expect(f.calls).not.toContain("create");
  expect(f.store.get("task").status).toBe("active");
  await f.request("request_review");
  expect(f.github.isDraft).toBe(false);
  expect(await f.request("observe_checks")).toMatchObject({ checkSummary: "0 successful, 1 pending, 0 failing", wait: { reason: "checks" }, next: DELIVERY_WAIT_NEXT });
  expect(f.store.get("task").workflowState.deliveryWait?.reason).toBe("checks");
  f.github.onMerge = () => "queue";
  await expect(f.request("merge_pull_request")).resolves.toMatchObject({ kind: "merge_requested", wait: { headSha: head9, reason: "merge_queue" }, next: DELIVERY_WAIT_NEXT });
  expect(Date.parse(f.store.get("task").wakeAt!) - Date.now()).toBeGreaterThan(20_000);
  // Pending CI: no repeated model turn, no Worker, and no generic idle wake.
  // The Coordinator ends its turn as instructed; the wait must not produce another model turn.
  await f.drainRoot();
  expect(f.store.pendingTurns(f.identity().sessionId)).toEqual([]);
  const turnsBefore = f.rootTurns().length; const dispatchedBefore = f.harness.dispatched.length;
  f.store.wakeIdleRoot("task");
  const host = new TaskHost(f.database, { controller: f.controller, delivery: f.delivery });
  try {
    await host.recover("task"); await host.recover("task");
    expect(f.rootTurns()).toHaveLength(turnsBefore);
    expect(f.harness.dispatched).toHaveLength(dispatchedBefore);
    expect(f.store.get("task").workflowState.deliveryWait).not.toBeNull();
    expect(Date.parse(f.store.get("task").wakeAt!) - Date.now()).toBeGreaterThan(20_000);
    // The wait survives a restart with new instances and unchanged polls still add nothing.
    const restarted = new TaskHost(new ForgeDatabase(join(f.directory, "forge.sqlite"), { migrate: false }), { controller: new RootController(new TaskControlStore(f.database, f.alive), f.harness, new DeliveryOperations(new TaskControlStore(f.database, f.alive), f.port), undefined, { root: join(f.directory, "evidence") }, f.reader), delivery: new DeliveryOperations(new TaskControlStore(f.database, f.alive), f.port) });
    try { await restarted.recover("task"); } finally { await restarted.stop(); }
    expect(f.rootTurns()).toHaveLength(turnsBefore);
    // CI fails with real evidence from the fixture: one continuation, then Rater sees the failure.
    f.github.checks = failing; f.github.mergeStateStatus = "UNSTABLE";
    await host.recover("task");
    expect(f.store.get("task").workflowState.deliveryWait).toBeNull();
    expect(f.rootTurns()).toHaveLength(turnsBefore + 1);
    expect(f.rootTurns().at(-1)!.promptText).toContain("Delivery state changed");
    expect(f.rootTurns().at(-1)!.promptText).toContain("https://ci.example/run/1");
    expect(f.harness.dispatched).toHaveLength(dispatchedBefore + 1);
    f.harness.finish(f.harness.dispatched.at(-1)!.messageID);
  } finally { await host.stop(); }
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const ciRater = f.store.currentSession("task", "worker")!;
  const ciRaterInput = f.store.turns("task").find(turn => turn.sessionId === ciRater.id && turn.generation === ciRater.generation)!.workflowInput as { evidenceDirectory: string };
  const evidence = JSON.parse(await readFile(join(ciRaterInput.evidenceDirectory, "verification.json"), "utf8"));
  expect(evidence.pullRequestChecks).toMatchObject({ checks: { failing: 1, runs: [{ name: "unit", conclusion: "FAILURE" }] } });
  await f.finishDelegate(rater(6, ["src.ts: unit check fails on the new head"]));
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required" });
  const head9b = await repair(ciRater, "fix-ci.ts");
  await rate(9);
  f.github.onPush = () => { f.github.checks = pending; f.github.mergeStateStatus = "UNKNOWN"; };
  expect(await f.request("push_branch")).toMatchObject({ kind: "pushed", headSha: head9b });
  expect(f.calls.filter(call => call.startsWith("push"))).toEqual([`push:${head9}`, `push:${head9b}`]);
  expect(await f.request("observe_checks")).toMatchObject({ checkSummary: "0 successful, 1 pending, 0 failing", wait: { reason: "checks" }, next: DELIVERY_WAIT_NEXT });
  expect(f.store.get("task").workflowState.deliveryWait?.reason).toBe("checks");
  await expect(f.request("merge_pull_request")).resolves.toMatchObject({ kind: "merge_requested", wait: { reason: "merge_queue" } });
  f.github.checks = successful; f.github.mergeStateStatus = "CLEAN";
  expect(await f.delivery.observeDeliveryWait("task")).toBe("changed");
  f.github.onMerge = () => "merge";
  const merged = await f.request("merge_pull_request") as { state: string; number: number };
  expect(merged).toMatchObject({ state: "merged", number: 7, checkSummary: "1 successful, 0 pending, 0 failing" });
  expect(f.calls.filter(call => call.startsWith("merge"))).toEqual([
    `merge:${head9}`,
    `merge:${head9b}`,
    `merge:${head9b}`,
  ]);
  expect(await git(f.bare, ["rev-parse", "refs/heads/main"])).toBe(head9b);
  const final = f.store.get("task");
  expect(final).toMatchObject({ status: "delivered", pullRequest: { number: 7, state: "merged" }, workflowState: { completion: { kind: "workflow", reviewedHead: head9b, pullRequestNumber: 7 }, deliveryWait: null } });
  expect(final.workflowState.reviews.map(record => record.result && record.result.role === "rater" ? record.result.rating : null)).toEqual([7, 8, 9, 6, 9]);
  expect(final.workflowState.reviews.map(record => record.range.headSha)).toEqual([f.featureSha, expect.any(String), head9, head9, head9b]);
});

test("an initial 9 needs no repair commit, and repeated defects stay active without opening the gate", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  await f.finishDelegate(rater(9));

  expect(await f.request("push_branch")).toMatchObject({ kind: "adopted", headSha: f.featureSha });
  expect(await git(f.worktree.path, ["rev-list", "--count", "HEAD"])).toBe("2");

  const g = await fixture("refine_pull_request");
  let previous: { id: string } | null = null;
  for (let round = 0; round < 4; round++) {
    if (previous) { await g.controller.delegateWorker(g.identity(), { plan: "again", acceptanceCriteria: ["x"], instruction: "y", advisorSessionId: previous.id }); await g.commit(`attempt-${round}.ts`); await g.finishDelegate("Tried again."); }
    await g.controller.delegateAdvisor(g.identity(), { role: "rater" });
    previous = g.store.currentSession("task", "worker")!;
    await g.finishDelegate(rater(5, ["src.ts: race condition"]));
    await expect(g.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required" });
  }
  expect(g.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
  await expect(g.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required" });
  await g.controller.delegateWorker(g.identity(), { plan: "again", acceptanceCriteria: ["x"], instruction: "y", advisorSessionId: previous!.id }); await g.commit("attempt-final.ts"); await g.finishDelegate("Fifth attempt.");
  await g.controller.delegateAdvisor(g.identity(), { role: "rater" }); await g.finishDelegate(rater(9));
  expect(g.store.get("task").workflowState.reviews).toHaveLength(5);
  expect(await g.request("push_branch")).toMatchObject({ kind: "pushed" });
  expect(g.calls.filter(call => call.startsWith("push"))).toHaveLength(1);
});

test("an existing open pull request does not complete Second opinion before Reviewer, and local completion also needs a passing Reviewer", { timeout: 60_000 }, async () => {
  const f = await fixture("independent_review");
  f.github.headSha = f.featureSha;
  expect(await f.delivery.observe("task")).toMatchObject({ number: 7, state: "open" });
  expect(f.store.get("task").status).toBe("active");
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required", message: expect.stringContaining("No Reviewer result") });
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan and criteria." });
  await f.finishDelegate(reviewer(false, ["src.ts: off by one"]));
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required", message: expect.stringContaining("did not approve") });
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan and criteria." });
  await f.finishDelegate(reviewer(true));
  const adopted = await f.request("create_or_adopt_pull_request");
  expect(adopted).toMatchObject({ number: 7 });
  expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: f.featureSha } } });

  const local = await fixture("independent_review", { deliveryTarget: "local_worktree" });
  await expect(local.controller.requestDelivery(local.identity(), "complete_local_work", local.featureSha)).rejects.toMatchObject({ code: "workflow_review_required" });
  await local.controller.delegateAdvisor(local.identity(), { role: "reviewer", brief: "Plan." }); await local.finishDelegate(reviewer(true));
  await writeFile(join(local.worktree.path, "dirty.txt"), "uncommitted");
  await expect(local.controller.requestDelivery(local.identity(), "complete_local_work", local.featureSha)).rejects.toMatchObject({ code: "worktree_dirty" });
  await rm(join(local.worktree.path, "dirty.txt"));
  expect(await local.controller.requestDelivery(local.identity(), "complete_local_work", local.featureSha)).toMatchObject({ kind: "local_work_completed" });
  expect(local.store.get("task").status).toBe("delivered");
});

test("changed heads, dirty trees, active delegates, newer negative reviews, divergence, and wrong repositories block publication with specific reasons", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); await f.finishDelegate(rater(9)); const good = f.store.currentSession("task", "worker")!;
  const { headSha, review } = await f.inspect();
  await f.commit("late.ts");
  await expect(f.controller.requestDelivery(f.identity(), "push_branch", headSha, review)).rejects.toMatchObject({ code: "delivery_review_required" });
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required", message: expect.stringContaining("not the current range") });
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); await f.finishDelegate(rater(9));
  await writeFile(join(f.worktree.path, "scratch.txt"), "dirty");
  await expect(f.request("push_branch")).rejects.toMatchObject({ code: "worktree_dirty" });
  await rm(join(f.worktree.path, "scratch.txt"));
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["Checks run"], instruction: "Run pnpm test" });
  await expect(f.request("push_branch")).rejects.toMatchObject({ code: "delegate_active" });
  await f.finishDelegate("pnpm test passed.");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); await f.finishDelegate("garbage without json");
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required", message: expect.stringContaining("invalid") });
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); const repeated = f.store.currentSession("task", "worker")!; await f.finishDelegate(rater(9));
  expect(repeated).toMatchObject({ id: good.id, nativeSessionId: good.nativeSessionId, paneId: good.paneId });
  expect(repeated.generation).toBeGreaterThan(good.generation);
  // Remote divergence: someone else advanced the branch. A normal push is rejected and local work stays.
  const other = join(f.directory, "other"); await git(f.directory, ["clone", f.bare, other]); await git(other, ["checkout", "feature"]);
  await git(other, ["config", "user.email", "o@example.com"]); await git(other, ["config", "user.name", "O"]);
  await writeFile(join(other, "other.ts"), "other\n"); await git(other, ["add", "."]); await git(other, ["commit", "-m", "external"]); await git(other, ["push", "origin", "feature"]);
  await expect(f.request("push_branch")).rejects.toMatchObject({ message: expect.stringMatching(/rejected|push failed/) });
  expect(await git(f.worktree.path, ["log", "--oneline"])).toContain("late.ts");
  expect(await git(f.bare, ["log", "--oneline", "refs/heads/feature"])).toContain("external");
  // Wrong repository and closed pull request. A pinned pull request may be retargeted, but its live base must exist.
  f.github.remote = "someone/else";
  await expect(f.request("push_branch")).rejects.toMatchObject({ code: "head_diverged", message: expect.stringContaining("remote") });
  f.github.remote = "owner/repo"; f.github.baseBranch = "release";
  await expect(f.request("create_or_adopt_pull_request")).rejects.toMatchObject({ code: "observation_unavailable", message: expect.stringContaining("release") });
  f.github.baseBranch = "main"; f.github.state = "closed";
  await expect(f.request("create_or_adopt_pull_request")).rejects.toMatchObject({ code: "pull_request_closed" });
  expect(f.calls).not.toContain("create");
});

test("merge delegates eligibility to GitHub and waits for accepted asynchronous requests", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); await f.finishDelegate(rater(9));
  f.github.isDraft = false;
  f.github.onMerge = () => "queue";
  f.github.checks = pending; f.github.mergeStateStatus = "UNKNOWN";
  expect(await f.request("merge_pull_request")).toMatchObject({ kind: "merge_requested", wait: { reason: "merge_queue" } });
  expect(f.calls.filter(call => call.startsWith("merge"))).toEqual([`merge:${f.featureSha}`]);
  expect(f.store.get("task").status).toBe("active");
  f.github.state = "merged";
  expect(await f.delivery.observeDeliveryWait("task")).toBe("finished");
  expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow" } } });

  const g = await fixture("refine_pull_request");
  await g.controller.delegateAdvisor(g.identity(), { role: "rater" }); await g.finishDelegate(rater(9));
  g.github.isDraft = false; g.github.checks = failing; g.github.mergeStateStatus = "UNSTABLE";
  expect(await g.request("merge_pull_request")).toMatchObject({ state: "merged", checkSummary: "0 successful, 0 pending, 1 failing" });
  expect(g.calls.filter(call => call.startsWith("merge"))).toEqual([`merge:${g.featureSha}`]);
  expect(g.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow" } } });
});

test("an external merge before the obligations are met is labeled external and never fabricates a rating, and a cancelled task stays cancelled", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  f.github.state = "merged";
  await f.delivery.observe("task");
  expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "external_merge", reviewedHead: null, pullRequestNumber: 7 }, reviews: [] } });
  const g = await fixture("refine_pull_request");
  await g.controller.delegateAdvisor(g.identity(), { role: "rater" }); await g.finishDelegate(rater(9));
  g.store.cancel("task");
  g.github.state = "merged";
  await g.delivery.observe("task");
  expect(g.store.get("task").status).toBe("cancelled");
  expect(g.store.get("task").workflowState.completion).toBeNull();
});

test("crash after push or merge adopts the actual remote state, and cancellation during a merge request records the accepted outcome without further action", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" }); await f.finishDelegate(rater(9));
  // The push reached the remote but the response was lost: the retry adopts it without pushing again.
  await git(f.worktree.path, ["push", "origin", "feature"]);
  expect(await f.request("push_branch")).toMatchObject({ kind: "adopted" });
  expect(f.calls.filter(call => call.startsWith("push"))).toEqual([]);
  f.github.isDraft = false; f.github.checks = successful;
  // The merge reached GitHub before a crash: the retry observes the merged pull request and completes with the accepted review.
  const original = f.port.mergePullRequest;
  f.port.mergePullRequest = async input => { await original(input); throw new Error("connection reset after merge"); };
  await expect(f.request("merge_pull_request")).rejects.toThrow("connection reset");
  expect(f.store.get("task").status).toBe("active");
  expect(f.store.get("task").workflowState.acceptedDelivery?.headSha).toBe(f.featureSha);
  await f.delivery.observe("task");
  expect(f.store.get("task")).toMatchObject({ status: "delivered", workflowState: { completion: { kind: "workflow", reviewedHead: f.featureSha } } });
  const g = await fixture("refine_pull_request");
  await g.controller.delegateAdvisor(g.identity(), { role: "rater" }); await g.finishDelegate(rater(9));
  g.github.isDraft = false; g.github.checks = successful;
  await git(g.worktree.path, ["push", "origin", "feature"]);
  g.github.onMerge = () => { g.store.cancel("task"); return "merge"; };
  await g.request("merge_pull_request").catch(() => undefined);
  expect(g.store.get("task")).toMatchObject({ status: "cancelled", pullRequest: { state: "merged" }, workflowState: { completion: { kind: "workflow", pullRequestNumber: 7 } } });
  expect(await git(g.bare, ["rev-parse", "refs/heads/main"])).toBe(g.featureSha);
});

test("root tool calls are serialized per task through the tool owner and a dead owner is recovered", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  let observation: ProcessOwnerObservation = { kind: "running", startTime: "test-process" };
  const storeA = new TaskControlStore(f.database, async () => observation);
  const storeB = new TaskControlStore(f.database, async () => observation);
  const first = await storeA.claimToolOwner("task");
  expect(first).toBeTruthy();
  expect(await storeB.claimToolOwner("task")).toBeNull();
  const bridge = new RootBridge(f.identity(), new RootController(storeB, f.harness, f.delivery));
  await expect(bridge.call({ kind: "observe" })).rejects.toMatchObject({ code: "task_tool_busy" });
  observation = { kind: "unknown" };
  expect(await storeB.claimToolOwner("task")).toBeNull();
  observation = { kind: "running", startTime: "test-process" };
  storeA.releaseToolOwner("task", "wrong-token");
  expect(f.store.get("task").workflowState.toolOwner?.token).toBe(first);
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.toolOwner.processStartTime', 'dead-process') WHERE task_id = 'task'").run());
  const replaced = await storeB.claimToolOwner("task");
  expect(replaced).toBeTruthy();
  expect(replaced).not.toBe(first);
  expect(() => storeA.assertToolOwner("task", first!)).toThrow("task_tool_owner_lost");
  storeB.releaseToolOwner("task", replaced!);
  expect(f.store.get("task").workflowState.toolOwner).toBeNull();
  const okBridge = new RootBridge(f.identity(), new RootController(storeB, f.harness, f.delivery));
  expect(await okBridge.call({ kind: "observe" })).toMatchObject({ control: { taskId: "task" } });
  expect(JSON.stringify(await okBridge.call({ kind: "observe" }))).not.toContain("toolOwner");
  expect(f.store.get("task").workflowState.toolOwner).toBeNull();
});

test("a passing rating permits teammate reconciliation and the integrated revision needs a fresh rating", { timeout: 60_000 }, async () => {
  const f = await fixture("refine_pull_request");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const nine = f.store.currentSession("task", "worker")!;
  await f.finishDelegate(rater(9));
  await f.commit("teammate.ts");
  await f.controller.delegateWorker(f.identity(), { plan: "Integrate teammate work", acceptanceCriteria: ["Preserve both changes"], instruction: "Compare and integrate the remote repair, then verify.", advisorSessionId: nine.id });
  await f.commit("integrated.ts");
  await f.finishDelegate("Integrated and verified.");
  await expect(f.request("request_review")).rejects.toMatchObject({ code: "workflow_review_required" });
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  await f.finishDelegate(rater(9));
  await expect(f.request("push_branch")).resolves.toMatchObject({ kind: "pushed" });
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
});

 test("publishing for CI does not need Reviewer approval or complete a remote-branch task", { timeout: 60_000 }, async () => {
  const f = await fixture("independent_review", { deliveryTarget: "remote_branch" });
  const head = await f.commit("src.ts", "export const value = 3;\n");
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Review the current head and CI." });
  await f.finishDelegate(reviewer(false, ["Current-head CI is missing"]));
  await expect(f.request("push_branch")).resolves.toMatchObject({ kind: "pushed", headSha: head });
  expect(await git(f.bare, ["rev-parse", "feature"])).toBe(head);
  expect(f.store.get("task")).toMatchObject({ status: "active", workflowState: { acceptedDelivery: null, completion: null } });
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "CI now passes." });
  await f.finishDelegate(reviewer(true));
  await expect(f.request("push_branch")).resolves.toMatchObject({ kind: "adopted", headSha: head });
  expect(f.store.get("task").status).toBe("delivered");
});

test("draft creation obtains CI evidence before final review without completing the task", { timeout: 60_000 }, async () => {
  const f = await fixture("independent_review");
  const listPullRequests = f.port.listPullRequests;
  f.port.listPullRequests = async () => [];
  const inspected = await f.inspect();
  await expect(f.controller.requestDelivery(f.identity(), "create_or_adopt_pull_request", inspected.headSha, inspected.review, "Repair the feature", "## Summary\nRepair the feature.\n## Why\nFix the defect.\n## Validation\nCI pending.\n## Review notes\nReview src.ts.")).resolves.toMatchObject({ number: 7 });
  expect(f.calls).toContain("create");
  f.port.listPullRequests = listPullRequests;
  expect(f.store.get("task")).toMatchObject({ status: "active", workflowState: { acceptedDelivery: null, completion: null } });
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "CI now passes." });
  await f.finishDelegate(reviewer(true));
  await expect(f.request("create_or_adopt_pull_request")).resolves.toMatchObject({ number: 7 });
  expect(f.store.get("task").status).toBe("delivered");
});

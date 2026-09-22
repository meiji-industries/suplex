import { afterEach, expect, test } from "vitest";

import { cleanupMergeTrainFixtures, failingChecks, git, mergeTrainFixture } from "./helpers/merge-train-fixture.js";
import { TaskFailure } from "../src/tasks/tasks.js";
import { HEAD_NOT_ACCEPTED } from "../src/delivery/agent-delivery.js";

afterEach(cleanupMergeTrainFixtures);

const mainHead = (bare: string) => git(bare, ["rev-parse", "refs/heads/main"]);

test("a three-pull-request serial train merges in dependency order and records provenance", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(3);
  const [first, second, third] = f.train;
  f.dependOn(second!, [first!]);
  f.dependOn(third!, [second!]);

  const train = await f.agentDelivery.mergeTrain(f.principal);
  expect(train.entries.map(entry => entry.taskId)).toEqual([first!.id, second!.id, third!.id]);
  expect(train.entries.map(entry => entry.blocker)).toEqual([null, `Task ${first!.id} is not delivered.`, `Task ${second!.id} is not delivered.`]);
  expect(train.entries[0]).toMatchObject({ pullRequestNumber: first!.pull.number, headSha: first!.pull.headSha, baseSha: first!.pull.baseSha, isDraft: false, reviewDecision: "APPROVED" });
  expect(train.entries[0]!.checks).toEqual({ total: 1, pending: 0, failing: 0, successful: 1 });

  for (const task of [first!, second!, third!]) {
    if (task !== first) await f.repairBranch(task);
    await f.approveAndMerge(task);
    expect(f.store.get(task.id).status).toBe("delivered");
  }
  expect(f.merges).toEqual([first!.pull.number, second!.pull.number, third!.pull.number]);
  expect(await git(f.bare, ["rev-list", "--count", "refs/heads/main"])).not.toBe("1");
  for (const task of [first!, second!, third!]) {
    const records = f.provenance(task.id);
    expect(records.map(record => record.kind)).toEqual(["merge"]);
    expect(records[0]).toMatchObject({ pull_request_number: task.pull.number, task_id: task.id });
  }
  expect(f.auditCount("agent_api_pull_request_merged")).toBe(3);
  expect(f.auditCount("agent_api_merge_approval_issued")).toBe(3);
});

test("an out-of-order merge is refused while the upstream task is not delivered", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(2);
  const [first, second] = f.train;
  f.dependOn(second!, [first!]);
  await expect(f.approveAndMerge(second!)).rejects.toThrow(`Task ${first!.id} is not delivered.`);
  expect(f.merges).toEqual([]);
  expect(await mainHead(f.bare)).toBe(first!.pull.baseSha);
  // The upstream merge unblocks the train.
  await f.approveAndMerge(first!);
  await f.repairBranch(second!);
  await f.approveAndMerge(second!);
  expect(f.merges).toEqual([first!.pull.number, second!.pull.number]);
});

test("base drift and a conflict resume the Coordinator repair path and append provenance", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(2);
  const [first, second] = f.train;
  await f.approveAndMerge(first!);
  // GitHub reports the drifted pull request as conflicting after the base advanced.
  second!.pull.baseSha = await mainHead(f.bare);
  second!.pull.mergeable = "CONFLICTING";
  second!.pull.mergeStateStatus = "DIRTY";

  await expect(f.approveAndMerge(second!)).rejects.toThrow("conflicts with the base branch");

  const rootSession = f.store.currentSession(second!.id, "root")!;
  const before = f.store.turns(second!.id).length;
  const repair = await f.agentDelivery.requestReconciliation(f.principal, second!.id);
  expect(repair.attemptId).toMatch(/^dpr_/);
  const turns = f.store.turns(second!.id);
  expect(turns.length).toBe(before + 1);
  expect(turns.at(-1)!.sessionId).toBe(rootSession.id);
  expect(turns.at(-1)!.promptText).toContain("delivery repair");
  expect(f.auditCount("agent_api_delivery_repair_requested")).toBe(1);

  const opened = f.provenance(second!.id);
  expect(opened.map(record => record.kind)).toEqual(["reconciliation"]);
  expect(opened[0]).toMatchObject({ id: repair.attemptId, attempt_id: repair.attemptId, original_head_sha: second!.pull.headSha });

  // The Coordinator repairs the branch; the agent then re-observes and merges.
  const repairedHead = await f.repairBranch(second!);
  const refreshed = await f.agentDelivery.refresh(f.principal, second!.id);
  expect(refreshed.observation?.headSha).toBe(repairedHead);
  const afterRefresh = f.provenance(second!.id);
  expect(afterRefresh.map(record => record.kind)).toEqual(["reconciliation", "observation"]);
  expect(afterRefresh[1]).toMatchObject({ attempt_id: repair.attemptId, original_head_sha: opened[0]!.original_head_sha, head_sha: repairedHead });

  await f.approveAndMerge(second!);
  const final = f.provenance(second!.id);
  expect(final.map(record => record.kind)).toEqual(["reconciliation", "observation", "merge"]);
  expect(final[2]).toMatchObject({ attempt_id: repair.attemptId, original_head_sha: repairedHead });
  expect(JSON.parse(final[2]!.checks_json!)).toMatchObject({ failing: 0 });
  expect(f.store.get(second!.id).status).toBe("delivered");
});

test("provenance rows are append-only", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(1);
  const [only] = f.train;
  await f.approveAndMerge(only!);
  const record = f.provenance(only!.id)[0]!;
  expect(() => f.database.authTransaction(db => db.prepare("UPDATE forge_delivery_provenance SET head_sha = 'x' WHERE id = ?").run(record.id))).toThrow(/append-only/);
});

test("a failed check refuses the merge and is eligible for repair", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(1);
  const [only] = f.train;
  only!.pull.checks = failingChecks;
  await expect(f.approveAndMerge(only!)).rejects.toThrow("A necessary check failed.");
  expect(f.merges).toEqual([]);
  const train = await f.agentDelivery.mergeTrain(f.principal);
  expect(train.entries[0]!.blocker).toBe("A necessary check failed.");
  const repair = await f.agentDelivery.requestReconciliation(f.principal, only!.id);
  expect(JSON.parse(f.provenance(only!.id)[0]!.checks_json!)).toMatchObject({ failing: 1 });
  expect(repair.observation.checks.failing).toBe(1);
});

test("a stale head, a stale base, a wrong pull request number, and a spent receipt are refused", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(1);
  const [only] = f.train;
  const approval = await f.agentDelivery.issueApproval(f.principal, only!.id, { pullRequestNumber: only!.pull.number, headSha: only!.pull.headSha, baseSha: only!.pull.baseSha });
  const stale = "a".repeat(40);
  await expect(f.agentDelivery.merge(f.principal, only!.id, { pullRequestNumber: only!.pull.number, expectedHeadSha: stale, expectedBaseSha: only!.pull.baseSha, approvalReceipt: approval.receipt }))
    .rejects.toThrow("GitHub reports a different head or base.");
  await expect(f.agentDelivery.merge(f.principal, only!.id, { pullRequestNumber: only!.pull.number, expectedHeadSha: only!.pull.headSha, expectedBaseSha: stale, approvalReceipt: approval.receipt }))
    .rejects.toThrow("GitHub reports a different head or base.");
  await expect(f.agentDelivery.merge(f.principal, only!.id, { pullRequestNumber: 999, expectedHeadSha: only!.pull.headSha, expectedBaseSha: only!.pull.baseSha, approvalReceipt: approval.receipt }))
    .rejects.toThrow("The pull request number does not match this task.");
  await expect(f.agentDelivery.merge(f.principal, only!.id, { pullRequestNumber: only!.pull.number, expectedHeadSha: only!.pull.headSha, expectedBaseSha: only!.pull.baseSha, approvalReceipt: `fma_${"a".repeat(43)}` }))
    .rejects.toThrow("The approval receipt is not valid.");
  expect(f.merges).toEqual([]);

  // A refused merge never spends the receipt.
  expect(f.database.authQuery(db => db.prepare("SELECT consumed_at FROM forge_merge_approvals").get())).toEqual({ consumed_at: null });

  // The receipt merges exactly once, and the replay merges nothing.
  await f.agentDelivery.merge(f.principal, only!.id, { pullRequestNumber: only!.pull.number, expectedHeadSha: only!.pull.headSha, expectedBaseSha: only!.pull.baseSha, approvalReceipt: approval.receipt });
  expect(f.database.authQuery(db => db.prepare("SELECT consumed_at FROM forge_merge_approvals").get() as { consumed_at: string | null }).consumed_at).not.toBeNull();
  await expect(f.agentDelivery.merge(f.principal, only!.id, { pullRequestNumber: only!.pull.number, expectedHeadSha: only!.pull.headSha, expectedBaseSha: only!.pull.baseSha, approvalReceipt: approval.receipt })).rejects.toThrow(TaskFailure);
  expect(f.merges).toEqual([only!.pull.number]);
});

test("a draft pull request refuses both the merge and its approval receipt", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(1);
  const [only] = f.train;
  only!.pull.isDraft = true;
  await expect(f.agentDelivery.issueApproval(f.principal, only!.id, { pullRequestNumber: only!.pull.number, headSha: only!.pull.headSha, baseSha: only!.pull.baseSha }))
    .rejects.toThrow("The pull request is a draft.");
  only!.pull.isDraft = false;
  only!.pull.reviewDecision = null;
  await expect(f.agentDelivery.issueApproval(f.principal, only!.id, { pullRequestNumber: only!.pull.number, headSha: only!.pull.headSha, baseSha: only!.pull.baseSha }))
    .rejects.toThrow("GitHub does not report an approved review.");
});

test("wait and resume follow the dependency graph and name the blocking task", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(2);
  const [first, second] = f.train;
  f.dependOn(second!, [first!]);
  expect(f.agentDelivery.decide(f.principal, second!.id, "wait_for_dependency")).toMatchObject({ decision: "wait_for_dependency", blockingTaskIds: [first!.id] });
  expect(() => f.agentDelivery.decide(f.principal, second!.id, "resume")).toThrow(`Task ${first!.id} is not delivered.`);
  expect(() => f.agentDelivery.decide(f.principal, first!.id, "wait_for_dependency")).toThrow("Every dependency of this task is delivered.");

  await f.approveAndMerge(first!);
  const before = f.store.turns(second!.id).length;
  expect(f.agentDelivery.decide(f.principal, second!.id, "resume")).toMatchObject({ decision: "resume", blockingTaskIds: [] });
  expect(f.store.turns(second!.id).length).toBe(before + 1);
  expect(() => f.agentDelivery.decide(f.principal, second!.id, "wait_for_dependency")).toThrow("Every dependency of this task is delivered.");
  expect(f.auditCount("agent_api_delivery_resumed")).toBe(1);
  expect(f.auditCount("agent_api_delivery_wait_accepted")).toBe(1);
});

test("a refresh observes GitHub and records an audit event without changing the task", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(1);
  const [only] = f.train;
  const result = await f.agentDelivery.refresh(f.principal, only!.id);
  expect(result.observation).toMatchObject({ exists: true, number: only!.pull.number, headSha: only!.pull.headSha, mergeStateStatus: "CLEAN" });
  expect(result.pullRequest).toMatchObject({ number: only!.pull.number, state: "open" });
  expect(f.auditCount("agent_api_delivery_observed")).toBe(1);
  expect(f.store.get(only!.id).status).toBe("active");
  // No repair attempt is open, so the refresh appends nothing.
  expect(f.provenance(only!.id)).toEqual([]);
});

test("a healthy pull request cannot request delivery repair", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(1);
  const [only] = f.train;
  await expect(f.agentDelivery.requestReconciliation(f.principal, only!.id)).rejects.toThrow("GitHub reports no delivery problem");
  expect(f.provenance(only!.id)).toEqual([]);
});

test("another agent cannot observe, repair, or merge a task it did not create", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(1);
  const [only] = f.train;
  const other = f.externalAgent.create(f.adminId, { name: "Other Agent", companyId: f.company.id, projectIds: [f.project.id] });
  const outsider = f.externalAgent.authenticate(f.externalAgent.exchange({ pairingCode: other.pairingCode, profileId: "profile-other" }).credential);
  await expect(f.agentDelivery.refresh(outsider, only!.id)).rejects.toThrow(TaskFailure);
  await expect(f.agentDelivery.requestReconciliation(outsider, only!.id)).rejects.toThrow(TaskFailure);
  await expect(f.agentDelivery.issueApproval(outsider, only!.id, { pullRequestNumber: only!.pull.number, headSha: only!.pull.headSha, baseSha: only!.pull.baseSha })).rejects.toThrow(TaskFailure);
  expect((await f.agentDelivery.mergeTrain(outsider)).entries).toEqual([]);
});

test("a head that Forge never accepted is listed as blocked and refused by the approval and the merge", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(1);
  const [only] = f.train;
  const unaccepted = await f.pushUnacceptedCommit(only!);
  const accepted = f.store.get(only!.id).workflowState.acceptedDelivery!.headSha;
  expect(unaccepted).not.toBe(accepted);

  const train = await f.agentDelivery.mergeTrain(f.principal);
  expect(train.entries[0]).toMatchObject({ headSha: unaccepted, blocker: HEAD_NOT_ACCEPTED });
  const request = { pullRequestNumber: only!.pull.number, headSha: unaccepted, baseSha: only!.pull.baseSha };
  await expect(f.agentDelivery.issueApproval(f.principal, only!.id, request)).rejects.toThrow(HEAD_NOT_ACCEPTED);
  expect(f.database.authQuery(db => db.prepare("SELECT COUNT(*) AS count FROM forge_merge_approvals").get())).toEqual({ count: 0 });
  await expect(f.agentDelivery.merge(f.principal, only!.id, { pullRequestNumber: only!.pull.number, expectedHeadSha: unaccepted, expectedBaseSha: only!.pull.baseSha, approvalReceipt: `fma_${"a".repeat(43)}` }))
    .rejects.toThrow(HEAD_NOT_ACCEPTED);
  expect(f.merges).toEqual([]);

  // The Coordinator accepts the new head, and the same merge then succeeds.
  await f.acceptHead(only!.id);
  await f.approveAndMerge(only!);
  expect(f.merges).toEqual([only!.pull.number]);
});

test("a delivery repair is refused while an upstream task is not delivered", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(2);
  const [first, second] = f.train;
  f.dependOn(second!, [first!]);
  second!.pull.mergeable = "CONFLICTING";
  second!.pull.mergeStateStatus = "DIRTY";

  await expect(f.agentDelivery.requestReconciliation(f.principal, second!.id))
    .rejects.toThrow(`Task ${first!.id} is not delivered. Wait for its delivery instead of a delivery repair.`);
  expect(f.provenance(second!.id)).toEqual([]);
  expect(f.auditCount("agent_api_delivery_repair_requested")).toBe(0);

  // The upstream delivery makes the repair available, and its prompt keeps the merged work intact.
  await f.approveAndMerge(first!);
  const repair = await f.agentDelivery.requestReconciliation(f.principal, second!.id);
  expect(repair.attemptId).toMatch(/^dpr_/);
  expect(f.store.turns(second!.id).at(-1)!.promptText).toContain("Do not rewrite it and do not reimplement it.");
});

test("a human Blocked by edit gates the train exactly like an agent-declared dependency", { timeout: 120_000 }, async () => {
  const f = await mergeTrainFixture(2);
  const [first, second] = f.train;
  f.blockOn(second!, [first!]);

  // One gate: the Blocked by task reads as a dependency everywhere Forge decides.
  expect(f.tasks.getTask(f.adminId, second!.id).dependsOn).toEqual([first!.id]);
  expect(f.store.dependencySummaries(second!.id)).toEqual([{ id: first!.id, title: "Train task 1", status: "active" }]);
  const train = await f.agentDelivery.mergeTrain(f.principal);
  expect(train.entries.map(entry => entry.taskId)).toEqual([first!.id, second!.id]);
  expect(train.entries[1]).toMatchObject({ dependsOn: [first!.id], blocker: `Task ${first!.id} is not delivered.` });

  expect(() => f.agentDelivery.decide(f.principal, second!.id, "resume")).toThrow(`Task ${first!.id} is not delivered.`);
  expect(f.agentDelivery.decide(f.principal, second!.id, "wait_for_dependency")).toMatchObject({ blockingTaskIds: [first!.id] });
  const request = { pullRequestNumber: second!.pull.number, headSha: second!.pull.headSha, baseSha: second!.pull.baseSha };
  await expect(f.agentDelivery.issueApproval(f.principal, second!.id, request)).rejects.toThrow(`Task ${first!.id} is not delivered.`);
  await expect(f.approveAndMerge(second!)).rejects.toThrow(`Task ${first!.id} is not delivered.`);
  expect(f.merges).toEqual([]);

  // The agent declaring the same prerequisite reads back the same single edge.
  f.dependOn(second!, [first!]);
  expect(f.tasks.getTask(f.adminId, second!.id).dependsOn).toEqual([first!.id]);

  // A loop through the human-set edge is rejected.
  expect(() => f.dependOn(first!, [second!])).toThrow("The dependency creates a cycle");

  // The upstream delivery opens the gate.
  await f.approveAndMerge(first!);
  expect(f.agentDelivery.decide(f.principal, second!.id, "resume")).toMatchObject({ blockingTaskIds: [] });
  await f.repairBranch(second!);
  await f.approveAndMerge(second!);
  expect(f.merges).toEqual([first!.pull.number, second!.pull.number]);
});

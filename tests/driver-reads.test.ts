import { describe, expect, it } from "vitest";

import { executionId, turnId } from "../src/ids.js";
import { readOwner, type DriverDependencies } from "../src/engine/workflow/driver.js";
import { STEP_TABLE } from "../src/engine/workflow/step-table.js";
import type { IssueWorkflowContext } from "../src/engine/workflow/context.js";

const sha = "a".repeat(40);
const tree = "b".repeat(40);

function context(overrides: Record<string, unknown> = {}): IssueWorkflowContext {
  return { input: { issueId: "task", companyId: "company", workflowId: "workflow", repository: "acme/forge" }, state: { resultCommit: sha, resultTree: tree, targetBaseSha: sha, branchName: "forge/task", planRevision: 1, ...overrides } } as unknown as IssueWorkflowContext;
}

function dependencies(overrides: Partial<DriverDependencies> = {}): DriverDependencies {
  return {
    inspectTaskWorktree: async () => ({ present: true, dirtyFileCount: 0, revision: { proven: true, head: sha, headTree: tree, clean: true } }),
    observeGithubPullRequest: async () => ({ exists: true, state: "open", mergeable: "MERGEABLE", checks: { pending: 0, failing: 0, total: 1, successful: 1 } }),
    readLatestHerdrTurn: async () => null,
    isTaskTurnLive: async () => ({ live: false }),
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    ...overrides,
  };
}

const approvedReview = { kind: "delivery_review", summary: "Approved", outcome: "approved", findings: [], repairPlan: null };

describe("readOwner", () => {
  it("covers each owner represented by STEP_TABLE", async () => {
    const owners = new Set(Object.values(STEP_TABLE).filter((rule) => !rule.terminal).map((rule) => rule.waitsOn.owner));
    for (const owner of owners) {
      const waitsOn = Object.values(STEP_TABLE).find((rule) => !rule.terminal && rule.waitsOn.owner === owner)?.waitsOn;
      if (!waitsOn || waitsOn.owner === "terminal") continue;
      const state = waitsOn.owner === "member" && waitsOn.decision === "plan_approval" ? context({ planApproved: true }) : waitsOn.owner === "timer" ? context({ acceptanceRetryAt: "2026-09-04T11:59:59.000Z" }) : context();
      if (waitsOn.owner === "herdr") {
        const turn = { turnId: turnId("turn"), executionId: executionId("execution"), role: waitsOn.role, ledger: "agent" as const, promptKind: waitsOn.promptKind, subject: {}, result: waitsOn.promptKind === "delivery-review" || waitsOn.promptKind === "final-review" ? approvedReview : { version: 1, originalPlanRevision: 0, reviewArtifactId: "artifact", reviewResponse: "Done", result: {} }, terminalFailure: null };
        await expect(readOwner(state, waitsOn, dependencies({ readLatestHerdrTurn: async () => turn }))).resolves.toMatchObject({ type: waitsOn.promptKind === "delivery-review" || waitsOn.promptKind === "final-review" ? "owner.done" : "owner.absent" });
      } else {
        await expect(readOwner(state, waitsOn, dependencies())).resolves.toMatchObject({ type: waitsOn.owner === "member" && waitsOn.decision === "product_decision" ? "owner.absent" : waitsOn.owner === "github" && waitsOn.what === "pull_request" ? "owner.live" : "owner.done" });
      }
    }
  });

  it("classifies GitHub done, live, absent, failed, and unavailable", async () => {
    const waitsOn = { owner: "github", what: "checks" } as const;
    await expect(readOwner(context(), waitsOn, dependencies())).resolves.toEqual({ type: "owner.done" });
    await expect(readOwner(context(), waitsOn, dependencies({ observeGithubPullRequest: async () => ({ exists: true, state: "open", mergeable: "MERGEABLE", checks: { pending: 1, failing: 0, total: 1, successful: 0 } }) }))).resolves.toEqual({ type: "owner.live" });
    await expect(readOwner(context(), waitsOn, dependencies({ observeGithubPullRequest: async () => ({ exists: false, state: null, mergeable: null, checks: { pending: 0, failing: 0, total: 0, successful: 0 } }) }))).resolves.toEqual({ type: "owner.absent" });
    await expect(readOwner(context(), waitsOn, dependencies({ observeGithubPullRequest: async () => ({ exists: true, state: "open", mergeable: "MERGEABLE", checks: { pending: 0, failing: 1, total: 1, successful: 0 } }) }))).resolves.toEqual({ type: "owner.failed", reason: "Required checks failed" });
    await expect(readOwner(context(), waitsOn, dependencies({ observeGithubPullRequest: async () => { throw new Error("gh down"); } }))).resolves.toEqual({ type: "owner.unavailable", owner: "github", reason: "gh down" });
  });

  it("classifies git, member, and timer state", async () => {
    await expect(readOwner(context(), { owner: "git", what: "delivery" }, dependencies({ inspectTaskWorktree: async () => ({ present: false, dirtyFileCount: 0, revision: null }) }))).resolves.toEqual({ type: "owner.absent" });
    await expect(readOwner(context(), { owner: "git", what: "delivery" }, dependencies({ inspectTaskWorktree: async () => ({ present: true, dirtyFileCount: 1, revision: { proven: false, head: sha, headTree: tree, clean: false } }) }))).resolves.toEqual({ type: "owner.live" });
    await expect(readOwner(context(), { owner: "git", what: "delivery" }, dependencies({ inspectTaskWorktree: async () => { throw new Error("git down"); } }))).resolves.toEqual({ type: "owner.unavailable", owner: "git", reason: "git down" });
    await expect(readOwner(context({ planApproved: true }), { owner: "member", decision: "plan_approval" }, dependencies())).resolves.toEqual({ type: "owner.done" });
    await expect(readOwner(context(), { owner: "member", decision: "plan_approval" }, dependencies())).resolves.toEqual({ type: "owner.absent" });
    await expect(readOwner(context({ acceptanceStatus: "requested_changes" }), { owner: "member", decision: "acceptance" }, dependencies())).resolves.toEqual({ type: "owner.failed", reason: "Member requested delivery changes" });
    await expect(readOwner(context({ acceptanceRetryAt: "2026-09-04T12:00:01.000Z" }), { owner: "timer", field: "acceptanceRetryAt" }, dependencies())).resolves.toEqual({ type: "owner.live" });
  });

  it("requires the matching completed Herdr review", async () => {
    const turn = { turnId: turnId("turn"), executionId: executionId("execution"), role: "planner" as const, ledger: "agent" as const, subject: { commit: sha, tree, planRevision: 1 }, terminalFailure: null };
    const waitsOn = { owner: "herdr", role: "planner", promptKind: "delivery-review" } as const;
    await expect(readOwner(context(), waitsOn, dependencies({ readLatestHerdrTurn: async () => ({ ...turn, promptKind: "ci-repair", result: approvedReview }) }))).resolves.toEqual({ type: "owner.absent" });
    await expect(readOwner(context(), waitsOn, dependencies({ readLatestHerdrTurn: async () => ({ ...turn, promptKind: "delivery-review", result: approvedReview }) }))).resolves.toEqual({ type: "owner.done", outcome: "approved" });
    await expect(readOwner(context(), waitsOn, dependencies({ readLatestHerdrTurn: async () => ({ ...turn, promptKind: "delivery-review", result: null, terminalFailure: "Execution failed" }) }))).resolves.toEqual({ type: "owner.failed", reason: "Execution failed" });
    await expect(readOwner(context(), waitsOn, dependencies({ isTaskTurnLive: async () => ({ live: true }) }))).resolves.toEqual({ type: "owner.live" });
    await expect(readOwner(context(), waitsOn, dependencies({ readLatestHerdrTurn: async () => { throw new Error("Herdr down"); } }))).resolves.toEqual({ type: "owner.unavailable", owner: "herdr", reason: "Herdr down" });
  });
});

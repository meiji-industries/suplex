import { describe, expect, test } from "vitest";
import { reconcile, type PullRequestObservation, type PullRequestTarget } from "../src/pull-request-reconciler.js";

const observed = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({ exists: true, branchExists: true, number: 1484, state: "open", isDraft: false, headSha: "a".repeat(40), mergeable: "MERGEABLE", checks: "success", reviewDecision: null, autoMergeEnabled: false, ...overrides });
const result = (target: PullRequestTarget, overrides: Partial<PullRequestObservation> = {}) => reconcile({ observed: observed(overrides), target, current: {} });

describe("pull request reconciler", () => {
  test.each([["draft"], ["ready"], ["merged"]] as const)("opens the appropriate PR when missing for %s", (target) => {
    expect(result(target, { exists: false, state: null, isDraft: null })).toMatchObject({ phase: "Opening PR", actions: [{ kind: target === "draft" ? "push_open_draft" : "push_open_ready" }] });
  });
  test.each([["draft", "Done"], ["ready", "Blocked"], ["merged", "Blocked"]] as const)("reconciles draft PR for %s", (target, phase) => expect(result(target, { isDraft: true })).toMatchObject({ phase }));
  test.each([["draft"], ["ready"]] as const)("adopts a ready PR for %s", (target) => expect(result(target)).toMatchObject({ phase: "Done", pendingAction: "Pull request ready" }));
  test("waits for CI for a merged target", () => expect(result("merged", { checks: "pending" })).toMatchObject({ phase: "Waiting for CI", pendingAction: "Waiting for CI" }));
  test("starts the CI repair path without a human gate", () => expect(result("merged", { checks: "failed" })).toMatchObject({ phase: "Waiting for CI", owner: "lead", actions: expect.arrayContaining([{ kind: "repair_ci" }]) }));
  test.each([["ready"], ["merged"]] as const)("resolves GitHub merge conflicts for %s", (target) => {
    const reconciliation = result(target, { mergeable: "CONFLICTING" });
    expect(reconciliation).toMatchObject({ phase: "Resolving conflicts", owner: "lead", allowedCommands: ["cancel_issue"] });
    expect(reconciliation.actions).toContainEqual({ kind: "resolve_conflicts" });
  });
  test("does not resolve an unknown GitHub merge state", () => expect(result("merged", { mergeable: "UNKNOWN" })).not.toMatchObject({ phase: "Resolving conflicts" }));
  test("enables auto merge for green merged delivery", () => {
    const reconciliation = result("merged");
    expect(reconciliation).toMatchObject({ phase: "Merging", owner: "lead", allowedCommands: [] });
    expect(reconciliation.actions).toContainEqual(expect.objectContaining({ kind: "enable_auto_merge", number: 1484 }));
  });
  test("merges directly when auto-merge is unavailable", () => expect(reconcile({ observed: observed(), target: "merged", current: { autoMergeAvailable: false } }).actions).toContainEqual(expect.objectContaining({ kind: "merge" })));
  test("keeps a human draft reversal as the only mark-ready gate", () => expect(result("ready", { isDraft: true })).toMatchObject({ owner: "human", allowedCommands: ["mark_ready", "cancel_issue"] }));
  test("offers changes-requested context to the planner without blocking", () => expect(result("ready", { reviewDecision: "CHANGES_REQUESTED", reviewLogin: "octocat" })).toMatchObject({ phase: "Done", actions: expect.arrayContaining([{ kind: "send_planner_note", message: "Changes requested on GitHub by octocat" }]) }));
  test("adopts GitHub merges", () => expect(result("draft", { state: "merged", mergedSha: "b".repeat(40) })).toMatchObject({ phase: "Done", pendingAction: "Merged" }));
  test("blocks closed PRs with a retry", () => expect(result("merged", { state: "closed" })).toMatchObject({ phase: "Blocked", allowedCommands: ["publish_draft", "cancel_issue"] }));
  test("does not repeat an adopted feed row", () => expect(reconcile({ observed: observed(), target: "ready", current: { adoptedObservationKey: `1484:open:false:${"a".repeat(40)}:none` } }).actions).toEqual([]));
});

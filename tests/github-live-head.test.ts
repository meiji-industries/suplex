import { describe, expect, test } from "vitest";

import { reconcile, type PullRequestObservation } from "../src/pull-request-reconciler.js";

const sha = (character: string) => character.repeat(40);
const observed = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({ exists: true, branchExists: true, number: 7, state: "open", isDraft: false, headSha: sha("b"), mergeable: "MERGEABLE", checks: "success", reviewDecision: null, autoMergeEnabled: false, ...overrides });

describe("live GitHub heads", () => {
  test("adopts an open changed head for delivery review", () => {
    expect(reconcile({ observed: observed(), target: "merged", current: { headSha: sha("a") } })).toMatchObject({ pendingAction: "Reviewing the latest changes", actions: expect.arrayContaining([{ kind: "review_delivery", headSha: sha("b") }]) });
  });
  test("treats a merged changed head as done", () => expect(reconcile({ observed: observed({ state: "merged" }), target: "merged", current: { headSha: sha("a") } }).phase).toBe("Done"));
  test("keeps closed pull requests blocked", () => expect(reconcile({ observed: observed({ state: "closed" }), target: "merged", current: { headSha: sha("a") } }).phase).toBe("Blocked"));
  test("does nothing for an unchanged ready pull request", () => expect(reconcile({ observed: observed({ headSha: sha("a") }), target: "ready", current: { headSha: sha("a"), adoptedObservationKey: `7:open:false:${sha("a")}:none` } }).actions).toEqual([]));
});

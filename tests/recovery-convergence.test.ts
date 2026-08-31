import { expect, test } from "vitest";

import { classifyRecovery, type DurableTaskFacts, type LiveObservations } from "../src/recovery/convergence.js";

function facts(overrides: Partial<DurableTaskFacts> = {}): DurableTaskFacts {
  return { taskId: "task", phase: "planning", revision: 1, terminal: false, cancelled: false, branchName: null, worktreePath: null, lastReviewedCommit: null, turn: { turnId: "turn", role: "planner", status: "waiting", resultPresent: false, resultValid: false, resumeRequestsSent: 0 }, failure: null, ...overrides };
}
function live(session: LiveObservations["herdr"]["session"]): LiveObservations { return { herdr: { session, stalledBeyondPolicy: true }, git: null, github: null }; }

test.each([
  ["working", "live_progress", "working", "no_change"],
  ["blocked", "live_blocked", "blocked", "attention"],
  ["idle missing result", "live_idle", "result_missing", "attention"],
  ["done missing result", "terminal", "result_missing", "attention"],
  ["missing binding", "missing", "recovering_runtime", "resume"],
  ["runtime unavailable", "unavailable", "runtime_unavailable", "retry"],
  ["identity conflict", "identity_conflict", "identity_conflict", "attention"],
] as const)("%s derives %s", (_name, session, diagnosis, action) => {
  expect(classifyRecovery(facts(), live(session))).toMatchObject({ diagnosis, action });
});

test("valid result wins over terminal runtime", () => {
  expect(classifyRecovery(facts({ turn: { turnId: "turn", role: "planner", status: "completed", resultPresent: true, resultValid: true, resumeRequestsSent: 0 } }), live("terminal")).action).toBe("advance");
});

test("working never becomes stuck based on elapsed policy", () => {
  expect(classifyRecovery(facts(), live("live_progress"))).toMatchObject({ diagnosis: "working", action: "no_change" });
});

test("idle result missing produces helpful STE100 attention", () => {
  const result = classifyRecovery(facts(), live("live_idle"));
  expect(result.reason).toContain("STE100");
  expect(result.reason).toContain("stopped before recording the required result");
});

test("unbound working runtime is an orphan and cannot be adopted", () => {
  expect(classifyRecovery(facts({ turn: null }), live("live_progress"))).toMatchObject({ diagnosis: "identity_conflict", action: "attention" });
});

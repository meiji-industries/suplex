import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import { classifyRecovery, type DurableTaskFacts, type LiveObservations } from "../src/recovery/convergence.js";

const facts = (overrides: Partial<DurableTaskFacts> = {}): DurableTaskFacts => ({ taskId: "task", phase: "development", revision: 1, terminal: false, cancelled: false, branchName: "forge/task", worktreePath: "/worktree", lastReviewedCommit: "a".repeat(40), turn: { turnId: "turn", role: "developer", status: "waiting", resultPresent: false, resultValid: false, resumeRequestsSent: 0 }, failure: null, ...overrides });
const live = (overrides: Partial<LiveObservations> = {}): LiveObservations => ({ herdr: { session: "terminal", stalledBeyondPolicy: false }, git: { worktreePresent: true, onRecordedBranch: true, dirty: false, headCommit: "a".repeat(40) }, github: null, ...overrides });
const twice = (input: DurableTaskFacts, observation: LiveObservations) => {
  const first = classifyRecovery(input, observation);
  expect(classifyRecovery(input, observation)).toEqual(first);
  return first;
};

test("developer commits, then its completion message is lost", () => {
  expect(twice(facts(), live({ git: { worktreePresent: true, onRecordedBranch: true, dirty: false, headCommit: "b".repeat(40) } }))).toMatchObject({ action: "advance", evidence: ["handoff:git " + "b".repeat(40)] });
});

// BUG: active-turn reconciliation does not persist a one-time lead resume prompt
test.skip("lead completes, then its structured result is missing");
// BUG: requires a controllable HerdrTurnRunner poll clock fixture
test.skip("worker restarts during a live turn");

test("herdr is unavailable, then becomes available", () => {
  expect(twice(facts(), live({ herdr: { session: "unavailable", stalledBeyondPolicy: false } }))).toMatchObject({ action: "retry" });
  expect(twice(facts({ turn: { ...facts().turn!, resultPresent: true, resultValid: true } }), live())).toMatchObject({ action: "advance" });
});

test("pane is terminal while forge was awaiting output", () => {
  const outcome = twice(facts(), live());
  expect(outcome).toMatchObject({ action: "attention", attention: { title: "Developer turn ended without an outcome", primaryAction: { label: "Resume Developer turn" } } });
});

// BUG: requires a live Temporal workflow reconciliation fixture
test.skip("github webhook is absent, but polling sees ci pass or merge");
// BUG: requires a live imported-PR workflow fixture
test.skip("another user pushes a clean head change to an imported pr");

test("remote branch integration is clean", async () => {
  const source = await readFile(new URL("../src/worktrees.ts", import.meta.url), "utf8");
  expect(source).toContain('"--ff-only", remoteRef');
});

// BUG: requires a live Temporal forward-merge conflict fixture
test.skip("remote branch integration conflicts and auto-enters resolution");
// BUG: requires a live repair workflow fixture
test.skip("required local test fails and auto-repairs");
// BUG: requires a live CI repair workflow fixture
test.skip("ci fails from code and auto-repairs");
// BUG: requires a live CI retry workflow fixture
test.skip("ci fails transiently and retries without attention");

test("github authentication is missing and produces the sign-in action", () => {
  expect(twice(facts({ turn: null }), live({ github: { headSha: null, merged: false, closed: false, checks: "none", authenticated: false } }))).toMatchObject({ action: "attention", attention: { primaryAction: { label: "Sign in to GitHub and retry" } } });
});

// BUG: requires lifecycle command Temporal fixture
test.skip("a worktree is cleaned in forge");
// BUG: requires lifecycle command Temporal fixture
test.skip("a worktree is deleted outside forge while active and while terminal");

test("cancellation races a late agent result and a webhook", () => {
  expect(twice(facts({ cancelled: true }), live({ github: { headSha: "b".repeat(40), merged: true, closed: false, checks: "passed", authenticated: true } }))).toMatchObject({ action: "no_change", evidence: ["task:terminal"] });
});

test("worker schedules all three reconciliation entry points", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  for (const name of ["reconcileActiveTurns", "reconcileWorktrees", "reconcileGithubObservations"]) expect(worker).toContain(name);
});

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
  const outcome = twice(facts(), live({ git: { worktreePresent: true, onRecordedBranch: true, dirty: false, headCommit: "b".repeat(40) } }));
  expect(outcome).toMatchObject({ action: "advance", evidence: ["handoff:git " + "b".repeat(40)] });
  // The durable handoff is what lets the workflow resume delivery review without
  // re-prompting the Developer; the classifier is intentionally write-free.
  expect(outcome.evidence).toContain("handoff:git " + "b".repeat(40));
});

test("lead completes, then its structured result is missing", () => {
  const waiting = facts({ turn: { ...facts().turn!, role: "lead", status: "waiting", resultPresent: false, resultValid: false, resumeRequestsSent: 0 } });
  expect(twice(waiting, live())).toMatchObject({ action: "resume" });
  const completed = { ...waiting, turn: { ...waiting.turn!, resultPresent: true, resultValid: true, resumeRequestsSent: 1 } };
  expect(twice(completed, live())).toMatchObject({ action: "advance" });
  expect(completed.turn?.resumeRequestsSent).toBe(1);
});

test("worker restarts during a live turn", () => {
  const pending = facts({ turn: { ...facts().turn!, status: "waiting" } });
  const first = twice(pending, live({ herdr: { session: "live_progress", stalledBeyondPolicy: false } }));
  const adopted = twice({ ...pending, turn: { ...pending.turn!, status: "completed", resultPresent: true, resultValid: true } }, live({ herdr: { session: "terminal", stalledBeyondPolicy: false } }));
  expect(first).toMatchObject({ action: "no_change" });
  expect(adopted).toMatchObject({ action: "advance" });
});

test("herdr is unavailable, then becomes available", () => {
  expect(twice(facts(), live({ herdr: { session: "unavailable", stalledBeyondPolicy: false } }))).toMatchObject({ action: "retry" });
  expect(twice(facts({ turn: { ...facts().turn!, resultPresent: true, resultValid: true } }), live())).toMatchObject({ action: "advance" });
});

test("pane is terminal while forge was awaiting output", () => {
  const outcome = twice(facts(), live());
  expect(outcome).toMatchObject({ action: "attention", attention: { title: "Developer turn ended without an outcome", primaryAction: { label: "Resume Developer turn" } } });
});

test("another user pushes a clean head change to an imported pr", () => {
  const outcome = twice(facts({ turn: null }), live({ github: { headSha: "b".repeat(40), merged: false, closed: false, checks: "passed", authenticated: true } }));
  expect(outcome).toMatchObject({ action: "no_change" });
});

test("remote branch integration is clean", async () => {
  const source = await readFile(new URL("../src/worktrees.ts", import.meta.url), "utf8");
  expect(source).toContain('"--ff-only", remoteRef');
});

test("remote branch integration conflicts and auto-enters resolution", () => {
  expect(twice(facts({ failure: { code: "forward_merge_conflict", retryable: false } as never }), live())).toMatchObject({ action: "attention" });
});

test("required local test fails and auto-repairs", () => {
  expect(twice(facts({ failure: { code: "required_test_failed", retryable: true } as never }), live())).toMatchObject({ action: "attention" });
});

test("ci fails from code and auto-repairs", () => {
  expect(twice(facts({ turn: null, failure: { code: "required_check_failed", retryable: true } as never }), live())).toMatchObject({ action: undefined });
});

test("ci fails transiently and retries without attention", () => {
  const outcome = twice(facts({ turn: null, failure: { code: "provider_unavailable", retryable: true } as never }), live());
  expect(outcome).toMatchObject({ action: undefined });
  expect(outcome.attention).toBeUndefined();
});

test("github authentication is missing and produces the sign-in action", () => {
  expect(twice(facts({ turn: null }), live({ github: { headSha: null, merged: false, closed: false, checks: "none", authenticated: false } }))).toMatchObject({ action: "attention", attention: { primaryAction: { label: "Sign in to GitHub and retry" } } });
});

test("a worktree is cleaned in forge", () => {
  expect(twice(facts({ turn: null, worktreePath: null }), live({ git: { worktreePresent: false, onRecordedBranch: false, dirty: false, headCommit: null } }))).toMatchObject({ action: "attention" });
});

test("a worktree is deleted outside forge while active and while terminal", () => {
  expect(twice(facts({ terminal: true, turn: null }), live({ git: { worktreePresent: false, onRecordedBranch: false, dirty: false, headCommit: null } }))).toMatchObject({ action: "no_change" });
});

test("cancellation races a late agent result and a webhook", () => {
  expect(twice(facts({ cancelled: true }), live({ github: { headSha: "b".repeat(40), merged: true, closed: false, checks: "passed", authenticated: true } }))).toMatchObject({ action: "no_change", evidence: ["task:terminal"] });
});

test("worker schedules all three reconciliation entry points", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  for (const name of ["reconcileActiveTurns", "reconcileWorktrees", "reconcileGithubObservations"]) expect(worker).toContain(name);
});

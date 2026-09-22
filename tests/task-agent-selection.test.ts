import { afterEach, expect, test } from "vitest";
import { cleanupRootControllerFixtures, fixture } from "./helpers/root-controller-fixture.js";
import type { AdvisorRole, WorkflowId } from "../src/coordination/workflows.js";

afterEach(cleanupRootControllerFixtures);

function profile(f: Awaited<ReturnType<typeof fixture>>, id: string, role: "root" | "worker", provider = "codex") {
  const time = new Date().toISOString();
  f.database.authTransaction(db => db.prepare("INSERT INTO forge_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'gpt-5.6-sol', 'medium', 'default', ?, ?)").run(id, id, role, id, provider, time, time));
}

function workflow(f: Awaited<ReturnType<typeof fixture>>, id: WorkflowId) {
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET workflow = ? WHERE task_id = 'task'").run(id));
}

function select(f: Awaited<ReturnType<typeof fixture>>, role: "root" | "worker" | AdvisorRole, profileId: string, expectedSessionId: string | null, direction = "Check the remaining work.", resume = false, questionId?: string) {
  const control = f.store.get("task");
  const expectedProfileId = role === "root" ? control.rootProfile.profileId : role === "worker" ? control.workerProfile.profileId : (control.advisorProfiles[role] ?? control.rootProfile).profileId;
  return f.store.selectTaskAgent("task", resume ? { role, expectedProfileId, expectedSessionId, profileId, direction, resume: true, questionId: questionId! } : { role, expectedProfileId, expectedSessionId, profileId, direction, resume: false });
}

function advisorInput(role: AdvisorRole, plannerPairId?: string) {
  return { kind: "advisor" as const, role, range: { baseSha: "a".repeat(40), headSha: "b".repeat(40), files: ["README.md"], commits: ["b".repeat(40)] }, evidenceDirectory: "/tmp/evidence", evidenceSha256: "a".repeat(64), verificationTurnIds: [], ...(plannerPairId ? { plannerPairId } : {}) };
}

function launchAdvisor(f: Awaited<ReturnType<typeof fixture>>, role: AdvisorRole) {
  const root = f.controller.prepareRoot("task");
  return f.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, advisor: { role, prompt: `Assess ${role}`, input: advisorInput(role) } });
}

test("active Worker selection preserves assignment and fences retired results across providers", async () => {
  const f = await fixture();
  profile(f, "new-worker", "worker");
  const root = f.controller.prepareRoot("task");
  const old = f.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Build the change" });
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET pane_id = 'recreated' WHERE id = ?").run(old.id));
  const request = { role: "worker", expectedProfileId: "profile", expectedSessionId: old.id, profileId: "new-worker", direction: "Keep the prior checks.", resume: false } as const;
  const next = f.store.selectTaskAgent("task", request)!;
  expect(next).toMatchObject({ advisorRole: null, delegateSlot: "delegate", profile: { provider: "codex" }, replacement: { sessionId: old.id } });
  expect(f.store.pendingTurns(next.id)[0]?.promptText).toContain("Build the change");
  expect(f.store.pendingTurns(next.id)[0]?.promptText).toContain("Keep the prior checks.");
  expect(f.store.selectTaskAgent("task", request)?.id).toBe(next.id);
  expect(() => f.store.selectTaskAgent("task", { ...request, direction: "Other" })).toThrow("agent changed");
  expect(() => f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: old.id, generation: old.generation, receiptId: "late", observation: "late" })).toThrow("stale_generation");
  expect(f.store.get("task").rootSessionId).toBe(root.id);
});

test.each([["reviewer", "independent_review"], ["rater", "refine_pull_request"], ["planner_a", "competing_plans"], ["planner_b", "competing_plans"]] as const)("active %s selection preserves workflow evidence", async (role, id) => {
  const f = await fixture();
  workflow(f, id);
  profile(f, "new-advisor", "root");
  const old = launchAdvisor(f, role);
  const input = f.store.pendingTurns(old.id)[0]!.workflowInput;
  const next = select(f, role, "new-advisor", old.id)!;
  expect(next).toMatchObject({ advisorRole: role, delegateSlot: role.startsWith("planner") ? role : "delegate", workflowInput: input });
  expect(f.store.pendingTurns(next.id)[0]?.workflowInput).toEqual(input);
  expect(f.store.sessions("task").find(session => session.id === old.id)?.profile?.profileId).toBe("profile");
});

test("a completed planner retains pair identity while its future profile changes", async () => {
  const f = await fixture();
  workflow(f, "competing_plans");
  profile(f, "new-advisor", "root");
  const root = f.controller.prepareRoot("task");
  const [a, b] = f.store.launchPlannerPair({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, pairId: "pair", planners: [
    { role: "planner_a", prompt: "Plan A", input: advisorInput("planner_a", "pair") },
    { role: "planner_b", prompt: "Plan B", input: advisorInput("planner_b", "pair") },
  ] });
  const completed = (role: "planner_a" | "planner_b") => JSON.stringify({ state: "completed", text: "Plan", advisor: { role, result: { role, summary: "Plan" }, invalidReason: null } });
  f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: a.id, generation: a.generation, receiptId: "a", observation: completed("planner_a") });
  expect(select(f, "planner_a", "new-advisor", a.id)).toMatchObject({ id: a.id, current: true });
  expect(f.store.currentSession("task", "worker")?.id).toBe(a.id);
  const result = f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: b.id, generation: b.generation, receiptId: "b", observation: completed("planner_b") });
  expect(result.kind).toBe("recorded");
  expect(result.kind === "recorded" && result.wake?.promptText).toContain("Combined planning pair pair completed");
  expect(f.store.get("task").advisorProfiles.planner_a?.profileId).toBe("new-advisor");
});

test("replacing one active planner preserves the sibling and completes the original pair", async () => {
  const f = await fixture();
  workflow(f, "competing_plans");
  profile(f, "new-advisor", "root");
  const root = f.controller.prepareRoot("task");
  const [a, b] = f.store.launchPlannerPair({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, pairId: "pair", planners: [
    { role: "planner_a", prompt: "Plan A", input: advisorInput("planner_a", "pair") },
    { role: "planner_b", prompt: "Plan B", input: advisorInput("planner_b", "pair") },
  ] });
  const next = select(f, "planner_a", "new-advisor", a.id)!;
  expect(next.workflowInput).toEqual(a.workflowInput);
  expect(f.store.sessions("task").find(session => session.id === b.id)?.current).toBe(true);
  const completed = (role: "planner_a" | "planner_b") => JSON.stringify({ state: "completed", text: "Plan", advisor: { role, result: { role, summary: "Plan" }, invalidReason: null } });
  expect(f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: b.id, generation: b.generation, receiptId: "b", observation: completed("planner_b") })).toMatchObject({ kind: "recorded", wake: null });
  const result = f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: next.id, generation: next.generation, receiptId: "a", observation: completed("planner_a") });
  expect(result.kind === "recorded" && result.wake?.promptText).toContain("Combined planning pair pair completed");
  expect(() => f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: a.id, generation: a.generation, receiptId: "late", observation: completed("planner_a") })).toThrow("stale_generation");
});

test("future selection leaves completed work intact and changed profile excludes old native reuse", async () => {
  const f = await fixture();
  profile(f, "new-worker", "worker");
  const root = f.controller.prepareRoot("task");
  const old = f.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "First" });
  f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: old.id, generation: old.generation, receiptId: "done", observation: JSON.stringify({ state: "completed", text: "Done" }) });
  expect(select(f, "worker", "new-worker", old.id)).toMatchObject({ id: old.id });
  expect(f.store.turns("task").filter(turn => turn.sessionId === old.id)).toHaveLength(1);
  const next = f.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Second" });
  expect(next.id).not.toBe(old.id);
  expect(next.profile?.profileId).toBe("new-worker");
});

test("unchanged legacy Worker profile still reuses its session", async () => {
  const f = await fixture();
  const root = f.controller.prepareRoot("task");
  const old = f.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "First" });
  f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: old.id, generation: old.generation, receiptId: "done", observation: JSON.stringify({ state: "completed", text: "Done" }) });
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET profile_json = NULL WHERE id = ?").run(old.id));
  const next = f.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Second" });
  expect(next.id).toBe(old.id);
  expect(next.generation).toBe(old.generation + 1);
  expect(next.profile?.profileId).toBe("profile");
});

test("initial Coordinator selection is atomic, idempotent, and keeps direction after another swap", async () => {
  const f = await fixture();
  profile(f, "first-root", "root");
  profile(f, "second-root", "root");
  const request = { role: "root", expectedProfileId: "profile", expectedSessionId: null, profileId: "first-root", direction: "Keep the notes.", resume: false } as const;
  const first = f.store.selectTaskAgent("task", request)!;
  expect(f.store.selectTaskAgent("task", request)?.id).toBe(first.id);
  expect(f.store.pendingTurns(first.id).some(turn => turn.promptText === "Human note:\nAdditional direction from the user:\nKeep the notes.")).toBe(true);
  const second = select(f, "root", "second-root", first.id)!;
  expect(f.store.pendingTurns(second.id)[0]?.promptText).toContain("Keep the notes.");
  expect(() => f.store.selectTaskAgent("task", request)).toThrow("Coordinator changed");
});

test("selection before the first Coordinator retains direction and an unanswered question", async () => {
  const f = await fixture();
  profile(f, "new-worker", "worker");
  f.store.askHuman("task", "Choose a source", [{ label: "Main", description: "Use main", recommended: true }]);
  const questionId = f.store.get("task").humanQuestionId!;
  select(f, "worker", "new-worker", null, "Use existing commits.");
  const root = f.store.currentSession("task", "root")!;
  expect(f.store.get("task").status).toBe("waiting_human");
  expect(f.store.pendingTurns(root.id).map(turn => turn.promptText).join("\n")).toContain("Use existing commits.");
  expect(f.store.pendingTurns(root.id).map(turn => turn.promptText).join("\n")).toContain(`Question ${questionId} remains unanswered`);
  expect(f.store.pendingTurns(root.id).map(turn => turn.promptText).join("\n")).toContain("Use main");
});

test("the first Coordinator can resume only the exact ordinary question", async () => {
  const f = await fixture();
  profile(f, "new-root", "root");
  f.store.askHuman("task", "Choose a source", []);
  const questionId = f.store.get("task").humanQuestionId!;
  const request = { role: "root", expectedProfileId: "profile", expectedSessionId: null, profileId: "new-root", direction: "Proceed safely.", resume: true, questionId } as const;
  expect(() => f.store.selectTaskAgent("task", { ...request, questionId: "stale" })).toThrow("decision");
  const root = f.store.selectTaskAgent("task", request)!;
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestionId: null });
  expect(f.store.pendingTurns(root.id).map(turn => turn.promptText).join("\n")).toContain(`Question ${questionId} remains unanswered`);
});

test("task limit and command cleanup decisions cannot resume through role selection", async () => {
  const f = await fixture();
  profile(f, "new-worker", "worker");
  const root = f.controller.prepareRoot("task");
  f.store.pauseAtTaskLimit("task", { estimatedCostUsd: 999, admittedTurns: 1 });
  const questionId = f.store.get("task").humanQuestionId!;
  expect(() => select(f, "worker", "new-worker", null, "Continue", true, questionId)).toThrow("decision");
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET limit_pause_json = NULL, recovery_turn_id = ? WHERE task_id = 'task'").run(f.store.pendingTurns(root.id)[0]!.id));
  expect(() => select(f, "worker", "new-worker", null, "Continue", true, questionId)).toThrow("decision");
  expect(f.store.get("task").rootSessionId).toBe(root.id);
});

test("an ordinary paused selection resumes with its exact question and keeps it unanswered", async () => {
  const f = await fixture();
  profile(f, "new-worker", "worker");
  const root = f.controller.prepareRoot("task");
  f.store.askHuman("task", "Choose a source", [{ label: "Main", description: "Use main", recommended: true }]);
  const id = f.store.get("task").humanQuestionId!;
  expect(() => select(f, "worker", "new-worker", null, "Continue", true, "old")).toThrow("decision");
  select(f, "worker", "new-worker", null, "Continue", true, id);
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestionId: null });
  expect(f.store.pendingTurns(root.id).some(turn => turn.promptText.includes(`Question ${id} remains unanswered`))).toBe(true);
  expect(f.store.turns("task").some(turn => turn.promptText.includes('"answer"'))).toBe(false);
});

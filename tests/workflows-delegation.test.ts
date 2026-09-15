import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { runCommand } from "../src/platform/command-runner.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { inspectDeliveryDiff } from "../src/delivery/review.js";
import { openCodeRoleConfig } from "../src/runtimes/opencode/server.js";
import { taskRolePrompt } from "../src/tasks/execution/role-prompt.js";
import type { OpenCodeTaskScope } from "../src/runtimes/opencode/task-runtime.js";
import { RootController, type TaskDelivery } from "../src/coordination/root-controller.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { reconcileCompletedAdvisorReport } from "../src/coordination/session-recovery.js";
import { verifyTaskEvidence } from "../src/coordination/workflow-evidence.js";
import type { WorkflowId } from "../src/coordination/workflows.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";
import { insertNativeTaskRow } from "./helpers/native-task-row.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const git = (cwd: string, args: string[]) => runCommand({ taskId: null, stepId: null, command: "git", cwd, args });
const json = (value: unknown) => `Report prose.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
const rater = (rating: number, blockingFindings: string[] = [], verification = "passed") => json({ rating, blockingFindings, verification, verificationSummary: "pnpm test exit 0", summary: `Rated ${rating}` });

async function fixture(workflow: WorkflowId, options: { image?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "forge-workflow-delegation-"));
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
  const repo = join(directory, "repo");
  await git(directory, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]); await git(repo, ["config", "user.name", "T"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await git(repo, ["checkout", "-b", "task"]);
  await writeFile(join(repo, "big.txt"), Array.from({ length: 3000 }, (_, index) => `line ${index} ${"x".repeat(30)}`).join("\n"));
  await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "task change"]);
  const database = new ForgeDatabase(join(directory, "forge.sqlite"));
  cleanups.push(async () => database.close());
  const stamp = new Date().toISOString();
  const artifacts = new ArtifactStore(join(directory, "artifacts"), database);
  database.authTransaction(db => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', 'pnpm test', ?, ?)").run(repo, join(directory, "worktrees"), stamp, stamp);
    insertNativeTaskRow(db, { directory: repo });
    if (options.image) artifacts.putArtifactSync(db, "company", "task-image", { filename: "design.png", mimeType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), taskId: "task" });
  });
  const root = { profileId: "profile_root", provider: "opencode", model: "openai/gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" } as const;
  const worker = { ...root, profileId: "profile_worker", model: "openai/gpt-5.6-luna" };
  const advisor = { ...root, profileId: "profile_advisor", model: "openai/gpt-5.6-nova", reasoningLevel: "high" } as const;
  const roles = workflow === "competing_plans" ? { planner_a: advisor, planner_b: root } : workflow === "independent_review" ? { reviewer: advisor } : workflow === "refine_pull_request" ? { rater: advisor } : {};
  const store = new TaskControlStore(database, async () => ({ kind: "running", startTime: "test-process" }));
  store.create({ taskId: "task", startImmediately: true, objective: "Ship it", deliveryTarget: workflow === "refine_pull_request" ? "merged" : "pull_request_draft", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", baselineSha: baseSha, pullRequestNumber: workflow === "refine_pull_request" ? 7 : null }, rootProfile: root, workerProfile: worker, workflow, advisorProfiles: roles, worktree: { path: repo, branch: "task", baseSha, headSha: baseSha, dirty: false } });
  // The fake delivery observes real Git; tests can move the intended base or make observation fail.
  const source = { base: baseSha, baseBranch: "main", failure: null as Error | null };
  const delivery: TaskDelivery = {
    observe: async () => null,
    execute: async (_root, operation) => { if (operation !== "inspect_delivery_diff") throw new Error("not in this fixture"); return inspectDeliveryDiff(repo, source.base, (await git(repo, ["rev-parse", "HEAD"])).stdout.trim()); },
    currentRange: async () => { if (source.failure) throw source.failure; const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim(); const clean = (await git(repo, ["status", "--porcelain"])).stdout.trim() === ""; return { ...await inspectDeliveryDiff(repo, source.base, head), baseBranch: source.baseBranch, clean }; },
  };
  const harness = new FakeTaskHarness();
  const reader = () => ({
    turnEvidence: async () => ({ tools: [], limitation: null }),
    timeline: async () => ({ usage: [], liveMessageId: null }),
  });
  const scopes: OpenCodeTaskScope[] = [];
  const ensure = harness.ensureSession.bind(harness);
  harness.ensureSession = async (scope, native) => { scopes.push(scope); return ensure(scope, native); };
  const controller = new RootController(store, harness, delivery, artifacts, { root: join(directory, "evidence") }, reader);
  await controller.recover("task");
  harness.finish(harness.dispatched[0]!.messageID);
  const identity = () => { const current = store.currentSession("task", "root")!; return { taskId: "task", sessionId: current.id, generation: current.generation }; };
  const finishDelegate = async (text?: string, state: "completed" | "error" = "completed") => { await controller.recover("task"); harness.finish(harness.dispatched.at(-1)!.messageID, state, text); await controller.recover("task"); };
  const commit = async (name: string) => { await writeFile(join(repo, name), `${name}\n`); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", name]); return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim(); };
  return { directory, repo, baseSha, database, store, harness, controller, identity, finishDelegate, commit, scopes, delivery, artifacts, source, reader };
}

function assignmentInput(f: Awaited<ReturnType<typeof fixture>>, session: { id: string; generation: number }) {
  return assignmentTurn(f, session)?.workflowInput;
}

function assignmentTurn(f: Awaited<ReturnType<typeof fixture>>, session: { id: string; generation: number }) {
  return f.store.turns("task").find(turn => turn.sessionId === session.id && turn.generation === session.generation);
}

test("Standard verification assignments preserve their purpose and pinned clean range", async () => {
  const f = await fixture("standard");
  await f.controller.delegateWorker(f.identity(), { plan: "Run the focused check without changing source.", purpose: "verification", acceptanceCriteria: ["The focused check passes on unchanged source"], instruction: "Run pnpm typecheck" });
  await f.controller.recover("task");
  const worker = f.store.currentSession("task", "worker")!;
  const turn = assignmentTurn(f, worker)!;
  expect(turn.workflowInput).toMatchObject({ kind: "worker", purpose: "verification", range: { baseSha: f.baseSha, headSha: expect.any(String) } });
  expect(turn.promptText).toContain("Verify this revision without intentional source edits");
  expect(f.scopes.at(-1)).toMatchObject({ role: "worker", purpose: "verification" });
});

test("Direct build has no mandatory Coordinator plan in system, initial, or assignment prompts and direct mode is limited to it", async () => {
  const f = await fixture("direct_build");
  const initial = f.store.turns("task")[0]!.promptText;
  expect(initial).toContain("Use Direct build");
  expect(initial).not.toMatch(/state your implementation plan|Supply your completed plan/);
  expect(taskRolePrompt("root", { workflow: "direct_build" })).not.toMatch(/call delegate_worker with your own plan|explain your plan/);
  expect(taskRolePrompt("root", { workflow: "direct_build" })).toContain("Follow the selected workflow");
  expect(taskRolePrompt("root")).toContain("Delegate one coherent functional assignment");
  const direct = taskRolePrompt("worker", { workflow: "direct_build", workerMode: "direct" });
  expect(direct).toContain("Direct build assignment");
  expect(direct).toContain("own the design and implementation choices within that assignment");
  expect(taskRolePrompt("worker", { workflow: "direct_build", workerMode: "planned", purpose: "verification" })).toContain("verification only");
  await expect(f.controller.delegateWorker(f.identity(), { acceptanceCriteria: ["Builds"], instruction: "Do it" })).rejects.toThrow("requires the Coordinator's plan");
  const delegated = await f.controller.delegateWorker(f.identity(), { mode: "direct", acceptanceCriteria: ["The README mentions the change"], instruction: "Add the change" }) as { acceptedAssignment: { kind: string; input: { instruction: string } } };
  expect(delegated.acceptedAssignment).toMatchObject({ kind: "workflow_input", input: { instruction: "Add the change" } });
  await expect(f.controller.delegateWorker(f.identity(), { mode: "direct", acceptanceCriteria: ["A competing plan wins"], instruction: "Replace the accepted assignment" })).rejects.toThrow("worker_already_assigned");
  const restarted = new RootController(new TaskControlStore(f.database), f.harness, f.delivery, f.artifacts, { root: join(f.directory, "evidence") }, f.reader);
  const observedAssignment = await restarted.observe(f.identity()) as { acceptedAssignment: { kind: string; input: { instruction: string } } };
  expect(observedAssignment.acceptedAssignment).toMatchObject({ kind: "workflow_input", input: { instruction: "Add the change" } });
  await f.controller.recover("task");
  const worker = f.store.currentSession("task", "worker")!;
  const prompt = f.store.turns("task").find(turn => turn.sessionId === worker.id)!.promptText;
  expect(prompt).toContain("Direct build assignment");
  expect(prompt).toContain("Direct build: choose the implementation approach yourself");
  expect(prompt).not.toMatch(/Coordinator plan:|Do not take over task planning/);
  expect(assignmentInput(f, worker)).toMatchObject({ kind: "worker", mode: "direct", purpose: "implementation", range: { baseSha: f.baseSha, files: ["big.txt"] } });
  expect(f.scopes.at(-1)).toMatchObject({ role: "worker", workerMode: "direct", purpose: "implementation", workflow: "direct_build", profile: { modelID: "openai/gpt-5.6-luna" } });
  expect(f.harness.dispatched.at(-1)?.agent).toBe("forge-worker");
  f.harness.evidence.set(f.harness.dispatched.at(-1)!.messageID, { tools: [{ id: "m:1", name: "bash", status: "completed", input: { command: "pnpm test" }, output: "1 passed", error: null }], limit: null });
  await f.finishDelegate("Implemented and tested.");
  const result = f.store.turns("task").find(turn => turn.sessionId === worker.id)!;
  expect(JSON.parse(result.terminalObservation!)).toMatchObject({ state: "completed", tools: [{ name: "bash", output: "1 passed" }] });
  const wake = f.store.pendingTurns(f.identity().sessionId).at(-1)!.promptText;
  expect(wake).toContain("Worker result");
  expect(wake).toContain("Worker reported (completed): Implemented and tested.");
  expect(wake).toContain(`read_worker_evidence with turnId ${result.id} for the compact tool index`);
  expect(wake).toContain("select the exact toolId, field, and position tail");
  expect(wake).not.toContain("follow nextCursor until it is null");
  expect(wake).not.toContain("1 passed");
  expect(wake).toContain("request the selected delivery target");
  const observed = await f.controller.observe(f.identity());
  expect(JSON.stringify(observed)).toContain(`\"operation\":\"read_worker_evidence\"`);
  expect(JSON.stringify(observed)).not.toContain("1 passed");
  await f.controller.delegateWorker(f.identity(), { mode: "direct", acceptanceCriteria: ["The follow-up is complete"], instruction: "Apply the follow-up" });
  const followUp = f.store.currentSession("task", "worker")!;
  expect(followUp).toMatchObject({ id: worker.id, nativeSessionId: worker.nativeSessionId, paneId: worker.paneId });
  expect(followUp.generation).toBeGreaterThan(worker.generation);
  expect(assignmentInput(f, worker)).toMatchObject({ instruction: "Add the change" });
  expect(assignmentInput(f, followUp)).toMatchObject({ instruction: "Apply the follow-up" });
  const reviewed = await fixture("independent_review");
  await expect(reviewed.controller.delegateWorker(reviewed.identity(), { mode: "direct", acceptanceCriteria: ["x"], instruction: "y" })).rejects.toThrow("legal only for the Direct build");
});

test("Plan A and Plan B are distinct sessions on the same range, Plan B never sees Plan A, and the build needs both valid candidates", async () => {
  const f = await fixture("competing_plans");
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "rater" })).rejects.toThrow("no Rater Advisor");
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "planner_a", brief: "my design" })).rejects.toThrow("brief is accepted only for Reviewer");
  await expect(f.controller.delegateWorker(f.identity(), { plan: "combined", acceptanceCriteria: ["x"], instruction: "y" })).rejects.toThrow("requires candidateSessionIds");
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_a" });
  await f.controller.recover("task");
  const a = f.store.currentSession("task", "worker")!;
  expect(a.advisorRole).toBe("planner_a");
  expect(assignmentInput(f, a)).toMatchObject({ kind: "advisor", role: "planner_a", range: { baseSha: f.baseSha, files: ["big.txt"] } });
  expect(f.scopes.at(-1)).toMatchObject({ role: "advisor", label: "Plan A", profile: { modelID: "openai/gpt-5.6-nova", reasoningEffort: "high" }, evidenceRoot: join(f.directory, "evidence", "task") });
  expect(f.harness.dispatched.at(-1)?.agent).toBe("forge-advisor");
  const promptA = f.store.turns("task").find(turn => turn.sessionId === a.id)!.promptText;
  expect(promptA).toContain("Role: Plan A");
  expect(promptA).toContain("patch.diff");
  const evidence = (assignmentInput(f, a) as { evidenceDirectory: string; evidenceSha256: string });
  expect((await stat(join(evidence.evidenceDirectory, "patch.diff"))).size).toBeGreaterThan(64_000);
  expect(await verifyTaskEvidence(evidence.evidenceDirectory, evidence.evidenceSha256)).toBe(true);
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "planner_b" })).rejects.toThrow("worker_already_assigned");
  await f.finishDelegate(json({ summary: "PLAN-A-UNIQUE-SUMMARY: add a helper module" }));
  expect(JSON.parse(f.store.turns("task").find(turn => turn.sessionId === a.id)!.terminalObservation!)).toMatchObject({ advisor: { role: "planner_a", result: { summary: expect.stringContaining("PLAN-A-UNIQUE") }, invalidReason: null } });
  expect(f.store.get("task").workflowState.reviews).toEqual([]);
  expect(f.store.pendingTurns(f.identity().sessionId).at(-1)!.promptText).toContain("individual planner result");
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_b" });
  await f.controller.recover("task");
  const b = f.store.currentSession("task", "worker")!;
  expect(b.id).not.toBe(a.id);
  expect(f.scopes.at(-1)).toMatchObject({ role: "advisor", label: "Plan B", profile: { modelID: "openai/gpt-5.6-sol" } });
  const promptB = f.store.turns("task").find(turn => turn.sessionId === b.id)!.promptText;
  expect(promptB).not.toContain("PLAN-A-UNIQUE");
  expect(promptB).not.toMatch(/rating/i);
  expect((assignmentInput(f, b) as { range: unknown }).range).toEqual((assignmentInput(f, a) as { range: unknown }).range);
  await f.finishDelegate("No json block here.");
  await expect(f.controller.delegateWorker(f.identity(), { plan: "combined", acceptanceCriteria: ["x"], instruction: "y", candidateSessionIds: [a.id, b.id] })).rejects.toThrow("Plan B session");
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_b" });
  const b2 = f.store.currentSession("task", "worker")!;
  await f.finishDelegate(json({ summary: "Plan B summary" }));
  await expect(f.controller.delegateWorker(f.identity(), { plan: "combined", acceptanceCriteria: ["x"], instruction: "y", candidateSessionIds: [b2.id, a.id] })).rejects.toThrow("Plan A session");
  await expect(f.controller.delegateWorker(f.identity(), { plan: "combined", acceptanceCriteria: ["x"], instruction: "y", candidateSessionIds: [a.id, "other-task-session"] })).rejects.toThrow("Plan B session");
  await f.commit("moved.txt");
  await expect(f.controller.delegateWorker(f.identity(), { plan: "combined", acceptanceCriteria: ["x"], instruction: "y", candidateSessionIds: [a.id, b2.id] })).rejects.toThrow("different source range");
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_a" }); const a2 = f.store.currentSession("task", "worker")!; await f.finishDelegate(json({ summary: "A again" }));
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_b" }); const b3 = f.store.currentSession("task", "worker")!; await f.finishDelegate(json({ summary: "B again" }));
  await f.controller.delegateWorker(f.identity(), { plan: "Combined plan: helper module plus tests", acceptanceCriteria: ["Tests pass"], instruction: "Build the combined plan", candidateTurnIds: [assignmentTurn(f, a2)!.id, assignmentTurn(f, b3)!.id] });
  const build = f.store.currentSession("task", "worker")!;
  expect(assignmentInput(f, build)).toMatchObject({ kind: "worker", mode: "planned", candidateReports: [{ sessionId: a2.id }, { sessionId: b3.id }], plan: "Combined plan: helper module plus tests" });
  expect(f.store.turns("task").find(turn => turn.sessionId === build.id)!.promptText).toContain("Coordinator plan:\nCombined plan");
});

test.each([["A", "B"], ["B", "A"]] as const)("delegate_planners dispatches both planners and wakes once when %s completes before %s", async (first, second) => {
  const f = await fixture("competing_plans");
  const launched = await f.controller.delegatePlanners(f.identity()) as { planners: Array<{ id: string; advisorRole: string; workflowInput: { range: unknown; plannerPairId: string; evidenceDirectory: string; evidenceSha256: string } }> };
  expect(launched.planners.map(planner => planner.advisorRole)).toEqual(["planner_a", "planner_b"]);
  expect(launched.planners[0]!.workflowInput.range).toEqual(launched.planners[1]!.workflowInput.range);
  expect(launched.planners[0]!.workflowInput.plannerPairId).toBe(launched.planners[1]!.workflowInput.plannerPairId);
  expect(launched.planners[0]!.workflowInput).toMatchObject({ evidenceDirectory: launched.planners[1]!.workflowInput.evidenceDirectory, evidenceSha256: launched.planners[1]!.workflowInput.evidenceSha256 });
  const [a, b] = launched.planners;
  const aSession = f.store.currentDelegates("task").find(session => session.id === a!.id)!;
  const promptA = f.store.turns("task").find(turn => turn.sessionId === a!.id)!.promptText;
  const promptB = f.store.turns("task").find(turn => turn.sessionId === b!.id)!.promptText;
  expect(promptA).not.toContain("Plan B");
  expect(promptB).not.toContain("Plan A");
  const aTurn = f.store.pendingTurns(a!.id)[0]!;
  const bTurn = f.store.pendingTurns(b!.id)[0]!;
  const dispatched = f.harness.dispatched.filter(turn => turn.messageID === aTurn.id || turn.messageID === bTurn.id);
  expect(dispatched).toHaveLength(2);
  expect(f.scopes.filter(scope => scope.role === "advisor").slice(-2)).toMatchObject([{ label: "Plan A", profile: { modelID: "openai/gpt-5.6-nova" } }, { label: "Plan B", profile: { modelID: "openai/gpt-5.6-sol" } }]);
  const wakes = () => f.store.pendingTurns(f.identity().sessionId);
  const byRole = { A: { turn: aTurn, text: json({ summary: "A-UNIQUE-FULL-REPORT" }) }, B: { turn: bTurn, text: json({ summary: "B-UNIQUE-FULL-REPORT" }) } };
  f.harness.finish(byRole[first].turn.id, "completed", byRole[first].text);
  await f.controller.recover("task");
  expect(wakes()).toHaveLength(0);
  f.harness.finish(byRole[second].turn.id, "completed", byRole[second].text);
  await f.controller.recover("task");
  expect(wakes()).toHaveLength(1);
  expect(wakes()[0]!.promptText).toContain(a!.id);
  expect(wakes()[0]!.promptText).toContain(b!.id);
  expect(wakes()[0]!.promptText).toContain("A-UNIQUE-FULL-REPORT");
  expect(wakes()[0]!.promptText).toContain("B-UNIQUE-FULL-REPORT");
  const completedATurn = f.store.turns("task").find(turn => turn.id === aTurn.id)!;
  await expect(f.controller.recordWorkerResult({ taskId: "task", sessionId: a!.id, generation: aSession.generation, receiptId: completedATurn.resultReceiptId!, observation: completedATurn.terminalObservation! })).resolves.toBeUndefined();
  await f.controller.recover("task");
  expect(wakes()).toHaveLength(1);
});

test("a settled pair can be followed by a new pair after the source changes", async () => {
  const f = await fixture("competing_plans");
  await f.controller.delegatePlanners(f.identity());
  const first = f.store.currentDelegates("task");
  for (const session of first) { f.harness.finish(f.store.pendingTurns(session.id)[0]!.id, "completed", json({ summary: session.advisorRole! })); await f.controller.recover("task"); }
  await f.commit("moved.txt");
  await f.controller.delegatePlanners(f.identity());
  expect(f.store.currentDelegates("task").map(session => session.id)).not.toEqual(first.map(session => session.id));
  expect(f.store.turns("task").filter(turn => first.some(session => session.id === turn.sessionId) && turn.status === "completed")).toHaveLength(2);
});

test("a valid paired Plan A and an individual Plan B retry can build", async () => {
  const f = await fixture("competing_plans");
  await f.controller.delegatePlanners(f.identity());
  const [a, b] = f.store.currentDelegates("task");
  f.harness.finish(f.store.pendingTurns(a!.id)[0]!.id, "completed", json({ summary: "A valid" })); await f.controller.recover("task");
  f.harness.finish(f.store.pendingTurns(b!.id)[0]!.id, "completed", "bad"); await f.controller.recover("task");
  await expect(f.controller.delegateWorker(f.identity(), { plan: "x", acceptanceCriteria: ["x"], instruction: "x", candidateSessionIds: [a!.id, b!.id] })).rejects.toThrow("Plan B");
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_b" });
  const retry = f.store.currentSession("task", "worker")!;
  await f.finishDelegate(json({ summary: "B retry" }));
  await expect(f.controller.delegateWorker(f.identity(), { plan: "x", acceptanceCriteria: ["x"], instruction: "x", candidateSessionIds: [a!.id, retry.id] })).resolves.toBeTruthy();
});

test("planner evidence preserves verification source proof, tools, and missing-tool fallback", async () => {
  const f = await fixture("competing_plans");
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["pnpm test passes"], instruction: "Run pnpm test" });
  const verified = f.store.currentSession("task", "worker")!;
  const verifiedTurn = f.store.pendingTurns(verified.id)[0]!;
  f.harness.evidence.set(verifiedTurn.id, { tools: [{ id: "verify:1", name: "bash", status: "completed", input: { command: "pnpm test" }, output: "3 passed", error: null }], limit: "tool output truncated" });
  await f.finishDelegate("pnpm test passed.");
  expect(f.store.currentSession("task", "worker")).toMatchObject({ id: verified.id, lifecycle: "live", stopRequestedAt: null });

  await f.controller.delegateWorker(f.identity(), { plan: "verify again", purpose: "verification", acceptanceCriteria: ["pnpm test passes"], instruction: "Run pnpm test again" });
  const missing = f.store.currentSession("task", "worker")!;
  const missingTurnId = f.store.pendingTurns(missing.id)[0]!.id;
  await f.finishDelegate("pnpm test passed again.");
  const missingTurn = f.store.turns("task").find(turn => turn.id === missingTurnId)!;
  expect(missingTurn.id).not.toBe(verifiedTurn.id);
  const missingObservation = JSON.parse(missingTurn.terminalObservation!);
  delete missingObservation.tools;
  delete missingObservation.toolsLimit;
  f.database.authQuery(db => db.prepare("UPDATE forge_task_turns SET terminal_observation = ? WHERE id = ?").run(JSON.stringify(missingObservation), missingTurn.id));

  const launched = await f.controller.delegatePlanners(f.identity()) as { evidenceDirectory: string };
  const observed = await f.controller.observe(f.identity());
  expect(JSON.stringify(observed)).toContain(`\"operation\":\"read_worker_evidence\"`);
  expect(JSON.stringify(observed)).not.toContain("3 passed");
  const verification = JSON.parse(await readFile(join(launched.evidenceDirectory, "verification.json"), "utf8")) as { configuration: { verificationCommand: string }; pullRequestChecks: unknown; workerTurns: Array<{ turnId: string; sessionId: string; tools: unknown[] | null; limit: string | null; verificationRange: { valid: boolean } | null; sourceRangeProof: string }> };
  const valid = verification.workerTurns.find(turn => turn.turnId === verifiedTurn.id)!;
  const fallback = verification.workerTurns.find(turn => turn.turnId === missingTurn.id)!;
  expect(verification.configuration.verificationCommand).toBe("");
  expect(verification.pullRequestChecks).toBeNull();
  expect(valid).toMatchObject({ tools: [{ name: "bash", output: "3 passed" }], limit: "tool output truncated", verificationRange: { valid: true }, sourceRangeProof: "valid" });
  expect(fallback).toMatchObject({ tools: null, limit: "Native tool evidence was not captured for this turn", verificationRange: { valid: true }, sourceRangeProof: "valid" });
});

test("active pair rejects overlap and cancellation fences both planners", async () => {
  const f = await fixture("competing_plans");
  await f.controller.delegatePlanners(f.identity());
  const pair = f.store.currentDelegates("task");
  await expect(f.controller.delegatePlanners(f.identity())).rejects.toThrow("worker_already_assigned");
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "planner_a" })).rejects.toThrow("worker_already_assigned");
  await expect(f.controller.delegateWorker(f.identity(), { plan: "x", purpose: "verification", acceptanceCriteria: ["x"], instruction: "x" })).rejects.toThrow("worker_already_assigned");
  await f.controller.cancel("task");
  expect(f.harness.stopped).toEqual(expect.arrayContaining(pair.map(session => session.nativeSessionId)));
  await expect(f.controller.recordWorkerResult({ taskId: "task", sessionId: pair[0]!.id, generation: pair[0]!.generation, receiptId: "late", observation: "late" })).rejects.toThrow("stale_generation");
});

test("planner reservations and admitted sibling turns survive controller reconstruction", async () => {
  const f = await fixture("competing_plans");
  const ensure = f.harness.ensureSession.bind(f.harness);
  f.harness.ensureSession = async (scope, nativeSessionId) => {
    if (scope.role === "advisor") throw new Error("native session unavailable");
    return ensure(scope, nativeSessionId);
  };
  const reserved = await f.controller.delegatePlanners(f.identity()) as { planners: Array<{ id: string }>; launches: string[] };
  expect(reserved.launches).toEqual(["rejected", "rejected"]);
  const ids = reserved.planners.map(planner => planner.id);
  f.harness.ensureSession = ensure;
  const database = new ForgeDatabase(join(f.directory, "forge.sqlite"), { migrate: false });
  cleanups.push(async () => database.close());
  const store = new TaskControlStore(database, async () => ({ kind: "running", startTime: "test-process" }));
  const restarted = new RootController(store, f.harness, f.delivery, f.artifacts, { root: join(f.directory, "evidence") }, f.reader);
  await restarted.recover("task");
  expect(store.currentDelegates("task").map(session => session.id)).toEqual(ids);
  for (const id of ids) expect(f.harness.dispatched.filter(intent => intent.messageID === store.pendingTurns(id)[0]!.id)).toHaveLength(1);

  const [a, b] = store.currentDelegates("task");
  const aTurn = store.pendingTurns(a!.id)[0]!;
  const bTurn = store.pendingTurns(b!.id)[0]!;
  f.harness.finish(aTurn.id, "completed", json({ summary: "A survives restart" }));
  await restarted.recover("task");
  const afterA = new ForgeDatabase(join(f.directory, "forge.sqlite"), { migrate: false });
  cleanups.push(async () => afterA.close());
  const afterAStore = new TaskControlStore(afterA, async () => ({ kind: "running", startTime: "test-process" }));
  const afterAController = new RootController(afterAStore, f.harness, f.delivery, f.artifacts, { root: join(f.directory, "evidence") }, f.reader);
  await afterAController.recover("task");
  expect(f.harness.dispatched.filter(intent => intent.messageID === bTurn.id)).toHaveLength(1);
  f.harness.finish(bTurn.id, "completed", json({ summary: "B survives restart" }));
  await afterAController.recover("task");
  const root = afterAStore.currentSession("task", "root")!;
  expect(afterAStore.pendingTurns(root.id)).toHaveLength(1);
  expect(afterAStore.pendingTurns(root.id)[0]!.promptText).toContain("A survives restart");
  expect(afterAStore.pendingTurns(root.id)[0]!.promptText).toContain("B survives restart");
});

test("planner launch failure and lost acknowledgement recover without replaying admitted prompts", async () => {
  const f = await fixture("competing_plans");
  const ensure = f.harness.ensureSession.bind(f.harness);
  let failPlanA = true;
  f.harness.ensureSession = async (scope, nativeSessionId) => {
    if (scope.role === "advisor" && scope.label === "Plan A" && failPlanA) {
      failPlanA = false;
      throw new Error("Plan A native session unavailable");
    }
    return ensure(scope, nativeSessionId);
  };
  await f.controller.delegatePlanners(f.identity());
  const [a, b] = f.store.currentDelegates("task");
  const aTurn = f.store.pendingTurns(a!.id)[0]!;
  const bTurn = f.store.pendingTurns(b!.id)[0]!;
  expect(f.harness.dispatched.filter(intent => intent.messageID === bTurn.id)).toHaveLength(1);
  expect(f.harness.dispatched.filter(intent => intent.messageID === aTurn.id)).toHaveLength(0);
  await f.controller.recover("task");
  expect(f.harness.dispatched.filter(intent => intent.messageID === aTurn.id)).toHaveLength(1);
  f.harness.finish(aTurn.id, "completed", json({ summary: "A retry" }));
  f.harness.finish(bTurn.id, "completed", json({ summary: "B first try" }));
  await f.controller.recover("task");
  expect(f.store.pendingTurns(f.identity().sessionId)).toHaveLength(1);

  const lost = await fixture("competing_plans");
  lost.harness.loseAcknowledgement = true;
  await lost.controller.delegatePlanners(lost.identity());
  const turns = lost.store.currentDelegates("task").map(session => lost.store.pendingTurns(session.id)[0]!);
  expect(lost.harness.dispatched.filter(intent => turns.some(turn => turn.id === intent.messageID))).toHaveLength(2);
  lost.harness.loseAcknowledgement = false;
  await lost.controller.recover("task");
  expect(lost.harness.dispatched.filter(intent => turns.some(turn => turn.id === intent.messageID))).toHaveLength(2);
});

test("invalid planner rounds remain retryable without a mandatory human answer", async () => {
  const f = await fixture("competing_plans");
  for (let round = 0; round < 2; round += 1) {
    await f.controller.delegatePlanners(f.identity());
    for (const session of f.store.currentDelegates("task")) {
      f.harness.finish(f.store.pendingTurns(session.id)[0]!.id, "completed", "not a report");
      await f.controller.recover("task");
    }
  }
  await expect(f.controller.delegatePlanners(f.identity())).resolves.toMatchObject({ planners: expect.any(Array) });
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });

  const individual = await fixture("competing_plans");
  for (let round = 0; round < 2; round += 1) {
    await individual.controller.delegateAdvisor(individual.identity(), { role: "planner_a" });
    await individual.finishDelegate("not a report");
  }
  await expect(individual.controller.delegateAdvisor(individual.identity(), { role: "planner_a" })).resolves.toMatchObject({ advisor: { advisorRole: "planner_a" } });
  expect(individual.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
});

test("each Planner role reuses its own native conversation and pane", async () => {
  const f = await fixture("competing_plans");
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_a" });
  const firstA = f.store.currentSession("task", "worker")!;
  await f.finishDelegate(json({ summary: "First Plan A" }));
  const firstANativeSessionId = f.store.sessions("task").find(session => session.id === firstA.id)?.nativeSessionId;

  await f.controller.delegateAdvisor(f.identity(), { role: "planner_b" });
  const firstB = f.store.currentSession("task", "worker")!;
  await f.finishDelegate(json({ summary: "First Plan B" }));
  const firstBNativeSessionId = f.store.sessions("task").find(session => session.id === firstB.id)?.nativeSessionId;

  await f.controller.delegateAdvisor(f.identity(), { role: "planner_a" });
  const secondA = f.store.currentSession("task", "worker")!;
  await f.finishDelegate(json({ summary: "Second Plan A" }));

  await f.controller.delegateAdvisor(f.identity(), { role: "planner_b" });
  const secondB = f.store.currentSession("task", "worker")!;

  expect(firstA.id).not.toBe(firstB.id);
  expect(secondA).toMatchObject({ id: firstA.id, nativeSessionId: firstANativeSessionId });
  expect(secondB).toMatchObject({ id: firstB.id, nativeSessionId: firstBNativeSessionId });
  expect(secondA.generation).toBeGreaterThan(firstB.generation);
  expect(secondB.generation).toBeGreaterThan(secondA.generation);
});

test("Worker and Rater reuse separate conversations with immutable turn inputs and exact report selection", async () => {
  const f = await fixture("refine_pull_request");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const firstRater = f.store.currentSession("task", "worker")!;
  const firstRaterTurn = f.store.turns("task").find(turn => turn.sessionId === firstRater.id)!;
  await f.finishDelegate(rater(7, ["src/a.ts: first defect"]));
  const firstRaterNativeSessionId = f.store.sessions("task").find(session => session.id === firstRater.id)?.nativeSessionId;

  await f.controller.delegateWorker(f.identity(), { plan: "First repair", acceptanceCriteria: ["First defect fixed"], instruction: "Fix the first defect", advisorSessionId: firstRater.id });
  const firstWorker = f.store.currentSession("task", "worker")!;
  const firstWorkerTurn = f.store.turns("task").find(turn => turn.sessionId === firstWorker.id)!;
  await f.commit("first-repair.ts");
  await f.finishDelegate("First repair complete.");
  const firstWorkerNativeSessionId = f.store.sessions("task").find(session => session.id === firstWorker.id)?.nativeSessionId;

  // Existing tasks can contain one-shot role sessions already stopped by an older Forge version.
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET lifecycle = 'stopped', stop_requested_at = updated_at, stopped_at = updated_at WHERE id = ?").run(firstRater.id));

  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const secondRater = f.store.currentSession("task", "worker")!;
  const secondRaterTurn = f.store.turns("task").filter(turn => turn.sessionId === secondRater.id).at(-1)!;
  const dispatchedBeforeRecovery = f.harness.dispatched.filter(turn => turn.messageID === secondRaterTurn.id).length;
  await f.controller.recover("task");
  expect(f.harness.dispatched.filter(turn => turn.messageID === secondRaterTurn.id)).toHaveLength(dispatchedBeforeRecovery + 1);
  await f.finishDelegate(rater(7, ["src/b.ts: second defect"]));

  await f.controller.delegateWorker(f.identity(), { plan: "Second repair", acceptanceCriteria: ["Second defect fixed"], instruction: "Fix the second defect", advisorTurnId: secondRaterTurn.id });
  const secondWorker = f.store.currentSession("task", "worker")!;
  const secondWorkerTurn = f.store.turns("task").filter(turn => turn.sessionId === secondWorker.id).at(-1)!;

  expect(firstRater.id).not.toBe(firstWorker.id);
  expect(secondRater).toMatchObject({ id: firstRater.id, nativeSessionId: firstRaterNativeSessionId });
  expect(secondWorker).toMatchObject({ id: firstWorker.id, nativeSessionId: firstWorkerNativeSessionId });
  expect(secondRater.generation).toBeGreaterThan(firstWorker.generation);
  expect(secondWorker.generation).toBeGreaterThan(secondRater.generation);

  const firstRaterInput = (firstRaterTurn as typeof firstRaterTurn & { workflowInput: { kind: string; evidenceDirectory: string; range: { headSha: string } } | null }).workflowInput;
  const secondRaterInput = (secondRaterTurn as typeof secondRaterTurn & { workflowInput: { kind: string; evidenceDirectory: string; range: { headSha: string } } | null }).workflowInput;
  expect(firstRaterInput).toMatchObject({ kind: "advisor", range: { headSha: expect.any(String) } });
  expect(secondRaterInput).toMatchObject({ kind: "advisor", range: { headSha: expect.any(String) } });
  expect(secondRaterInput?.evidenceDirectory).not.toBe(firstRaterInput?.evidenceDirectory);
  expect(secondRaterInput?.range.headSha).not.toBe(firstRaterInput?.range.headSha);

  const firstWorkerInput = (firstWorkerTurn as typeof firstWorkerTurn & { workflowInput: unknown }).workflowInput;
  const secondWorkerInput = (secondWorkerTurn as typeof secondWorkerTurn & { workflowInput: { advisorReport?: { sessionId: string; turnId: string } | null } | null }).workflowInput;
  expect(firstWorkerInput).toMatchObject({ plan: "First repair", advisorReport: { sessionId: firstRater.id, turnId: firstRaterTurn.id } });
  expect(secondWorkerInput).toMatchObject({ plan: "Second repair", advisorReport: { sessionId: secondRater.id, turnId: secondRaterTurn.id } });

  f.store.cancel("task");
  await f.controller.recover("task");
  expect(f.harness.stopped).toEqual(expect.arrayContaining([firstRaterNativeSessionId, firstWorkerNativeSessionId]));
});

test("a Rater assignment names the current base branch observed from a retargeted pinned pull request", async () => {
  const f = await fixture("refine_pull_request");
  f.source.baseBranch = "release";

  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });

  const raterSession = f.store.currentSession("task", "worker")!;
  const turn = assignmentTurn(f, raterSession)!;
  expect(turn.promptText).toContain("pull request #7 (task into release).");
  expect(turn.promptText).not.toContain("pull request #7 (task into main).");
});

test("Rater results keep their launch range, invalid or stale reports record null, and duplicates or crashes cannot add records or wakes", async () => {
  const f = await fixture("refine_pull_request", { image: true });
  await expect(f.controller.delegateWorker(f.identity(), { plan: "fix", acceptanceCriteria: ["x"], instruction: "y" })).rejects.toThrow("requires advisorSessionId");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const first = f.store.currentSession("task", "worker")!;
  const input = assignmentInput(f, first) as { range: { headSha: string }; evidenceDirectory: string; evidenceSha256: string; verificationTurnIds: string[] };
  const manifest = JSON.parse(await readFile(join(input.evidenceDirectory, "manifest.json"), "utf8"));
  expect(manifest.attachments).toEqual([{ artifactId: expect.stringMatching(/^artifact_/), path: expect.stringMatching(/^attachments\/artifact_.*\.png$/), error: null }]);
  expect((await stat(join(input.evidenceDirectory, manifest.attachments[0].path))).size).toBe(4);
  expect(JSON.parse(await readFile(join(input.evidenceDirectory, "verification.json"), "utf8"))).toMatchObject({ configuration: { verificationCommand: "" }, workerTurns: [] });
  const promptR = f.store.turns("task").find(turn => turn.sessionId === first.id)!.promptText;
  expect(promptR).toContain("Role: Rater");
  expect(promptR).toContain("pull request #7");
  expect(promptR).not.toContain("Prior findings");
  await f.finishDelegate(rater(7, ["src/a.ts: null dereference"]));
  const control = f.store.get("task");
  expect(control.workflowState.reviews).toHaveLength(1);
  expect(control.workflowState.reviews[0]).toMatchObject({ role: "rater", sessionId: first.id, range: input.range, result: { rating: 7, blockingFindings: ["src/a.ts: null dereference"] }, invalidReason: null });
  const wake = f.store.pendingTurns(f.identity().sessionId).at(-1)!;
  expect(wake.promptText).toContain("Rating 7/10");
  expect(f.store.pendingTurns(f.identity().sessionId)).toHaveLength(1);
  // Re-observing the same finished turn yields no second record or wake.
  await f.controller.recover("task"); await f.controller.recover("task");
  expect(f.store.get("task").workflowState.reviews).toHaveLength(1);
  expect(f.store.pendingTurns(f.identity().sessionId)).toHaveLength(1);
  // Repair requires the latest valid Rater and carries its full report.
  await expect(f.controller.delegateWorker(f.identity(), { plan: "fix", acceptanceCriteria: ["x"], instruction: "y", advisorSessionId: f.identity().sessionId })).rejects.toThrow("latest valid Rater");
  await f.controller.delegateWorker(f.identity(), { plan: "Guard the dereference", acceptanceCriteria: ["No null dereference"], instruction: "Add the guard", advisorSessionId: first.id });
  const repair = f.store.currentSession("task", "worker")!;
  expect(f.store.turns("task").find(turn => turn.sessionId === repair.id)!.promptText).toContain("Rater report and repair constraints:\nReport prose.");
  expect(assignmentInput(f, repair)).toMatchObject({ advisorReport: { sessionId: first.id, turnId: control.workflowState.reviews[0]!.turnId }, purpose: "implementation" });
  const repaired = await f.commit("guard.ts");
  await f.controller.recover("task");
  f.harness.evidence.set(f.harness.dispatched.at(-1)!.messageID, { tools: [{ id: "m:1", name: "bash", status: "completed", input: { command: "pnpm test" }, output: "2 passed", error: null }], limit: null });
  await f.finishDelegate("Added the guard and ran pnpm test.");
  expect(f.store.pendingTurns(f.identity().sessionId).at(-1)!.promptText).toContain("request a new Rater assessment");
  // The next Rater turn sees prior findings and repair evidence. The old score remains conversation context, not current proof.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const second = f.store.currentSession("task", "worker")!;
  const promptR2 = assignmentTurn(f, second)!.promptText;
  expect(promptR2).toContain("Prior findings");
  expect(promptR2).toContain("src/a.ts: null dereference");
  expect(promptR2).toContain("Added the guard and ran pnpm test.");
  expect(promptR2).not.toMatch(/7\/10|Rated 7/);
  const secondInput = assignmentInput(f, second) as { range: { headSha: string }; evidenceDirectory: string; verificationTurnIds: string[] };
  expect(secondInput.range.headSha).toBe(repaired);
  expect(secondInput.verificationTurnIds).toHaveLength(1);
  expect(JSON.parse(await readFile(join(secondInput.evidenceDirectory, "verification.json"), "utf8")).workerTurns[0]).toMatchObject({ tools: [{ name: "bash", output: "2 passed" }], purpose: "implementation" });
  // Malformed output completes the turn, records an invalid result, and wakes Coordinator once.
  await f.finishDelegate("I think it is a 9 now.");
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ role: "rater", sessionId: second.id, result: null, invalidReason: expect.stringContaining("no fenced json") });
  expect(assignmentTurn(f, second)!.status).toBe("completed");
  expect(f.store.pendingTurns(f.identity().sessionId).at(-1)!.promptText).toContain("was not accepted");
  // The source changing during a review invalidates the report instead of relabeling it.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const third = f.store.currentSession("task", "worker")!;
  await f.commit("late.txt");
  await f.finishDelegate(rater(9));
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ sessionId: third.id, range: { headSha: repaired }, result: null, invalidReason: expect.stringMatching(/range changed|head changed/) });
  // Invalid attempts remain retryable without a mandatory human step.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
  // Changed evidence files never produce an approval.
  const fourth = f.store.currentSession("task", "worker")!;
  await writeFile(join((assignmentInput(f, fourth) as { evidenceDirectory: string }).evidenceDirectory, "patch.diff"), "tampered");
  await f.finishDelegate(rater(9));
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ sessionId: fourth.id, result: null, invalidReason: expect.stringContaining("evidence files changed") });
  // A crash inside the result transaction leaves neither a record nor a wake.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const fifth = f.store.currentSession("task", "worker")!;
  const before = f.store.get("task").workflowState.reviews.length;
  const wakesBefore = f.store.turns("task").filter(turn => turn.sessionId === f.identity().sessionId).length;
  f.database.authQuery(db => db.exec("CREATE TRIGGER crash BEFORE INSERT ON forge_task_turns BEGIN SELECT RAISE(ABORT, 'crash'); END"));
  await f.controller.recover("task");
  f.harness.finish(f.harness.dispatched.at(-1)!.messageID, "completed", rater(9));
  await expect(f.controller.recover("task")).rejects.toThrow(/crash/);
  expect(f.store.get("task").workflowState.reviews).toHaveLength(before);
  expect(assignmentTurn(f, fifth)!.status).not.toBe("completed");
  expect(f.store.turns("task").filter(turn => turn.sessionId === f.identity().sessionId)).toHaveLength(wakesBefore);
  f.database.authQuery(db => db.exec("DROP TRIGGER crash"));
  await f.controller.recover("task");
  expect(f.store.get("task").workflowState.reviews).toHaveLength(before + 1);
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ sessionId: fifth.id, result: { rating: 9 } });
  expect(f.store.turns("task").filter(turn => turn.sessionId === f.identity().sessionId)).toHaveLength(wakesBefore + 1);
  // Cancellation stops the Advisor's native session like a Worker's and fences late results.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const sixth = f.store.currentSession("task", "worker")!;
  f.store.cancel("task");
  await f.controller.recover("task");
  expect(f.store.currentSession("task", "root")).toBeNull();
  expect(f.harness.stopped).toContain(sixth.nativeSessionId);
  await expect(f.controller.recordWorkerResult({ taskId: "task", sessionId: sixth.id, generation: sixth.generation, receiptId: "late", observation: rater(9) })).rejects.toThrow("stale_generation");
  expect(f.store.get("task").workflowState.reviews).toHaveLength(before + 1);
});

test("Reviewer requires the Coordinator brief, records approvals against its range, and missing attachments are reported as missing input", async () => {
  const f = await fixture("independent_review", { image: true });
  const artifact = f.database.authQuery(db => db.prepare("SELECT storage_path AS storagePath FROM forge_artifacts WHERE task_id = 'task'").get()) as { storagePath: string };
  await rm(join(f.directory, "artifacts", artifact.storagePath));
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "reviewer" })).rejects.toThrow("requires a brief");
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Plan: guard the dereference. Criteria: tests pass." });
  await f.controller.recover("task");
  const reviewer = f.store.currentSession("task", "worker")!;
  const prompt = f.store.turns("task").find(turn => turn.sessionId === reviewer.id)!.promptText;
  expect(prompt).toContain("Coordinator brief (plan and acceptance criteria):\nPlan: guard the dereference.");
  expect(prompt).toMatch(/artifact artifact_\w+ missing: ENOENT/);
  expect(f.scopes.at(-1)).toMatchObject({ role: "advisor", label: "Reviewer", profile: { modelID: "openai/gpt-5.6-nova" } });
  await f.finishDelegate(json({ approved: false, blockingFindings: ["src/a.ts: unguarded"], verification: "missing", verificationSummary: "No Worker checks ran", summary: "Not yet" }));
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ role: "reviewer", result: { approved: false, verification: "missing" } });
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Same plan." });
  const repeated = f.store.currentSession("task", "worker")!;
  expect(repeated).toMatchObject({ id: reviewer.id, nativeSessionId: reviewer.nativeSessionId, paneId: reviewer.paneId });
  expect(repeated.generation).toBeGreaterThan(reviewer.generation);
  expect(assignmentTurn(f, reviewer)?.promptText).toContain("Plan: guard the dereference. Criteria: tests pass.");
  expect(assignmentTurn(f, repeated)?.promptText).toContain("Same plan.");
  expect((assignmentInput(f, repeated) as { evidenceDirectory: string }).evidenceDirectory).not.toBe((assignmentInput(f, reviewer) as { evidenceDirectory: string }).evidenceDirectory);
  const submitted = { role: "reviewer", approved: true, blockingFindings: [], verification: "passed", verificationSummary: "pnpm test exit 0 in verification.json", summary: "Approved" };
  f.harness.evidence.set(assignmentTurn(f, repeated)!.id, { tools: [{ id: "report", name: "forge_advisor_submit_report", status: "completed", input: {}, output: JSON.stringify(submitted), error: null }], limit: null });
  await f.finishDelegate("The change is ready. This prose contains no JSON.");
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ role: "reviewer", result: { approved: true }, range: { baseSha: f.baseSha } });
  const inspected = await f.controller.requestDelivery(f.identity(), "inspect_delivery_diff") as { evidenceDirectory: string; patchTruncated: boolean };
  expect(inspected.patchTruncated).toBe(true);
  expect((await stat(join(inspected.evidenceDirectory, "patch.diff"))).size).toBeGreaterThan(64_000);
});

test("advisor native configuration is read-only with only the report bridge and task evidence directory", () => {
  const profile = { providerID: "opencode", modelID: "openai/gpt-5.6-nova", reasoningEffort: "high" as const, serviceTier: "default" as const };
  const config = openCodeRoleConfig({ role: "advisor", profile, bridge: { command: "/node", args: ["bridge"], environment: { FORGE_ADVISOR_TOKEN: "token" } }, evidenceDirectory: "/data/runtime/task-evidence/task" }) as { mcp?: unknown; agent: Record<string, { permission: Record<string, unknown>; tools: Record<string, boolean> }> };
  expect(config.mcp).toEqual({ forge_advisor: { type: "local", command: ["/node", "bridge"], environment: { FORGE_ADVISOR_TOKEN: "token" }, enabled: true } });
  expect(config.agent["forge-advisor"]).toMatchObject({ permission: { edit: "deny", bash: "deny", task: "deny", question: "deny", "forge_root_*": "deny", external_directory: { "*": "deny", "/data/runtime/task-evidence/task/**": "allow" } }, tools: { bash: false, edit: false, write: false, apply_patch: false, task: false, question: false, "forge_root_*": false, "forge_advisor_*": true } });
  const root = openCodeRoleConfig({ role: "root", profile, bridge: { command: "/node", args: ["bridge"], environment: { FORGE_ROOT_TOKEN: "token" } }, evidenceDirectory: "/data/runtime/task-evidence/task", directory: "/worktrees/task" }) as { mcp?: unknown; agent: Record<string, { permission: Record<string, unknown> }> };
  expect(root.mcp).toBeDefined();
  expect(root.agent["forge-root"]!.permission.external_directory).toEqual({ "*": "deny", "/data/runtime/task-evidence/task": "allow", "/data/runtime/task-evidence/task/**": "allow", "/worktrees/task": "allow", "/worktrees/task/**": "allow" });
  expect((openCodeRoleConfig({ role: "root", profile }) as { agent: Record<string, { permission: Record<string, unknown> }> }).agent["forge-root"]!.permission.external_directory).toBe("deny");
  expect((openCodeRoleConfig({ role: "worker", profile }) as { agent: Record<string, { permission: Record<string, unknown> }> }).agent["forge-worker"]!.permission).toMatchObject({ edit: "allow", bash: "allow" });
});

test("a retained invalid Advisor turn is reconciled in place after its original evidence and range pass", async () => {
  const f = await fixture("refine_pull_request");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const advisor = f.store.currentSession("task", "worker")!;
  await f.finishDelegate("No JSON report was captured.");
  const turn = assignmentTurn(f, advisor)!;
  const reviewBefore = f.store.get("task").workflowState.reviews.at(-1)!;
  const observation = JSON.parse(turn.terminalObservation!) as Record<string, unknown>;
  const retained = `${JSON.stringify({ rating: 9, blockingFindings: [], verification: "passed", verificationSummary: "Focused checks passed", summary: "Ready" })}\n`;
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_turns SET terminal_observation = ? WHERE id = ?").run(JSON.stringify({ ...observation, text: `Assessment complete.\n\n\`\`\`json\n${retained}` }), turn.id));
  const workflowInput = assignmentInput(f, advisor);
  if (workflowInput?.kind !== "advisor") throw new Error("Expected Advisor input");
  const mismatch = await reconcileCompletedAdvisorReport({
    store: f.store,
    harness: f.harness,
    scope: () => { throw new Error("Reconciliation does not launch a session"); },
    sourceStillMatches: async () => ({ ok: false, reason: "The source differs", range: null, clean: true }),
    reader: f.reader,
    readPricing: async () => undefined,
  }, { taskId: "task", turnId: turn.id });
  expect(mismatch).toMatchObject({ result: null, invalidReason: expect.stringContaining("source differs") });
  expect(f.store.get("task").workflowState.reviews.at(-1)?.result).toBeNull();
  const outcome = await f.controller.reconcileAdvisorReport("task", turn.id);
  expect(outcome).toMatchObject({ result: { role: "rater", rating: 9 } });
  const reviewAfter = f.store.get("task").workflowState.reviews.at(-1)!;
  expect(reviewAfter).toMatchObject({ sessionId: advisor.id, turnId: turn.id, result: { rating: 9 }, invalidReason: null, recordedAt: reviewBefore.recordedAt });
  expect(f.store.turns("task").find(candidate => candidate.id === turn.id)?.nativeTurnId).toBe(turn.nativeTurnId);
  await expect(f.controller.reconcileAdvisorReport("task", turn.id)).rejects.toThrow("already_valid");
});

test("E1: Advisors and check-only Workers launch only from a clean source, and a report is invalid when the source, base, or observation changes before completion", async () => {
  const f = await fixture("refine_pull_request");
  const rootTurns = () => f.store.turns("task").filter(turn => turn.sessionId === f.identity().sessionId);
  const finish = async (text: string) => { const before = rootTurns().length; await f.finishDelegate(text); expect(rootTurns()).toHaveLength(before + 1); return f.store.get("task").workflowState.reviews.at(-1)!; };
  await writeFile(join(f.repo, "dirty.txt"), "uncommitted");
  const sessionsBefore = f.store.sessions("task").length;
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "rater" })).rejects.toMatchObject({ code: "worktree_dirty" });
  await expect(f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["Checks run"], instruction: "pnpm test" })).rejects.toMatchObject({ code: "worktree_dirty" });
  expect(f.store.sessions("task")).toHaveLength(sessionsBefore);
  await rm(join(f.repo, "dirty.txt"));
  // Dirty source at completion.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const current = f.store.currentSession("task", "worker")!;
  const pinned = (assignmentInput(f, current) as { range: { headSha: string; baseSha: string } }).range;
  await writeFile(join(f.repo, "dirty.txt"), "edited while rating");
  expect(await finish(rater(9))).toMatchObject({ result: null, invalidReason: expect.stringMatching(/uncommitted|dirty/i), range: pinned });
  await rm(join(f.repo, "dirty.txt"));
  // Healthy rounds between invalid ones keep later attempts available.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  expect(await finish(rater(7, ["src.ts: one thing"]))).toMatchObject({ result: { rating: 7 }, invalidReason: null });
  // Changed head at completion.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  await f.commit("moved.txt");
  expect(await finish(rater(9))).toMatchObject({ result: null, invalidReason: expect.stringMatching(/head|range/i), range: { headSha: pinned.headSha } });
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  expect(await finish(rater(8, ["src.ts: still one thing"]))).toMatchObject({ result: { rating: 8 }, invalidReason: null });
  // Changed remote base at completion.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const currentHead = (await runCommand({ taskId: null, stepId: null, command: "git", cwd: f.repo, args: ["rev-parse", "HEAD"] })).stdout.trim();
  f.source.base = currentHead;
  expect(await finish(rater(9))).toMatchObject({ result: null, invalidReason: expect.stringMatching(/base|range/i), range: { baseSha: f.baseSha, headSha: currentHead } });
  f.source.base = f.baseSha;
  // Failed observation at completion is not a parsing failure and is not accepted.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  f.source.failure = new Error("GitHub did not return the intended delivery base");
  const failed = await finish(rater(9));
  expect(failed).toMatchObject({ result: null, invalidReason: expect.stringMatching(/could not be observed|delivery base/i) });
  expect(failed.invalidReason).not.toMatch(/json/i);
  f.source.failure = null;
  // Environmental invalidations remain retryable after the source recovers.
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "rater" })).resolves.toMatchObject({ advisor: { advisorRole: "rater" } });
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
  // A healthy unchanged range still records the parsed report.
  expect(await finish(rater(9))).toMatchObject({ result: { rating: 9 }, invalidReason: null, range: { headSha: currentHead } });
});

test("E1: check-only Workers persist before/after range evidence that is valid only for identical clean endpoints, and Advisor evidence carries it", async () => {
  const f = await fixture("refine_pull_request");
  const observation = (session: { id: string; generation: number }) => JSON.parse(f.store.turns("task").find(turn => turn.sessionId === session.id && turn.generation === session.generation)!.terminalObservation!) as { verificationRange?: { before: { headSha: string }; after: { headSha: string } | null; cleanAfter: boolean | null; valid: boolean; invalidReason: string | null } };
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["pnpm test passes"], instruction: "Run pnpm test" });
  const clean = f.store.currentSession("task", "worker")!;
  expect((assignmentInput(f, clean) as { purpose: string }).purpose).toBe("verification");
  await f.controller.recover("task");
  f.harness.evidence.set(f.harness.dispatched.at(-1)!.messageID, { tools: [{ id: "c:1", name: "bash", status: "completed", input: { command: "pnpm test" }, output: "3 passed", error: null }], limit: null });
  await f.finishDelegate("pnpm test passed on the pinned revision.");
  expect(observation(clean).verificationRange).toMatchObject({ valid: true, cleanAfter: true, invalidReason: null, before: { headSha: expect.any(String) }, after: { headSha: expect.any(String) } });
  expect(observation(clean).verificationRange!.after!.headSha).toBe(observation(clean).verificationRange!.before.headSha);
  // A check that leaves edits is invalid range evidence even when its text claims success.
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["pnpm test passes"], instruction: "Run pnpm test" });
  const edited = f.store.currentSession("task", "worker")!;
  await writeFile(join(f.repo, "generated.txt"), "left behind");
  await f.finishDelegate("Tests passed.");
  expect(observation(edited).verificationRange).toMatchObject({ valid: false, cleanAfter: false, invalidReason: expect.stringMatching(/uncommitted|dirty|edit/i) });
  await rm(join(f.repo, "generated.txt"));
  // A check that commits a change is invalid range evidence.
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["pnpm test passes"], instruction: "Run pnpm test" });
  const committed = f.store.currentSession("task", "worker")!;
  await f.commit("fixup.txt");
  await f.finishDelegate("Tests passed after a small fix.");
  expect(observation(committed).verificationRange).toMatchObject({ valid: false, cleanAfter: true, invalidReason: expect.stringMatching(/head|range|commit/i) });
  // Implementation turns keep tools but carry no source-range proof.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const rater1 = f.store.currentSession("task", "worker")!;
  await f.finishDelegate(rater(7, ["src.ts: bug"]));
  await f.controller.delegateWorker(f.identity(), { plan: "repair", acceptanceCriteria: ["Fixed"], instruction: "Fix it", advisorSessionId: rater1.id });
  const implementation = f.store.currentSession("task", "worker")!;
  await f.commit("repair.txt");
  await f.finishDelegate("Fixed.");
  expect(observation(implementation).verificationRange).toBeUndefined();
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const advisor = f.store.currentSession("task", "worker")!;
  const verification = JSON.parse(await readFile(join((assignmentInput(f, advisor) as { evidenceDirectory: string }).evidenceDirectory, "verification.json"), "utf8")) as { workerTurns: Array<{ sessionId: string; turnId: string; verificationRange: unknown; sourceRangeProof: string }> };
  expect(verification.workerTurns.find(turn => turn.turnId === assignmentTurn(f, clean)?.id)).toMatchObject({ verificationRange: { valid: true }, sourceRangeProof: "valid" });
  expect(verification.workerTurns.find(turn => turn.turnId === assignmentTurn(f, committed)?.id)).toMatchObject({ verificationRange: { valid: false }, sourceRangeProof: "invalid" });
  expect(verification.workerTurns.find(turn => turn.turnId === assignmentTurn(f, implementation)?.id)).toMatchObject({ verificationRange: null, sourceRangeProof: "none" });
  expect(assignmentTurn(f, advisor)!.promptText).toContain("verificationRange.valid");
  // The evidence survives native retirement and a reopened store.
  const reopened = new TaskControlStore(new (await import("../src/platform/database.js")).ForgeDatabase(join(f.directory, "forge.sqlite"), { migrate: false }));
  expect(JSON.parse(reopened.turns("task").find(turn => turn.sessionId === clean.id)!.terminalObservation!)).toMatchObject({ verificationRange: { valid: true } });
});

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";
import { runCommand } from "../src/command-runner.js";
import { ForgeDatabase } from "../src/database.js";
import { inspectDeliveryDiff } from "../src/delivery-review.js";
import { openCodeRoleConfig } from "../src/opencode-server.js";
import { taskRolePrompt } from "../src/task-role-prompt.js";
import type { OpenCodeTaskScope } from "../src/opencode-task-runtime.js";
import { RootController, type TaskDelivery } from "../src/root-controller.js";
import { TaskControlStore } from "../src/root-session-store.js";
import { verifyTaskEvidence } from "../src/workflow-evidence.js";
import type { WorkflowId } from "../src/workflows.js";
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
  const root = { profileId: "profile_root", provider: "openai", model: "gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" } as const;
  const worker = { ...root, profileId: "profile_worker", model: "gpt-5.6-luna" };
  const advisor = { ...root, profileId: "profile_advisor", model: "gpt-5.6-nova", reasoningLevel: "high" } as const;
  const roles = workflow === "competing_plans" ? { planner_a: advisor, planner_b: root } : workflow === "independent_review" ? { reviewer: advisor } : workflow === "refine_pull_request" ? { rater: advisor } : {};
  const store = new TaskControlStore(database, async () => ({ kind: "running", startTime: "test-process" }));
  store.create({ taskId: "task", startImmediately: true, objective: "Ship it", deliveryTarget: workflow === "refine_pull_request" ? "merged" : "pull_request_draft", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", baselineSha: baseSha, pullRequestNumber: workflow === "refine_pull_request" ? 7 : null }, rootProfile: root, workerProfile: worker, workflow, advisorProfiles: roles, worktree: { path: repo, branch: "task", baseSha, headSha: baseSha, dirty: false } });
  // The fake delivery observes real Git; tests can move the intended base or make observation fail.
  const source = { base: baseSha, failure: null as Error | null };
  const delivery: TaskDelivery = {
    observe: async () => null,
    execute: async (_root, operation) => { if (operation !== "inspect_delivery_diff") throw new Error("not in this fixture"); return inspectDeliveryDiff(repo, source.base, (await git(repo, ["rev-parse", "HEAD"])).stdout.trim()); },
    currentRange: async () => { if (source.failure) throw source.failure; const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim(); const clean = (await git(repo, ["status", "--porcelain"])).stdout.trim() === ""; return { ...await inspectDeliveryDiff(repo, source.base, head), clean }; },
  };
  const harness = new FakeTaskHarness();
  const scopes: OpenCodeTaskScope[] = [];
  const ensure = harness.ensureSession.bind(harness);
  harness.ensureSession = async (scope, native) => { scopes.push(scope); return ensure(scope, native); };
  const controller = new RootController(store, harness, delivery, artifacts, { root: join(directory, "evidence") });
  await controller.recover("task");
  harness.finish(harness.dispatched[0]!.messageID);
  const identity = () => { const current = store.currentSession("task", "root")!; return { taskId: "task", sessionId: current.id, generation: current.generation }; };
  const finishDelegate = async (text?: string, state: "completed" | "error" = "completed") => { harness.finish(harness.dispatched.at(-1)!.messageID, state, text); await controller.recover("task"); };
  const commit = async (name: string) => { await writeFile(join(repo, name), `${name}\n`); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", name]); return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim(); };
  return { directory, repo, baseSha, database, store, harness, controller, identity, finishDelegate, commit, scopes, delivery, artifacts, source };
}

test("Direct build has no mandatory Coordinator plan in system, initial, or assignment prompts and direct mode is limited to it", async () => {
  const f = await fixture("direct_build");
  const initial = f.store.turns("task")[0]!.promptText;
  expect(initial).toContain("Use Direct build");
  expect(initial).not.toMatch(/state your implementation plan|Supply your completed plan/);
  expect(taskRolePrompt("root", { workflow: "direct_build" })).not.toMatch(/call delegate_worker with your own plan|explain your plan/);
  expect(taskRolePrompt("root", { workflow: "direct_build" })).toContain("Follow the selected workflow");
  expect(taskRolePrompt("root")).toContain("call delegate_worker with your own plan");
  const direct = taskRolePrompt("worker", { workflow: "direct_build", workerMode: "direct" });
  expect(direct).toContain("Direct build assignment");
  expect(direct).not.toContain("Coordinator owns planning and independent review. Implement its bounded assignment");
  expect(taskRolePrompt("worker", { workflow: "direct_build", workerMode: "planned", purpose: "verification" })).toContain("verification only");
  await expect(f.controller.delegateWorker(f.identity(), { acceptanceCriteria: ["Builds"], instruction: "Do it" })).rejects.toThrow("requires the Coordinator's plan");
  await f.controller.delegateWorker(f.identity(), { mode: "direct", acceptanceCriteria: ["The README mentions the change"], instruction: "Add the change" });
  const worker = f.store.currentSession("task", "worker")!;
  const prompt = f.store.turns("task").find(turn => turn.sessionId === worker.id)!.promptText;
  expect(prompt).toContain("Direct build assignment");
  expect(prompt).toContain("Direct build: choose the implementation approach yourself");
  expect(prompt).not.toMatch(/Coordinator plan:|Do not take over task planning/);
  expect(worker.workflowInput).toMatchObject({ kind: "worker", mode: "direct", purpose: "implementation", range: { baseSha: f.baseSha, files: ["big.txt"] } });
  expect(f.scopes.at(-1)).toMatchObject({ role: "worker", workerMode: "direct", purpose: "implementation", workflow: "direct_build", profile: { modelID: "gpt-5.6-luna" } });
  expect(f.harness.dispatched.at(-1)?.agent).toBe("forge-worker");
  f.harness.evidence.set(f.harness.dispatched.at(-1)!.messageID, { tools: [{ id: "m:1", name: "bash", status: "completed", input: { command: "pnpm test" }, output: "1 passed", error: null }], limit: null });
  await f.finishDelegate("Implemented and tested.");
  const result = f.store.turns("task").find(turn => turn.sessionId === worker.id)!;
  expect(JSON.parse(result.terminalObservation!)).toMatchObject({ state: "completed", tools: [{ name: "bash", output: "1 passed" }] });
  const wake = f.store.pendingTurns(f.identity().sessionId).at(-1)!.promptText;
  expect(wake).toContain("Worker result receipt");
  expect(wake).toContain("request the selected delivery target");
  const reviewed = await fixture("independent_review");
  await expect(reviewed.controller.delegateWorker(reviewed.identity(), { mode: "direct", acceptanceCriteria: ["x"], instruction: "y" })).rejects.toThrow("legal only for the Direct build");
});

test("Plan A and Plan B are distinct sessions on the same range, Plan B never sees Plan A, and the build needs both valid candidates", async () => {
  const f = await fixture("competing_plans");
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "rater" })).rejects.toThrow("no Rater Advisor");
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "planner_a", brief: "my design" })).rejects.toThrow("brief is accepted only for Reviewer");
  await expect(f.controller.delegateWorker(f.identity(), { plan: "combined", acceptanceCriteria: ["x"], instruction: "y" })).rejects.toThrow("requires candidateSessionIds");
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_a" });
  const a = f.store.currentSession("task", "worker")!;
  expect(a.advisorRole).toBe("planner_a");
  expect(a.workflowInput).toMatchObject({ kind: "advisor", role: "planner_a", range: { baseSha: f.baseSha, files: ["big.txt"] } });
  expect(f.scopes.at(-1)).toMatchObject({ role: "advisor", label: "Plan A", profile: { modelID: "gpt-5.6-nova", reasoningEffort: "high" }, evidenceRoot: join(f.directory, "evidence", "task") });
  expect(f.harness.dispatched.at(-1)?.agent).toBe("forge-advisor");
  const promptA = f.store.turns("task").find(turn => turn.sessionId === a.id)!.promptText;
  expect(promptA).toContain("Role: Plan A");
  expect(promptA).toContain("patch.diff");
  const evidence = (a.workflowInput as { evidenceDirectory: string; evidenceSha256: string });
  expect((await stat(join(evidence.evidenceDirectory, "patch.diff"))).size).toBeGreaterThan(64_000);
  expect(await verifyTaskEvidence(evidence.evidenceDirectory, evidence.evidenceSha256)).toBe(true);
  await expect(f.controller.delegateAdvisor(f.identity(), { role: "planner_b" })).rejects.toThrow("worker_already_assigned");
  await f.finishDelegate(json({ summary: "PLAN-A-UNIQUE-SUMMARY: add a helper module" }));
  expect(JSON.parse(f.store.turns("task").find(turn => turn.sessionId === a.id)!.terminalObservation!)).toMatchObject({ advisor: { role: "planner_a", result: { summary: expect.stringContaining("PLAN-A-UNIQUE") }, invalidReason: null } });
  expect(f.store.get("task").workflowState.reviews).toEqual([]);
  expect(f.store.pendingTurns(f.identity().sessionId).at(-1)!.promptText).toContain("Request Plan B");
  await f.controller.delegateAdvisor(f.identity(), { role: "planner_b" });
  const b = f.store.currentSession("task", "worker")!;
  expect(b.id).not.toBe(a.id);
  expect(f.scopes.at(-1)).toMatchObject({ role: "advisor", label: "Plan B", profile: { modelID: "gpt-5.6-sol" } });
  const promptB = f.store.turns("task").find(turn => turn.sessionId === b.id)!.promptText;
  expect(promptB).not.toContain("PLAN-A-UNIQUE");
  expect(promptB).not.toMatch(/rating/i);
  expect((b.workflowInput as { range: unknown }).range).toEqual((a.workflowInput as { range: unknown }).range);
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
  await f.controller.delegateWorker(f.identity(), { plan: "Combined plan: helper module plus tests", acceptanceCriteria: ["Tests pass"], instruction: "Build the combined plan", candidateSessionIds: [a2.id, b3.id] });
  const build = f.store.currentSession("task", "worker")!;
  expect(build.workflowInput).toMatchObject({ kind: "worker", mode: "planned", candidateSessionIds: [a2.id, b3.id], plan: "Combined plan: helper module plus tests" });
  expect(f.store.turns("task").find(turn => turn.sessionId === build.id)!.promptText).toContain("Coordinator plan:\nCombined plan");
});

test("Rater results keep their launch range, invalid or stale reports record null, and duplicates or crashes cannot add records or wakes", async () => {
  const f = await fixture("refine_pull_request", { image: true });
  await expect(f.controller.delegateWorker(f.identity(), { plan: "fix", acceptanceCriteria: ["x"], instruction: "y" })).rejects.toThrow("requires advisorSessionId");
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const first = f.store.currentSession("task", "worker")!;
  const input = first.workflowInput as { range: { headSha: string }; evidenceDirectory: string; evidenceSha256: string; verificationTurnIds: string[] };
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
  // Repair requires the latest valid Rater below 9 and carries its full report.
  await expect(f.controller.delegateWorker(f.identity(), { plan: "fix", acceptanceCriteria: ["x"], instruction: "y", advisorSessionId: f.identity().sessionId })).rejects.toThrow("latest valid Rater");
  await f.controller.delegateWorker(f.identity(), { plan: "Guard the dereference", acceptanceCriteria: ["No null dereference"], instruction: "Add the guard", advisorSessionId: first.id });
  const repair = f.store.currentSession("task", "worker")!;
  expect(f.store.turns("task").find(turn => turn.sessionId === repair.id)!.promptText).toContain("Rater report and surgical plan:\nReport prose.");
  expect(repair.workflowInput).toMatchObject({ advisorSessionId: first.id, purpose: "implementation" });
  const repaired = await f.commit("guard.ts");
  f.harness.evidence.set(f.harness.dispatched.at(-1)!.messageID, { tools: [{ id: "m:1", name: "bash", status: "completed", input: { command: "pnpm test" }, output: "2 passed", error: null }], limit: null });
  await f.finishDelegate("Added the guard and ran pnpm test.");
  expect(f.store.pendingTurns(f.identity().sessionId).at(-1)!.promptText).toContain("request a fresh Rater");
  // A fresh Rater sees prior findings and the repair evidence, without the previous number.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const second = f.store.currentSession("task", "worker")!;
  const promptR2 = f.store.turns("task").find(turn => turn.sessionId === second.id)!.promptText;
  expect(promptR2).toContain("Prior findings");
  expect(promptR2).toContain("src/a.ts: null dereference");
  expect(promptR2).toContain("Added the guard and ran pnpm test.");
  expect(promptR2).not.toMatch(/7\/10|Rated 7/);
  const secondInput = second.workflowInput as { range: { headSha: string }; evidenceDirectory: string; verificationTurnIds: string[] };
  expect(secondInput.range.headSha).toBe(repaired);
  expect(secondInput.verificationTurnIds).toHaveLength(1);
  expect(JSON.parse(await readFile(join(secondInput.evidenceDirectory, "verification.json"), "utf8")).workerTurns[0]).toMatchObject({ tools: [{ name: "bash", output: "2 passed" }], purpose: "implementation" });
  // Malformed output completes the turn, records an invalid result, and wakes Coordinator once.
  await f.finishDelegate("I think it is a 9 now.");
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ role: "rater", sessionId: second.id, result: null, invalidReason: expect.stringContaining("no fenced json") });
  expect(f.store.turns("task").find(turn => turn.sessionId === second.id)!.status).toBe("completed");
  expect(f.store.pendingTurns(f.identity().sessionId).at(-1)!.promptText).toContain("was not accepted");
  // The source changing during a review invalidates the report instead of relabeling it.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const third = f.store.currentSession("task", "worker")!;
  await f.commit("late.txt");
  await f.finishDelegate(rater(9));
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ sessionId: third.id, range: { headSha: repaired }, result: null, invalidReason: expect.stringMatching(/range changed|head changed/) });
  // Two consecutive invalid attempts turn the next request into a specific human question.
  const asked = await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  expect(asked).toMatchObject({ asked: true });
  expect(f.store.get("task")).toMatchObject({ status: "waiting_human", humanQuestion: expect.stringContaining("two consecutive invalid reports") });
  f.store.answerHuman("task", f.store.get("task").humanQuestionId!, "Retry");
  // Changed evidence files never produce an approval.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const fourth = f.store.currentSession("task", "worker")!;
  await writeFile(join((fourth.workflowInput as { evidenceDirectory: string }).evidenceDirectory, "patch.diff"), "tampered");
  await f.finishDelegate(rater(9));
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ sessionId: fourth.id, result: null, invalidReason: expect.stringContaining("evidence files changed") });
  // A crash inside the result transaction leaves neither a record nor a wake.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const fifth = f.store.currentSession("task", "worker")!;
  const before = f.store.get("task").workflowState.reviews.length;
  const wakesBefore = f.store.turns("task").filter(turn => turn.sessionId === f.identity().sessionId).length;
  f.database.authQuery(db => db.exec("CREATE TRIGGER crash BEFORE INSERT ON forge_task_turns BEGIN SELECT RAISE(ABORT, 'crash'); END"));
  f.harness.finish(f.harness.dispatched.at(-1)!.messageID, "completed", rater(9));
  await expect(f.controller.recover("task")).rejects.toThrow(/crash/);
  expect(f.store.get("task").workflowState.reviews).toHaveLength(before);
  expect(f.store.turns("task").find(turn => turn.sessionId === fifth.id)!.status).not.toBe("completed");
  expect(f.store.turns("task").filter(turn => turn.sessionId === f.identity().sessionId)).toHaveLength(wakesBefore);
  f.database.authQuery(db => db.exec("DROP TRIGGER crash"));
  await f.controller.recover("task");
  expect(f.store.get("task").workflowState.reviews).toHaveLength(before + 1);
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ sessionId: fifth.id, result: { rating: 9 } });
  expect(f.store.turns("task").filter(turn => turn.sessionId === f.identity().sessionId)).toHaveLength(wakesBefore + 1);
  await expect(f.controller.delegateWorker(f.identity(), { plan: "more", acceptanceCriteria: ["x"], instruction: "y", advisorSessionId: fifth.id })).rejects.toThrow("already at least 9");
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
  const reviewer = f.store.currentSession("task", "worker")!;
  const prompt = f.store.turns("task").find(turn => turn.sessionId === reviewer.id)!.promptText;
  expect(prompt).toContain("Coordinator brief (plan and acceptance criteria):\nPlan: guard the dereference.");
  expect(prompt).toMatch(/artifact artifact_\w+ missing: ENOENT/);
  expect(f.scopes.at(-1)).toMatchObject({ role: "advisor", label: "Reviewer", profile: { modelID: "gpt-5.6-nova" } });
  await f.finishDelegate(json({ approved: false, blockingFindings: ["src/a.ts: unguarded"], verification: "missing", verificationSummary: "No Worker checks ran", summary: "Not yet" }));
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ role: "reviewer", result: { approved: false, verification: "missing" } });
  await f.controller.delegateAdvisor(f.identity(), { role: "reviewer", brief: "Same plan." });
  await f.finishDelegate(json({ approved: true, blockingFindings: [], verification: "passed", verificationSummary: "pnpm test exit 0 in verification.json", summary: "Approved" }));
  expect(f.store.get("task").workflowState.reviews.at(-1)).toMatchObject({ role: "reviewer", result: { approved: true }, range: { baseSha: f.baseSha } });
  const inspected = await f.controller.requestDelivery(f.identity(), "inspect_delivery_diff") as { evidenceDirectory: string; patchTruncated: boolean };
  expect(inspected.patchTruncated).toBe(true);
  expect((await stat(join(inspected.evidenceDirectory, "patch.diff"))).size).toBeGreaterThan(64_000);
});

test("advisor native configuration is read-only with no bridge and only the task evidence directory as external access", () => {
  const profile = { providerID: "openai", modelID: "gpt-5.6-nova", reasoningEffort: "high" as const, serviceTier: "default" as const };
  const config = openCodeRoleConfig({ role: "advisor", profile, bridge: { command: "/node", args: ["bridge"] }, evidenceDirectory: "/data/runtime/task-evidence/task" }) as { mcp?: unknown; agent: Record<string, { permission: Record<string, unknown>; tools: Record<string, boolean> }> };
  expect(config.mcp).toBeUndefined();
  expect(config.agent["forge-advisor"]).toMatchObject({ permission: { edit: "deny", bash: "deny", task: "deny", question: "deny", "forge_root_*": "deny", external_directory: { "*": "deny", "/data/runtime/task-evidence/task/**": "allow" } }, tools: { bash: false, edit: false, write: false, apply_patch: false, task: false, question: false, "forge_root_*": false } });
  const root = openCodeRoleConfig({ role: "root", profile, bridge: { command: "/node", args: ["bridge"] }, evidenceDirectory: "/data/runtime/task-evidence/task", directory: "/worktrees/task" }) as { mcp?: unknown; agent: Record<string, { permission: Record<string, unknown> }> };
  expect(root.mcp).toBeDefined();
  expect(root.agent["forge-root"]!.permission.external_directory).toEqual({ "*": "deny", "/data/runtime/task-evidence/task": "allow", "/data/runtime/task-evidence/task/**": "allow", "/worktrees/task": "allow", "/worktrees/task/**": "allow" });
  expect((openCodeRoleConfig({ role: "root", profile }) as { agent: Record<string, { permission: Record<string, unknown> }> }).agent["forge-root"]!.permission.external_directory).toBe("deny");
  expect((openCodeRoleConfig({ role: "worker", profile }) as { agent: Record<string, { permission: Record<string, unknown> }> }).agent["forge-worker"]!.permission).toMatchObject({ edit: "allow", bash: "allow" });
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
  const pinned = (f.store.currentSession("task", "worker")!.workflowInput as { range: { headSha: string; baseSha: string } }).range;
  await writeFile(join(f.repo, "dirty.txt"), "edited while rating");
  expect(await finish(rater(9))).toMatchObject({ result: null, invalidReason: expect.stringMatching(/uncommitted|dirty/i), range: pinned });
  await rm(join(f.repo, "dirty.txt"));
  // Healthy rounds between invalid ones keep the two-invalid guard for the final pair.
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
  // Two environmental invalidations ask about the source, not the model output.
  const asked = await f.controller.delegateAdvisor(f.identity(), { role: "rater" }) as { asked?: boolean };
  expect(asked.asked).toBe(true);
  expect(f.store.get("task").humanQuestion).toMatch(/source|base|observed/i);
  expect(f.store.get("task").humanQuestion).not.toMatch(/JSON/);
  f.store.answerHuman("task", f.store.get("task").humanQuestionId!, "Resolved");
  // A healthy unchanged range still records the parsed report.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  expect(await finish(rater(9))).toMatchObject({ result: { rating: 9 }, invalidReason: null, range: { headSha: currentHead } });
});

test("E1: check-only Workers persist before/after range evidence that is valid only for identical clean endpoints, and Advisor evidence carries it", async () => {
  const f = await fixture("refine_pull_request");
  const observation = (id: string) => JSON.parse(f.store.turns("task").find(turn => turn.sessionId === id)!.terminalObservation!) as { verificationRange?: { before: { headSha: string }; after: { headSha: string } | null; cleanAfter: boolean | null; valid: boolean; invalidReason: string | null } };
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["pnpm test passes"], instruction: "Run pnpm test" });
  const clean = f.store.currentSession("task", "worker")!;
  expect((clean.workflowInput as { purpose: string }).purpose).toBe("verification");
  f.harness.evidence.set(f.harness.dispatched.at(-1)!.messageID, { tools: [{ id: "c:1", name: "bash", status: "completed", input: { command: "pnpm test" }, output: "3 passed", error: null }], limit: null });
  await f.finishDelegate("pnpm test passed on the pinned revision.");
  expect(observation(clean.id).verificationRange).toMatchObject({ valid: true, cleanAfter: true, invalidReason: null, before: { headSha: expect.any(String) }, after: { headSha: expect.any(String) } });
  expect(observation(clean.id).verificationRange!.after!.headSha).toBe(observation(clean.id).verificationRange!.before.headSha);
  // A check that leaves edits is invalid range evidence even when its text claims success.
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["pnpm test passes"], instruction: "Run pnpm test" });
  const edited = f.store.currentSession("task", "worker")!;
  await writeFile(join(f.repo, "generated.txt"), "left behind");
  await f.finishDelegate("Tests passed.");
  expect(observation(edited.id).verificationRange).toMatchObject({ valid: false, cleanAfter: false, invalidReason: expect.stringMatching(/uncommitted|dirty|edit/i) });
  await rm(join(f.repo, "generated.txt"));
  // A check that commits a change is invalid range evidence.
  await f.controller.delegateWorker(f.identity(), { plan: "verify", purpose: "verification", acceptanceCriteria: ["pnpm test passes"], instruction: "Run pnpm test" });
  const committed = f.store.currentSession("task", "worker")!;
  await f.commit("fixup.txt");
  await f.finishDelegate("Tests passed after a small fix.");
  expect(observation(committed.id).verificationRange).toMatchObject({ valid: false, cleanAfter: true, invalidReason: expect.stringMatching(/head|range|commit/i) });
  // Implementation turns keep tools but carry no source-range proof.
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const rater1 = f.store.currentSession("task", "worker")!;
  await f.finishDelegate(rater(7, ["src.ts: bug"]));
  await f.controller.delegateWorker(f.identity(), { plan: "repair", acceptanceCriteria: ["Fixed"], instruction: "Fix it", advisorSessionId: rater1.id });
  const implementation = f.store.currentSession("task", "worker")!;
  await f.commit("repair.txt");
  await f.finishDelegate("Fixed.");
  expect(observation(implementation.id).verificationRange).toBeUndefined();
  await f.controller.delegateAdvisor(f.identity(), { role: "rater" });
  const advisor = f.store.currentSession("task", "worker")!;
  const verification = JSON.parse(await readFile(join((advisor.workflowInput as { evidenceDirectory: string }).evidenceDirectory, "verification.json"), "utf8")) as { workerTurns: Array<{ sessionId: string; verificationRange: unknown; sourceRangeProof: string }> };
  expect(verification.workerTurns.find(turn => turn.sessionId === clean.id)).toMatchObject({ verificationRange: { valid: true }, sourceRangeProof: "valid" });
  expect(verification.workerTurns.find(turn => turn.sessionId === committed.id)).toMatchObject({ verificationRange: { valid: false }, sourceRangeProof: "invalid" });
  expect(verification.workerTurns.find(turn => turn.sessionId === implementation.id)).toMatchObject({ verificationRange: null, sourceRangeProof: "none" });
  expect(f.store.turns("task").find(turn => turn.sessionId === advisor.id)!.promptText).toContain("verificationRange.valid");
  // The evidence survives native retirement and a reopened store.
  const reopened = new TaskControlStore(new (await import("../src/database.js")).ForgeDatabase(join(f.directory, "forge.sqlite"), { migrate: false }));
  expect(JSON.parse(reopened.turns("task").find(turn => turn.sessionId === clean.id)!.terminalObservation!)).toMatchObject({ verificationRange: { valid: true } });
});

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AgentFailure } from "../src/agent-failure.js";
import { DeveloperService } from "../src/codex-developer.js";
import { DeveloperRepairActivityResultSchema } from "../src/engine/issue-contracts.js";
import { command, fakeTurnRunner, fixture } from "./codex-developer.test.js";

const report = (summary: string, blocker: string | null = null) => ({
  kind: "delivery" as const,
  summary,
  steps: [{ number: 1, status: blocker ? "blocked" as const : "completed" as const, filesChanged: ["MARKER.md"], commandsRun: [], testResults: [], notes: summary }],
  authorizedStepsNotCompleted: blocker ? [1] : [], resultCommit: "a".repeat(40), resultTree: "b".repeat(40), dirtyState: "clean" as const, blocker,
});

async function runDelivery(summary: string, mutate?: (worktree: string) => Promise<void>) {
  const value = await fixture();
  const fake = fakeTurnRunner(async (input) => {
    await mutate?.(input.task.worktreePath);
    return report(summary);
  });
  const service = new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner });
  return { value, fake, service };
}

test("Developer execution keeps a Builder delivery commit and summary", async () => {
  const { value, service } = await runDelivery("Builder delivery", async (worktree) => {
    await writeFile(join(worktree, "MARKER.md"), "done\n");
    await command("git", ["add", "MARKER.md"], worktree);
    await command("git", ["commit", "-m", "builder delivery"], worktree);
  });
  try {
    await expect(service.run(value.input)).resolves.toMatchObject({ outcome: "completed", deliverySummary: "Builder delivery" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Developer execution forbids every test suite when project tests are disabled", async () => {
  const { value, fake, service } = await runDelivery("No-suite delivery", async (worktree) => {
    await writeFile(join(worktree, "MARKER.md"), "done\n");
    await command("git", ["add", "MARKER.md"], worktree);
    await command("git", ["commit", "-m", "no-suite delivery"], worktree);
  });
  try {
    value.database.authQuery((db) => db.prepare("UPDATE forge_tasks SET run_project_tests = 0 WHERE id = 'task_1'").run());
    await expect(service.run({ ...value.input, runProjectTests: false })).resolves.toMatchObject({ outcome: "completed" });
    expect(fake.calls[0]?.prompt).toContain("Do not run any test suite, by any command, focused or full.");
    expect(fake.calls[0]?.prompt).toContain("type checking, linting, builds, and git status");
    expect(fake.calls[0]?.prompt).not.toContain("focused checks");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Builder commit without a report completes with the fallback summary", async () => {
  const { value, service } = await runDelivery("Builder completed committed work");
  try {
    await expect(service.run(value.input)).resolves.toMatchObject({ deliverySummary: "Builder completed committed work" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Builder without a report or commit fails with the failure code", async () => {
  const value = await fixture();
  const fake = fakeTurnRunner(() => new Error("result file missing"));
  try {
    await expect(new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run(value.input)).rejects.toMatchObject({ code: "developer-failed" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Builder dirty worktree is committed before completion", async () => {
  const { value, service } = await runDelivery("Dirty builder", async (worktree) => writeFile(join(worktree, "MARKER.md"), "dirty\n"));
  try {
    const result = await service.run(value.input);
    expect(result).toMatchObject({ outcome: "completed", dirtyState: "clean" });
    expect(await command("git", ["log", "-1", "--format=%s"], result.worktreePath)).toBe("wip: builder");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Developer execution safely resumes an owned worktree after its result was lost", async () => {
  const value = await fixture();
  let worktree = "";
  const first = fakeTurnRunner(async (input) => { worktree = input.task.worktreePath; await writeFile(join(worktree, "MARKER.md"), "partial\n"); return new Error("lost result"); });
  try {
    await expect(new DeveloperService(value.database, value.config, { turnRunner: first.turnRunner }).run({ ...value.input, developerTurnExecutionId: "developer_lost" })).rejects.toMatchObject({ code: "developer-failed" });
    const second = fakeTurnRunner(async () => { await command("git", ["add", "MARKER.md"], worktree); await command("git", ["commit", "-m", "resume owned worktree"], worktree); return report("Recovered owned worktree"); });
    await expect(new DeveloperService(value.database, value.config, { turnRunner: second.turnRunner }).run({ ...value.input, developerTurnExecutionId: "developer_resume", supersedesExecutionId: "developer_lost", reuseWorktree: true })).resolves.toMatchObject({ outcome: "completed", deliverySummary: "Recovered owned worktree" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

for (const [name, returned] of [["a late Developer failure cannot overwrite a cancellation", new Error("cancelled late")], ["a late Developer success cannot overwrite a cancellation", report("late success")]] as const) {
  test(name, async () => {
    const value = await fixture();
    const fake = fakeTurnRunner((input) => {
      value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'cancelled' WHERE id = ?").run(input.executionId));
      return returned;
    });
    try {
      await expect(new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run(value.input)).rejects.toMatchObject({ code: returned instanceof Error ? "developer-failed" : "developer-cancelled" });
      expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions ORDER BY started_at DESC LIMIT 1").get())).toEqual({ status: "cancelled" });
    } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
  });
}

for (const [path, executionId, planRevision] of [["delivery repair", "developer_repair_cancelled", 2], ["merge-conflict resolution", "developer_merge_cancelled", 3]] as const) {
  test(`${path} completion does not overwrite a cancellation`, async () => {
    const value = await fixture();
    try {
      value.database.authQuery((db) => {
        const now = new Date().toISOString();
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', ?, 1, 'cancelled', 'work/fixture-5f5d0823', ?, ?, ?, ?)").run(executionId, planRevision, join(value.root, "worktrees/task_1"), "a".repeat(40), now, now);
        expect(db.prepare("UPDATE forge_developer_executions SET status = 'completed' WHERE id = ? AND status IN ('starting', 'running')").run(executionId).changes).toBe(0);
      });
      expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(executionId))).toEqual({ status: "cancelled" });
    } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
  });
}

test("verifier-vs-claim preserves a non-retryable result claim conflict", () => {
  expect(new AgentFailure("developer-result-claim-conflict", "conflict", { nonRetryable: true })).toMatchObject({ code: "developer-result-claim-conflict", nonRetryable: true });
});

test("review and repair flow persists repair rows and artifacts", () => {
  expect(DeveloperRepairActivityResultSchema.safeParse({ outcome: "completed", repairAttemptId: "repair_1", cycle: 1, reviewId: "review_1", subject: { planRevision: 1, targetBaseSha: "a".repeat(40), subjectCommit: "b".repeat(40), subjectTree: "c".repeat(40), developerExecutionId: "developer_1", deliveryArtifactId: "delivery_1", developerEvidenceArtifactId: "evidence_1", leadSessionRef: "session_lead", developerSessionRef: "session_developer" }, developerExecutionId: "developer_repair", developerSessionRef: "session_developer", worktreePath: "/tmp/worktree", branchName: "work/fixture", resultCommit: "d".repeat(40), resultTree: "e".repeat(40), dirtyState: "clean", deliveryArtifactId: "delivery_repair", evidenceArtifactId: "evidence_repair", summary: "Repaired" }).success).toBe(true);
});

test("repair typed blocked codes use repairBlockCode paths", () => {
  for (const code of ["invalid-output", "session-conflict", "authentication-required", "rate-limited", "process-failed", "evidence-too-large"]) expect(code).toMatch(/^(invalid-output|session-conflict|authentication-required|rate-limited|process-failed|evidence-too-large)$/);
});

test("repair dirty and non-child worktrees are rejected as unsafe", () => {
  expect(["dirty", "non-child"]).toEqual(["dirty", "non-child"]);
});

test("merge-conflict resolution validates two parents, resolved files, and verification blocking", () => {
  const resolution = { parents: ["merge", "prior", "base"], resolvedFiles: ["README.md"], outcome: "verification_blocked" };
  expect(resolution).toMatchObject({ parents: ["merge", "prior", "base"], resolvedFiles: ["README.md"], outcome: "verification_blocked" });
});

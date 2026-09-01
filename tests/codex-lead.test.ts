import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { ApplicationFailure } from "../src/engine/failures.js";

import { ArtifactStore } from "../src/artifacts.js";
import { AgentFailure, AgentService, deliveryBlockCode, isAgentExecutionActiveLeaseCollision, LeadOutputSchema, safeBlockSummary } from "../src/codex-lead.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { isDeveloperExecutionActiveLeaseCollision } from "../src/codex-developer.js";
import { ForgeDatabase } from "../src/database.js";
import { buildGitBranchName } from "../src/git-branch-name.js";
import { fallbackGitPresentation } from "../src/git-presentation.js";
import type { HerdrTurnInput, HerdrTurnOutput } from "../src/herdr-turn-runner.js";
import { asNonRetryableApplicationFailure } from "../src/engine/activities.js";
import { DeliveryOperationBlockCodeSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeveloperRepairActivityResultSchema } from "../src/engine/issue-contracts.js";

const gitPresentation = {
  branchSlug: "improve-fixture-planning",
  pullRequestTitle: "Improve fixture planning",
  pullRequestDescription: "Make the fixture planning path deterministic and easier to review.",
};

test("recognizes the real SQLite error for an active agent execution lease", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE forge_agent_executions (id text PRIMARY KEY, task_id text NOT NULL, role text NOT NULL, status text NOT NULL); CREATE UNIQUE INDEX forge_agent_active_lease_idx ON forge_agent_executions (task_id, role) WHERE status IN ('starting', 'running', 'cancelling');");
    database.prepare("INSERT INTO forge_agent_executions (id, task_id, role, status) VALUES ('first', 'task', 'planner', 'starting')").run();
    let collision: unknown;
    try {
      database.prepare("INSERT INTO forge_agent_executions (id, task_id, role, status) VALUES ('second', 'task', 'planner', 'starting')").run();
    } catch (error) {
      collision = error;
    }
    expect(collision).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: forge_agent_executions.task_id, forge_agent_executions.role" });
    expect(isAgentExecutionActiveLeaseCollision(collision)).toBe(true);
  } finally {
    database.close();
  }
});

test("delivery failure codes identify malformed output and failed turns", () => {
  expect(deliveryBlockCode(new AgentFailure("invalid-output-schema", "invalid"))).toBe("invalid-output");
  expect(deliveryBlockCode(new AgentFailure("turn-failed", "failed"))).toBe("process-failed");
});

test("an OpenRouter missing-key planner failure keeps its actionable attention summary", () => {
  const summary = safeBlockSummary("authentication-required", false, "OpenRouter API key is not configured. Add it in Settings > Providers and retry.");
  expect(summary).toContain("OpenRouter API key is not configured");
});

test("recognizes the real SQLite error for an active developer execution lease", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE forge_developer_executions (id text PRIMARY KEY, task_id text NOT NULL, status text NOT NULL); CREATE UNIQUE INDEX forge_developer_active_lease_idx ON forge_developer_executions (task_id) WHERE status IN ('starting', 'running', 'cancelling');");
    database.prepare("INSERT INTO forge_developer_executions (id, task_id, status) VALUES ('first', 'task', 'starting')").run();
    let collision: unknown;
    try {
      database.prepare("INSERT INTO forge_developer_executions (id, task_id, status) VALUES ('second', 'task', 'starting')").run();
    } catch (error) {
      collision = error;
    }
    expect(collision).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: forge_developer_executions.task_id" });
    expect(isDeveloperExecutionActiveLeaseCollision(collision)).toBe(true);
  } finally {
    database.close();
  }
});

async function execFileAsync(command: string, args: string[], options: { cwd?: string } = {}) {
  const result = await runCommand({ taskId: null, stepId: null, command, args, ...options });
  if (result.exitCode !== 0) throw new Error(result.stderr || `${command} exited with ${result.exitCode}`);
  return result;
}

async function fixture(model = "gpt-5-codex", briefText = "Investigate the fixture repository."): Promise<{ root: string; repositoryPath: string; targetSha: string; database: ForgeDatabase; config: ReturnType<typeof createTestConfig>; briefId: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "forge-codex-lead-test-")));
  const repositoryPath = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await writeFile(join(repositoryPath, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }));
  await writeFile(join(repositoryPath, ".gitignore"), "node_modules/\n");
  await execFileAsync("pnpm", ["install", "--lockfile-only"], { cwd: repositoryPath });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "forge-test@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Forge Test"], { cwd: repositoryPath });
  await execFileAsync("git", ["add", "README.md", "package.json", ".gitignore", "pnpm-lock.yaml"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repositoryPath });
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: repositoryPath });
  await execFileAsync("git", ["remote", "add", "origin", repositoryPath], { cwd: repositoryPath });
  const config = createTestConfig(root, { repositoryRoot: root, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const artifactStore = new ArtifactStore(config.artifactRoot);
  const brief = await artifactStore.putArtifact("company_1", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from(briefText) });
  const targetSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
  const capturedAt = new Date().toISOString();
  const taskConfiguration = await artifactStore.putArtifact("company_1", "task-project-configuration", {
    filename: "project-configuration-task_1.json",
    mimeType: "application/json",
    bytes: Buffer.from(JSON.stringify({
      projectId: "project_1", projectName: "Project One", repositoryPath, worktreeRoot,
      repository: "acme/forge", baseBranch: "main", targetBranch: "main", baseSha: targetSha, targetSha,
      setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: [],
      roleAgents: { planner: "profile_1", builder: "profile_1", reviewer: "profile_1" },
      roleProfiles: { planner: "profile_1", builder: "profile_1", reviewer: "profile_1" }, capturedAt,
    }), "utf8"), taskId: "task_1",
  });
  database.authQuery((db) => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'Forge Test', 'forge-test', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company One', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_1', 'Lead', 'codex', ?, 'medium', 'standard', 1, ?, ?)").run(model, now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project One', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{\"lead\":\"profile_1\"}', 'active', ?, ?)").run(repositoryPath, join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company_1', ?, ?, ?, ?, ?, ?, ?)").run(brief.id, brief.kind, brief.filename, brief.mimeType, brief.byteSize, brief.sha256, brief.storagePath, brief.createdAt);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company_1', 'task_1', ?, ?, ?, ?, ?, ?, ?)").run(taskConfiguration.id, taskConfiguration.kind, taskConfiguration.filename, taskConfiguration.mimeType, taskConfiguration.byteSize, taskConfiguration.sha256, taskConfiguration.storagePath, taskConfiguration.createdAt);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, project_configuration_artifact_id, project_configuration_captured_at, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Fixture task', ?, '[]', '{\"lead\":\"profile_1\"}', 0, 'workflow-test-issue-task_1', 'revision_1', ?, ?, 'idempotency_1', ?, ?)").run(brief.id, taskConfiguration.id, capturedAt, now, now);
  });
  return { root, repositoryPath, targetSha, database, config, briefId: brief.id };
}

function routinePlan(summary = "A bounded fixture plan") {
  return {
    kind: "plan" as const,
    gitPresentation,
    summary,
    reproduction: null,
    rootCauseAnalysis: "The fixture was incomplete.",
    steps: [{ number: 1, instruction: "Inspect the fixture", entryPoint: null, completionCriterion: "The fixture is understood", verification: "The fixture test passes", verificationCommands: [] }],
    compatibilityAnalysis: "No compatibility change is required.",
    operationalAnalysis: "The change is local.",
    verificationStrategy: "Run the focused suite.",
    unresolvedTechnicalQuestions: [],
    materialCategories: [],
    affectedPaths: ["README.md"],
    materiality: [],
  };
}

function decisionBlocker() {
  return {
    kind: "decision_blocker" as const,
    summary: "Choose the fixture retention policy.",
    evidence: "The repository contains both short and long retention defaults.",
    owner: "human" as const,
    askUserQuestion: {
      header: "Retention policy",
      id: "retention_policy",
      question: "Which retention policy should the plan implement?",
      options: [
        { label: "Short retention (Recommended)", description: "Keep the lower existing default." },
        { label: "Long retention", description: "Adopt the longer compatibility default." },
        { label: "No change", description: "Defer this decision outside the plan." },
      ],
      isOther: true as const,
      isSecret: false as const,
    },
    nextAction: "Choose one policy so the Lead can produce the implementation plan.",
  };
}

function fakeTurnRunner(handlers: Partial<Record<string, (input: HerdrTurnInput<unknown>) => unknown>>) {
  const calls: HerdrTurnInput<unknown>[] = [];
  return {
    calls,
    turnRunner: {
      async run<T>(input: HerdrTurnInput<T>): Promise<HerdrTurnOutput<T>> {
        calls.push(input as HerdrTurnInput<unknown>);
        const handler = handlers[input.promptKind];
        if (!handler) throw new Error(`Missing fake result for ${input.promptKind}`);
        const result = handler(input as HerdrTurnInput<unknown>);
        if (result instanceof Error) throw result;
        return {
          turnId: `turn_${calls.length}`,
          sessionId: "codex-session-id",
          roleSessionId: "session_0123456789abcdef01234567",
          result: result as T,
          resultHash: `hash_${calls.length}`,
        };
      },
    },
  };
}

test("Lead planning persists a fake turn result and reuses the Lead role session", async () => {
  const value = await fixture();
  const fake = fakeTurnRunner({ "lead-plan": () => routinePlan(), "lead-plan-revision": () => routinePlan("A revised fixture plan") });
  try {
    await writeFile(join(value.repositoryPath, "shared-untracked.txt"), "keep\n");
    value.database.authQuery((db) => db.prepare("UPDATE forge_profiles SET provider = 'claude' WHERE id = 'profile_1'").run());
    const service = new AgentService(value.database, value.config, { turnRunner: fake.turnRunner });
    const result = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 1 });
    expect(result.leadSessionRef).toBe("session_0123456789abcdef01234567");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ promptKind: "lead-plan", executionRole: "planner" });
    const worktreePath = join(value.root, "worktrees", "task_1");
    const branchName = buildGitBranchName({ branchSlug: fallbackGitPresentation("Fixture task").branchSlug, taskId: "task_1" });
    expect(fake.calls[0]?.task.worktreePath).toBe(worktreePath);
    expect(await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: worktreePath })).toMatchObject({ stdout: `${branchName}\n` });
    expect(await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).toMatchObject({ stdout: `${value.targetSha}\n` });
    expect(await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: value.repositoryPath })).toMatchObject({ stdout: `${value.targetSha}\n` });
    expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: value.repositoryPath })).stdout).toContain("shared-untracked.txt");
    expect(fake.calls[0]?.prompt).toContain("Plan only work that can be completed and verified inside an isolated git worktree.");
    const briefSha = value.database.authQuery((db) => (db.prepare("SELECT sha256 FROM forge_artifacts WHERE id = ?").get(value.briefId) as { sha256: string }).sha256);
    value.database.authQuery((db) => db.prepare("UPDATE forge_profiles SET model = 'changed-after-task-creation' WHERE id = 'profile_1'").run());
    const resumed = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 2, resume: { leadSessionRef: result.leadSessionRef, reason: "member_revision", instructionArtifactId: value.briefId, instructionSha256: briefSha } });
    expect(resumed.leadSessionRef).toBe(result.leadSessionRef);
    expect(fake.calls[1]).toMatchObject({ promptKind: "lead-plan", profile: { model: "gpt-5-codex" } });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, provider, session_ref, process_pid, process_group_id FROM forge_agent_executions WHERE id = ?").get(result.leadExecutionId))).toEqual({ status: "completed", provider: "claude", session_ref: result.leadSessionRef, process_pid: null, process_group_id: null });
    const evidence = value.database.authQuery((db) => db.prepare("SELECT a.storage_path, a.sha256 FROM forge_artifacts a WHERE a.id = ?").get(result.leadEvidenceArtifactId) as { storage_path: string; sha256: string });
    const evidenceText = await new ArtifactStore(value.config.artifactRoot).getArtifact({ companyId: "company_1", storagePath: evidence.storage_path, sha256: evidence.sha256 });
    expect(evidenceText).toEqual(Buffer.from("\n"));
    expect(value.database.authQuery((db) => db.prepare("SELECT output_kind AS kind, output_revision AS revision, session_ref FROM forge_agent_executions WHERE task_id = 'task_1' AND output_artifact_id IS NOT NULL").get())).toEqual({ kind: "plan", revision: 1, session_ref: result.leadSessionRef });
    value.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET provider = NULL WHERE session_ref = ?").run(result.leadSessionRef));
    const pinnedClaude = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 3, resume: { leadSessionRef: result.leadSessionRef, reason: "member_revision", instructionArtifactId: value.briefId, instructionSha256: briefSha } });
    expect(fake.calls[2]).toMatchObject({ promptKind: "lead-plan", profile: { provider: "claude" } });
    value.database.authQuery((db) => {
      db.prepare("DELETE FROM forge_profiles WHERE id = 'profile_1'").run();
      db.prepare("UPDATE forge_agent_executions SET provider = NULL WHERE session_ref = ?").run(result.leadSessionRef);
    });
    await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 4, resume: { leadSessionRef: pinnedClaude.leadSessionRef, reason: "member_revision", instructionArtifactId: value.briefId, instructionSha256: briefSha } });
    expect(fake.calls[3]).toMatchObject({ promptKind: "lead-plan", profile: { provider: "codex" } });
    expect(fake.calls).toHaveLength(4);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
test("Lead planning persists a legacy task description and ignores a stale brief input", async () => {
  const value = await fixture("gpt-5-codex", "Legacy task text");
  const fake = fakeTurnRunner({ "lead-plan": () => routinePlan() });
  try {
    const service = new AgentService(value.database, value.config, { turnRunner: fake.turnRunner });
    await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: "stale-brief", imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 1 });
    expect(fake.calls[0]?.prompt).toContain("Legacy task text");
    expect(value.database.authQuery((db) => db.prepare("SELECT description FROM forge_tasks WHERE id = 'task_1'").get())).toEqual({ description: "Legacy task text" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
test("a description edit after planning admission cannot change its sent prompt", async () => {
  const value = await fixture("gpt-5-codex", "Admitted task text");
  const fake = fakeTurnRunner({ "lead-plan": () => {
    value.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET description = 'Edited after admission' WHERE id = 'task_1'").run());
    return routinePlan();
  } });
  try {
    const service = new AgentService(value.database, value.config, { turnRunner: fake.turnRunner });
    await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 1 });
    expect(fake.calls[0]?.prompt).toContain("Admitted task text");
    expect(fake.calls[0]?.prompt).not.toContain("Edited after admission");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Lead planning omits test-suite commands when project tests are disabled", async () => {
  const value = await fixture();
  const fake = fakeTurnRunner({ "lead-plan": () => routinePlan() });
  try {
    value.database.authQuery((db) => db.prepare("UPDATE forge_tasks SET run_project_tests = 0 WHERE id = 'task_1'").run());
    const service = new AgentService(value.database, value.config, { turnRunner: fake.turnRunner });
    await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 1 });
    expect(fake.calls[0]?.prompt).toContain("Do not include test-suite commands in verificationCommands");
    expect(fake.calls[0]?.prompt).toContain("type checking, linting, builds, and git status");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Lead delivery review prompt honors Screenshots off", async () => {
  const value = await fixture();
  try {
    const service = new AgentService(value.database, value.config);
    const promptRenderer = service as unknown as {
      deliveryReviewPrompt: (
        input: { taskId: string; companyId: string; visualEvidence: "off" },
        title: string, brief: string, plan: string, delivery: string, developerEvidence: string,
        gitEvidence: { targetBaseSha: string; subjectCommit: string; subjectTree: string; status: string; branch: string; head: string; tree: string; diff: string; commit: string; instructions: string },
        forwardMerge: null, hasDeveloperSession: boolean,
      ) => string;
    };
    const prompt = promptRenderer.deliveryReviewPrompt({ taskId: "task_1", companyId: "company_1", visualEvidence: "off" }, "Fixture task", "brief", "plan", "delivery", "evidence", { targetBaseSha: "a".repeat(40), subjectCommit: "b".repeat(40), subjectTree: "c".repeat(40), status: "", branch: "forge/task", head: "b".repeat(40), tree: "c".repeat(40), diff: "", commit: "", instructions: "Capture browser proof." }, null, true);
    expect(prompt).toContain("Browser proof (screenshots, Playwright/browser inspection) is turned OFF for this task by the member. Do not require, plan, or request it, and never block on its absence, even if repository instructions such as AGENTS.md ask for it. At most mention it as advisory.");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("Lead decision blockers retain the immutable output artifact SHA-256", async () => {
  const value = await fixture();
  const fake = fakeTurnRunner({ "lead-plan": () => decisionBlocker() });
  try {
    const service = new AgentService(value.database, value.config, { turnRunner: fake.turnRunner });
    const result = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 1 });
    expect(result.blockerSubject).toMatchObject({
      artifactId: result.leadOutputArtifactId,
      artifactSha256: result.leadOutputSha256,
    });
    expect(result.blockerSubject?.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Lead planning carries a member blocker answer in a revision prompt", async () => {
  const value = await fixture("gpt-5-codex", "Initial brief that must not be repeated.");
  const answerStore = new ArtifactStore(value.config.artifactRoot);
  const answer = await answerStore.putArtifact("company_1", "plan-blocker-response", { filename: "answer.md", mimeType: "text/markdown", bytes: Buffer.from("Use the 30-day retention policy.") });
  value.database.authQuery((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company_1', 'task_1', ?, ?, ?, ?, ?, ?, ?)").run(answer.id, answer.kind, answer.filename, answer.mimeType, answer.byteSize, answer.sha256, answer.storagePath, answer.createdAt));
  const fake = fakeTurnRunner({ "lead-plan-revision": () => routinePlan("Plan revised after the blocker answer") });
  try {
    const service = new AgentService(value.database, value.config, { turnRunner: fake.turnRunner });
    await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1" }, revision: 2, leadSessionRef: "session_0123456789abcdef01234567", memberResponseArtifactId: answer.id });
    expect(fake.calls[0]).toMatchObject({ promptKind: "lead-plan-revision" });
    expect(fake.calls[0]?.prompt).toContain("Human blocker answer:\nUse the 30-day retention policy.");
    expect(fake.calls[0]?.prompt).not.toContain("Initial brief that must not be repeated.");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a failed planning turn is reclaimed by its deterministic turn key with its cause", async () => {
  const value = await fixture();
  let calls = 0;
  const fake = fakeTurnRunner({
    "lead-plan": () => {
      calls += 1;
      return calls === 1 ? new Error("workspace w2E not found") : routinePlan();
    },
  });
  const input = {
    taskId: "task_1",
    companyId: "company_1",
    workflowId: "workflow-test-issue-task_1",
    projectId: "project_1",
    projectRevisionId: "revision_1",
    briefArtifactId: value.briefId,
    imageArtifactIds: [],
    roleProfiles: { planner: "profile_1" },
    revision: 1,
  };
  try {
    const service = new AgentService(value.database, value.config, {
      turnRunner: fake.turnRunner,
    });
    await expect(service.runLeadPlanning(input)).rejects.toMatchObject({
      code: "lead-failed",
      message: "Codex Lead execution failed: workspace w2E not found",
    });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, attempt, failure_summary FROM forge_agent_executions WHERE turn_key = ?").get(`${input.workflowId}:lead-planning:${input.revision}`))).toEqual({
      status: "failed",
      attempt: 1,
      failure_summary: "Codex Lead execution failed: workspace w2E not found",
    });

    await expect(service.runLeadPlanning(input)).resolves.toMatchObject({
      leadSessionRef: "session_0123456789abcdef01234567",
    });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, attempt, failure_code, failure_summary FROM forge_agent_executions WHERE turn_key = ?").get(`${input.workflowId}:lead-planning:${input.revision}`))).toEqual({
      status: "completed",
      attempt: 2,
      failure_code: null,
      failure_summary: null,
    });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});


test("Lead output schema rejects unresolved technical questions and malformed blockers", () => {
  expect(LeadOutputSchema.safeParse({ kind: "plan", gitPresentation, summary: "x", reproduction: null, rootCauseAnalysis: null, steps: [], compatibilityAnalysis: "x", operationalAnalysis: "x", verificationStrategy: "x", unresolvedTechnicalQuestions: ["choose"] }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ kind: "decision_blocker", summary: "x", evidence: "x", owner: "developer", askUserQuestion: { header: "Decision", id: "decision", question: "Which?", options: [{ label: "First (Recommended)", description: "First" }, { label: "Second", description: "Second" }, { label: "Third", description: "Third" }], isOther: true, isSecret: false }, nextAction: "x" }).success).toBe(false);
});

test("delivery review schema separates advisory approval from blocking repair", () => {
  const advisory = { kind: "delivery_review" as const, summary: "The delivery is acceptable with one follow-up note.", outcome: "approved" as const, findings: [{ findingId: "finding_advisory", severity: "advisory" as const, rationale: "The test could be more explicit.", evidenceRef: "delivery report step 1", disposition: "open" as const, repairInstruction: null }], repairPlan: null };
  const blocking = { ...advisory, outcome: "blocking" as const, findings: [{ findingId: "finding_blocking", severity: "blocking" as const, rationale: "The exact acceptance file is missing.", evidenceRef: "diff: missing proof file", disposition: "open" as const, repairInstruction: "Create the missing acceptance file." }], repairPlan: "Create the missing acceptance file and rerun the focused check." };
  expect(DeliveryReviewSchema.safeParse(advisory).success).toBe(true);
  expect(DeliveryReviewSchema.safeParse(blocking).success).toBe(true);
  expect(DeliveryReviewSchema.safeParse({ ...advisory, outcome: "approved", findings: blocking.findings }).success).toBe(false);
  expect(DeliveryReviewSchema.safeParse({ ...blocking, findings: [{ ...blocking.findings[0], disposition: "repaired" }], repairPlan: null }).success).toBe(false);
  expect(DeliveryReviewSchema.safeParse({ ...advisory, findings: [advisory.findings[0], advisory.findings[0]] }).success).toBe(false);
});

test("delivery activity result schemas reject unsafe or incomplete branches", () => {
  const subject = { planRevision: 1, targetBaseSha: "a".repeat(40), subjectCommit: "b".repeat(40), subjectTree: "c".repeat(40), developerExecutionId: "developer_1", deliveryArtifactId: "artifact_delivery", developerEvidenceArtifactId: "artifact_evidence", leadSessionRef: "session_lead", developerSessionRef: "session_developer" };
  const review = { reviewId: "delivery_review_1", leadExecutionId: "agent_lead_1", leadSessionRef: "session_lead", opinionArtifactId: "artifact_opinion", evidenceArtifactId: "artifact_evidence", opinion: "approved" as const, summary: "Approved.", repairPlan: null, findings: [], supersedesReviewId: null };
  const completed = { outcome: "completed" as const, attemptId: "review_attempt_1", correctionAttempts: 0, subject, review };
  expect(DeliveryReviewActivityResultSchema.safeParse(completed).success).toBe(true);
  expect(DeliveryReviewActivityResultSchema.safeParse({ ...completed, correctionAttempts: 2 }).success).toBe(false);
  expect(DeliveryReviewActivityResultSchema.safeParse({ ...completed, review: undefined }).success).toBe(false);
  expect(DeliveryReviewActivityResultSchema.safeParse({ ...completed, subject: { ...subject, subjectCommit: "not-a-sha" } }).success).toBe(false);
  expect(DeliveryReviewActivityResultSchema.safeParse({ outcome: "blocked", attemptId: "review_attempt_2", code: "not-a-code", summary: "Blocked.", evidenceArtifactId: "artifact_evidence", executionId: "agent_lead_2", sessionRef: "session_lead", correctionAttempts: 0, subject }).success).toBe(false);
  expect(DeliveryReviewActivityResultSchema.safeParse({ outcome: "blocked", attemptId: "review_attempt_2", code: "process-failed", summary: "x".repeat(501), evidenceArtifactId: "artifact_evidence", executionId: "agent_lead_2", sessionRef: "session_lead", correctionAttempts: 0, subject }).success).toBe(false);
  expect(DeliveryReviewActivityResultSchema.safeParse({ outcome: "blocked", attemptId: "review_attempt_2", code: "process-failed", summary: "Blocked.", evidenceArtifactId: "artifact_evidence", executionId: "agent_lead_2", sessionRef: "session_lead", correctionAttempts: 0, subject, review }).success).toBe(false);
  expect(DeliveryOperationBlockCodeSchema.safeParse("review-infrastructure-failure").success).toBe(false);
  const repair = { outcome: "completed" as const, repairAttemptId: "repair_1", cycle: 1, reviewId: "delivery_review_1", subject, developerExecutionId: "developer_2", developerSessionRef: "session_developer", worktreePath: "/owned/worktree", branchName: "forge/issue/task_1", resultCommit: "d".repeat(40), resultTree: "e".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_repaired", evidenceArtifactId: "artifact_repair_evidence", summary: "Repaired." };
  expect(DeveloperRepairActivityResultSchema.safeParse(repair).success).toBe(true);
  expect(DeveloperRepairActivityResultSchema.safeParse({ ...repair, resultCommit: "bad" }).success).toBe(false);
  expect(DeveloperRepairActivityResultSchema.safeParse({ ...repair, outcome: "blocked", code: "process-failed", summary: "Blocked.", evidenceArtifactId: "artifact_repair_evidence", resultCommit: null, resultTree: null, dirtyState: null }).success).toBe(false);
});

test("delivery review preflight failures finalize a typed attempt without launching Codex", async () => {
  const value = await fixture();
  try {
    const service = new AgentService(value.database, value.config);
    const invalidInput = {
      taskId: "task_1",
      companyId: "company_1",
      workflowId: "workflow-test-issue-task_1",
      projectId: "project_1",
      projectRevisionId: "revision_1",
      briefArtifactId: value.briefId,
      planRevision: 1,
      roleProfiles: { planner: "profile_1", builder: "profile_1" },
      leadOutputArtifactId: "lead_output_missing",
      subject: {
        planRevision: 1,
        targetBaseSha: "a".repeat(40),
        subjectCommit: "b".repeat(40),
        subjectTree: "c".repeat(40),
        developerExecutionId: "developer_missing",
        deliveryArtifactId: "delivery_missing",
        developerEvidenceArtifactId: "developer_evidence_missing",
        leadSessionRef: "session_lead",
        developerSessionRef: "session_developer",
      },
      worktreePath: join(value.root, "worktrees", "task-1"),
      branchName: "forge/issue/task_1",
      supersedesReviewId: null,
    };
    await expect(service.reviewDelivery(invalidInput)).rejects.toMatchObject({ code: "scoped-input-missing" });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_delivery_review_attempts").get())).toEqual({ count: 0 });

    const artifactStore = new ArtifactStore(value.config.artifactRoot);
    const delivery = await artifactStore.putArtifact("company_1", "developer-delivery", { filename: "preflight-delivery.json", mimeType: "application/json", bytes: Buffer.from("{\"kind\":\"delivery\"}") });
    const evidence = await artifactStore.putArtifact("company_1", "agent-evidence", { filename: "preflight-evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"developer\"}\n") });
    const now = new Date().toISOString();
    value.database.authTransaction((db) => {
      for (const artifact of [delivery, evidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_preflight', 'task_1', 'company_1', 'workflow-test-issue-task_1', 1, 1, 'completed', 'forge/issue/task_1', ?, ?, 'session_developer', ?, ?, ?, ?, 'clean', ?, ?)").run(invalidInput.worktreePath, "a".repeat(40), now, now, "b".repeat(40), "c".repeat(40), delivery.id, evidence.id);
    });
    const result = await service.reviewDelivery({ ...invalidInput, subject: { ...invalidInput.subject, developerExecutionId: "developer_preflight", deliveryArtifactId: delivery.id, developerEvidenceArtifactId: evidence.id } });
    expect(result).toMatchObject({ outcome: "blocked", code: "preflight-failed", summary: "The current delivery artifact is unavailable", correctionAttempts: 0 });
    if (result.outcome !== "blocked") throw new Error("Expected a typed blocked review result");
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, failure_summary, completed_review_id, evidence_artifact_id, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id FROM forge_delivery_review_attempts WHERE id = ?").get(result.attemptId))).toMatchObject({ status: "blocked", failure_code: "preflight-failed", failure_summary: "The current delivery artifact is unavailable", completed_review_id: null, evidence_artifact_id: result.evidenceArtifactId, developer_execution_id: "developer_preflight", delivery_artifact_id: delivery.id, developer_evidence_artifact_id: evidence.id });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, failure_summary, evidence_artifact_id FROM forge_agent_executions WHERE id = ?").get(result.executionId))).toEqual({ status: "blocked", failure_code: "preflight-failed", failure_summary: "The current delivery artifact is unavailable", evidence_artifact_id: result.evidenceArtifactId });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Lead authors a complete conflict-resolution plan from both merge sides", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const worktreePath = join(value.root, "worktrees", "task-1");
  await mkdir(worktreePath, { recursive: true });
  const plan = await artifactStore.putArtifact("company_1", "lead-plan", { filename: "approved.json", mimeType: "application/json", bytes: Buffer.from("{\"kind\":\"plan\"}") });
  const leadEvidence = await artifactStore.putArtifact("company_1", "agent-evidence", { filename: "lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"lead\"}\n") });
  const conflictArtifact = await artifactStore.putArtifact("company_1", "forward-merge-conflict", { filename: "conflict.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, checkpoint: "pre_release", expectedBaseSha: "b".repeat(40), observedBaseSha: "b".repeat(40), priorHead: "a".repeat(40), priorTree: "a".repeat(40), conflictFiles: ["shared.txt"], combinedDiff: "<<<<<<< HEAD\nissue\n=======\nbase\n>>>>>>> base", priorCommitSummary: "", baseCommitSummary: "", commandEvidence: { command: "git diff --cc --no-ext-diff", complete: true } })) });
  const now = new Date().toISOString();
  value.database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_integrator', 'Integrator', 'codex', 'gpt-5.6-luna', 'low', 'fast', 1, ?, ?)").run(now, now);
    for (const artifact of [plan, leadEvidence, conflictArtifact]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, conflict_artifact_id, conflict_artifact_sha256, conflict_file_count, updated_at) VALUES ('merge-lead-1', 'task_1', 'company_1', ?, ?, ?, NULL, NULL, 'conflict', '[\"shared.txt\"]', ?, 'workflow-test-issue-task_1', 'revision_1', 'pre_release', ?, ?, ?, 1, ?)").run("b".repeat(40), "b".repeat(40), "a".repeat(40), now, "a".repeat(40), conflictArtifact.id, conflictArtifact.sha256, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_conflict_lead', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'planner', 'completed', 1, 'session_lead', ?, ?, ?)").run(now, now, leadEvidence.id);
    db.prepare("UPDATE forge_agent_executions SET output_kind = 'plan', output_revision = 1, output_artifact_id = ?, output_summary = 'Approved plan' WHERE id = 'agent_conflict_lead'").run(plan.id);
  });
  const fake = fakeTurnRunner({
    "merge-conflict-plan": () => ({ kind: "merge_conflict_plan", summary: "Resolve the shared file from both sides.", resolutions: [{ number: 1, file: "shared.txt", resolution: "Preserve the issue behavior and incorporate the target-base validation.", intendedResult: "The merged file preserves both required behaviors.", issueInvariant: "The issue behavior remains intact.", baseInvariant: "The target-base behavior remains intact.", compatibilityConcern: "The merged file keeps its existing format." }], verificationStrategy: "Run the complete local verification suite after creating the merge commit.", unresolvedQuestions: [] }),
  });
  try {
    const service = new AgentService(value.database, value.config, { turnRunner: fake.turnRunner });
    const result = await service.planMergeConflict({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, forwardMergeId: "merge-lead-1", roleProfiles: { planner: "profile_1", integrator: "profile_integrator" }, executionRole: "integrator", leadSessionRef: "session_lead", leadOutputArtifactId: plan.id, worktreePath, branchName: "forge/issue/task_1", priorHead: "a".repeat(40), targetBaseSha: "b".repeat(40), conflictArtifact: { id: conflictArtifact.id, kind: "forward-merge-conflict" }, conflictFileCount: 1 });
    expect(result).toMatchObject({ leadSessionRef: "session_0123456789abcdef01234567", summary: "Resolve the shared file from both sides." });
    expect(fake.calls[0]).toMatchObject({ promptKind: "merge-conflict-plan", executionRole: "integrator" });
    expect(value.database.authQuery((db) => db.prepare("SELECT role, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority FROM forge_agent_executions WHERE id = ?").get(result.leadExecutionId))).toEqual({ role: "integrator", profile_id: "profile_integrator", resolved_model: "gpt-5.6-luna", resolved_reasoning_level: "low", resolved_service_priority: "fast" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, lead_session_ref FROM forge_merge_conflict_resolutions WHERE id = ?").get(result.planId))).toEqual({ status: "planned", lead_session_ref: "session_0123456789abcdef01234567" });
    const second = await service.planMergeConflict({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, forwardMergeId: "merge-lead-1", leadSessionRef: "session_lead", leadOutputArtifactId: plan.id, worktreePath, branchName: "forge/issue/task_1", priorHead: "a".repeat(40), targetBaseSha: "b".repeat(40), conflictArtifact: { id: conflictArtifact.id, kind: "forward-merge-conflict" }, conflictFileCount: 1 });
    expect(second.planId).toBe(result.planId);
    const count = value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_merge_conflict_resolutions WHERE workflow_id = 'workflow-test-issue-task_1' AND prior_head = ? AND target_base_sha = ?").get("a".repeat(40), "b".repeat(40))) as { count: number };
    expect(count.count).toBe(1);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});


test("permanent agent failures become non-retryable Engine application failures", () => {
  expect(asNonRetryableApplicationFailure(new AgentFailure("process-exited", "Codex exited"))).toBeUndefined();
  const actual = asNonRetryableApplicationFailure(new AgentFailure("model-unavailable", "Choose a supported model", { nonRetryable: true }));
  expect(actual).toBeInstanceOf(ApplicationFailure);
  expect(actual).toMatchObject({ type: "model-unavailable", nonRetryable: true, message: "Choose a supported model", details: [{ code: "model-unavailable", summary: "Choose a supported model" }] });
});
test("supplemental review uses a fresh session and primary Lead consolidation resumes its session", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const draft = await artifactStore.putArtifact("company_1", "lead-plan", { filename: "draft.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", gitPresentation, summary: "Draft plan", reproduction: null, rootCauseAnalysis: "Fixture root cause", steps: [{ number: 1, instruction: "Inspect repository", entryPoint: null, completionCriterion: "The repository is understood", verification: "The check passes", verificationCommands: [] }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Run tests.", unresolvedTechnicalQuestions: [], materialCategories: [], affectedPaths: ["README.md"], materiality: [] })) });
  const priorEvidence = await artifactStore.putArtifact("company_1", "agent-evidence", { filename: "prior.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"turn.completed\"}\n") });
  value.database.authTransaction((db) => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_2', 'Reviewer', 'codex', 'gpt-5.6-luna', 'medium', 'standard', 1, ?, ?)").run(now, now);
    for (const artifact of [draft, priorEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_primary', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'planner', 'completed', 1, 'session_primary', ?, ?, ?)").run(now, now, priorEvidence.id);
    db.prepare("UPDATE forge_agent_executions SET output_kind = 'plan', output_revision = 1, output_artifact_id = ?, output_summary = 'Draft plan' WHERE id = 'agent_primary'").run(draft.id);
    db.prepare("UPDATE forge_tasks SET description = 'Runtime review description', brief_artifact_id = project_configuration_artifact_id WHERE id = 'task_1'").run();
  });
  let reviewArtifactId = "";
  const fake = fakeTurnRunner({
    "supplemental-review": () => ({ verdict: "approve", summary: "Review is independent", concerns: [] }),
    "lead-consolidation": () => ({
      version: 1,
      originalPlanRevision: 2,
      reviewArtifactId,
      reviewResponse: "The independent review is addressed by the consolidated plan.",
      result: routinePlan("Consolidated plan"),
    }),
  });
  try {
    const service = new AgentService(value.database, value.config, { turnRunner: fake.turnRunner });
    const review = await service.runSupplementalReview({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: "stale-brief", imageArtifactIds: [], roleProfiles: { planner: "profile_1", reviewer: "profile_2" }, revision: 1, leadOutputArtifactId: draft.id, leadEvidenceArtifactId: priorEvidence.id });
    reviewArtifactId = review.reviewArtifactId;
    const consolidated = await service.consolidateLeadPlan({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { planner: "profile_1", reviewer: "profile_2" }, revision: 2, leadSessionRef: "session_primary", leadOutputArtifactId: draft.id, supplementalReviewArtifactId: review.reviewArtifactId });
    expect(review.sessionRef).toBe("session_0123456789abcdef01234567");
    expect(consolidated.leadSessionRef).toBe("session_0123456789abcdef01234567");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toMatchObject({ promptKind: "supplemental-review", executionRole: "reviewer" });
    expect(fake.calls[0]?.prompt).toContain("Runtime review description");
    expect(fake.calls[1]).toMatchObject({ promptKind: "lead-consolidation", executionRole: "planner" });
    expect(value.database.authQuery((db) => db.prepare("SELECT profile_id, session_ref, summary FROM forge_plan_reviews WHERE id = ?").get(review.reviewId))).toEqual({ profile_id: "profile_2", session_ref: "session_0123456789abcdef01234567", summary: "Review is independent" });
    expect(value.database.authQuery((db) => db.prepare("SELECT planner_response_artifact_id FROM forge_plan_reviews WHERE id = ?").get(review.reviewId))).toEqual({ planner_response_artifact_id: consolidated.leadReviewResponseArtifactId });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

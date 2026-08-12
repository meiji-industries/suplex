import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";

import { ArtifactStore } from "../src/artifacts.js";
import { AgentFailure, AgentService, LeadOutputSchema, resolveAgentCommand, runCodexProcess, type LeadProcessRunner, type SessionStore } from "../src/codex-lead.js";
import { DeveloperService } from "../src/codex-developer.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase, ProjectionIntegrityFailure } from "../src/database.js";
import { asNonRetryableApplicationFailure, createActivities } from "../src/temporal/activities.js";
import { DeliveryReviewSchema } from "../src/temporal/issue-contracts.js";

const execFileAsync = promisify(execFile);

test("Codex command resolution bypasses a mise shim that depends on target trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-command-resolution-test-"));
  const shimDirectory = join(root, "shims");
  const binaryDirectory = join(root, "bin");
  await mkdir(shimDirectory);
  await mkdir(binaryDirectory);
  const mise = join(root, "mise");
  const codex = join(binaryDirectory, "codex");
  await writeFile(mise, "#!/bin/sh\nexit 1\n");
  await writeFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(mise, 0o700);
  await chmod(codex, 0o700);
  await symlink(mise, join(shimDirectory, "codex"));
  try {
    expect(resolveAgentCommand("codex", `${shimDirectory}${delimiter}${binaryDirectory}`)).toBe(codex);
    expect(resolveAgentCommand("custom-agent", `${shimDirectory}${delimiter}${binaryDirectory}`)).toBe("custom-agent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(model = "gpt-5-codex", briefText = "Investigate the fixture repository."): Promise<{ root: string; database: ForgeDatabase; config: ReturnType<typeof createTestConfig>; briefId: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-lead-test-"));
  const repositoryPath = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await writeFile(join(repositoryPath, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }));
  await writeFile(join(repositoryPath, ".gitignore"), "node_modules/\n");
  await execFileAsync("pnpm", ["install", "--lockfile-only"], { cwd: repositoryPath });
  await execFileAsync("git", ["init"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "forge-test@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Forge Test"], { cwd: repositoryPath });
  await execFileAsync("git", ["add", "README.md", "package.json", ".gitignore", "pnpm-lock.yaml"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repositoryPath });
  const config = createTestConfig(root, { repositoryRoot: root, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const artifactStore = new ArtifactStore(config.artifactRoot);
  const brief = await artifactStore.put("company_1", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from(briefText) });
  const targetSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
  database.authQuery((db) => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'Forge Test', 'forge-test', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company One', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_1', 'Lead', 'codex', ?, 'medium', 'standard', 1, ?, ?)").run(model, now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project One', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[]', '[\"profile_1\"]', '{\"lead\":\"profile_1\"}', 'active', 'revision_1', ?, ?)").run(repositoryPath, join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('revision_1', 'project_1', 1, 'identity_1', ?, ?, ?, 'user_1', ?)").run(JSON.stringify({ repository: "acme/forge", repositoryPath, worktreeRoot, baseBranch: "main", targetBranch: "main", baseSha: targetSha, targetSha, setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: [] }), targetSha, targetSha, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company_1', ?, ?, ?, ?, ?, ?, ?)").run(brief.id, brief.kind, brief.filename, brief.mimeType, brief.byteSize, brief.sha256, brief.storagePath, brief.createdAt);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Fixture task', ?, '[]', '{\"lead\":\"profile_1\"}', 0, 'workflow-test-issue-task_1', 'revision_1', 'idempotency_1', ?, ?)").run(brief.id, now, now);
  });
  return { root, database, config, briefId: brief.id };
}

test("Lead planning resumes the same opaque session after malformed JSON and stores only sanitized evidence", async () => {
  const value = await fixture();
  const sessions = new Map<string, string>();
  const sessionStore: SessionStore = { async create(raw) { sessions.set("session_opaque", raw); return "session_opaque"; }, async read(ref) { return sessions.get(ref) ?? ""; } };
  const calls: string[][] = [];
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4321, "2026-08-11T00:00:00.000Z");
    calls.push(invocation.args);
    if (calls.length === 1) {
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-session-1" }));
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "not json Bearer gho_secret" } }));
    } else {
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "plan", summary: "A bounded fixture plan", reproduction: null, rootCauseAnalysis: "The fixture was incomplete.", steps: [{ number: 1, instruction: "Inspect the fixture", verification: "The fixture test passes" }], compatibilityAnalysis: "No compatibility change is required.", operationalAnalysis: "The change is local.", verificationStrategy: "Run the focused suite.", unresolvedTechnicalQuestions: [] }) } }));
    }
    return { exitCode: 0, stderr: "" };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore });
    const result = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 });
    expect(result.leadSessionRef).toBe("session_opaque");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("raw-session-1");
    expect(sessions.get("session_opaque")).toBe("raw-session-1");
    expect(value.database.authQuery((db) => db.prepare("SELECT status, session_ref, process_start_identity FROM forge_agent_executions WHERE id = ?").get(result.leadExecutionId))).toEqual({ status: "completed", session_ref: "session_opaque", process_start_identity: "4321:2026-08-11T00:00:00.000Z" });
    const evidence = value.database.authQuery((db) => db.prepare("SELECT a.storage_path, a.sha256 FROM forge_artifacts a WHERE a.id = ?").get(result.leadEvidenceArtifactId) as { storage_path: string; sha256: string });
    const evidenceText = await new ArtifactStore(value.config.artifactRoot).read({ companyId: "company_1", storagePath: evidence.storage_path, sha256: evidence.sha256 });
    expect(evidenceText.toString("utf8")).not.toContain("gho_secret");
    expect(value.database.authQuery((db) => db.prepare("SELECT kind, revision, session_ref FROM forge_issue_outputs WHERE task_id = 'task_1'").get())).toEqual({ kind: "plan", revision: 1, session_ref: "session_opaque" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Lead output schema rejects unresolved technical questions and malformed blockers", () => {
  expect(LeadOutputSchema.safeParse({ kind: "plan", summary: "x", reproduction: null, rootCauseAnalysis: null, steps: [], compatibilityAnalysis: "x", operationalAnalysis: "x", verificationStrategy: "x", unresolvedTechnicalQuestions: ["choose"] }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ kind: "decision_blocker", summary: "x", evidence: "x", owner: "developer", question: "x", nextAction: "x" }).success).toBe(false);
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

test("Lead authors a complete conflict-resolution plan from both merge sides", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const worktreePath = join(value.root, "worktrees", "task-1");
  await mkdir(worktreePath, { recursive: true });
  const plan = await artifactStore.put("company_1", "lead-plan", { filename: "approved.json", mimeType: "application/json", bytes: Buffer.from("{\"kind\":\"plan\"}") });
  const leadEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"lead\"}\n") });
  const conflictArtifact = await artifactStore.put("company_1", "forward-merge-conflict", { filename: "conflict.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, checkpoint: "pre_release", expectedBaseSha: "b".repeat(40), observedBaseSha: "b".repeat(40), priorHead: "a".repeat(40), priorTree: "a".repeat(40), conflictFiles: ["shared.txt"], combinedDiff: "<<<<<<< HEAD\nissue\n=======\nbase\n>>>>>>> base", priorCommitSummary: "", baseCommitSummary: "", commandEvidence: { command: "git diff --cc --no-ext-diff", complete: true } })) });
  const now = new Date().toISOString();
  value.database.authTransaction((db) => {
    for (const artifact of [plan, leadEvidence, conflictArtifact]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, conflict_artifact_id, conflict_artifact_sha256, conflict_file_count, updated_at) VALUES ('merge-lead-1', 'task_1', 'company_1', ?, ?, ?, NULL, NULL, 'conflict', '[\"shared.txt\"]', ?, 'workflow-test-issue-task_1', 'revision_1', 'pre_release', ?, ?, ?, 1, ?)").run("b".repeat(40), "b".repeat(40), "a".repeat(40), now, "a".repeat(40), conflictArtifact.id, conflictArtifact.sha256, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_conflict_lead', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_lead', ?, ?, ?)").run(now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_conflict_plan', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'agent_conflict_lead', 1, 'plan', ?, ?, 'session_lead', 'Approved plan', ?)").run(plan.id, leadEvidence.id, now);
  });
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4801, "2026-08-11T00:00:00.000Z");
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-lead" }));
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "merge_conflict_plan", summary: "Resolve the shared file from both sides.", resolutions: [{ number: 1, file: "shared.txt", resolution: "Preserve the issue behavior and incorporate the target-base validation.", intendedResult: "The merged file preserves both required behaviors.", issueInvariant: "The issue behavior remains intact.", baseInvariant: "The target-base behavior remains intact.", compatibilityConcern: "The merged file keeps its existing format." }], verificationStrategy: "Run the complete local verification suite after creating the merge commit.", unresolvedQuestions: [] }) } }));
    return { exitCode: 0, stderr: "" };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_lead"; }, async read() { return "raw-lead"; } } });
    const result = await service.planMergeConflict({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, forwardMergeId: "merge-lead-1", leadSessionRef: "session_lead", leadOutputArtifactId: plan.id, worktreePath, branchName: "forge/issue/task_1", priorHead: "a".repeat(40), targetBaseSha: "b".repeat(40), conflictArtifact: { id: conflictArtifact.id, sha256: conflictArtifact.sha256, kind: "forward-merge-conflict" }, conflictFileCount: 1 });
    expect(result).toMatchObject({ leadSessionRef: "session_lead", summary: "Resolve the shared file from both sides." });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, lead_session_ref FROM forge_merge_conflict_resolutions WHERE id = ?").get(result.planId))).toEqual({ status: "planned", lead_session_ref: "session_lead" });
    const second = await service.planMergeConflict({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, forwardMergeId: "merge-lead-1", leadSessionRef: "session_lead", leadOutputArtifactId: plan.id, worktreePath, branchName: "forge/issue/task_1", priorHead: "a".repeat(40), targetBaseSha: "b".repeat(40), conflictArtifact: { id: conflictArtifact.id, sha256: conflictArtifact.sha256, kind: "forward-merge-conflict" }, conflictFileCount: 1 });
    expect(second.planId).toBe(result.planId);
    const count = value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_merge_conflict_resolutions WHERE workflow_id = 'workflow-test-issue-task_1' AND prior_head = ? AND target_base_sha = ?").get("a".repeat(40), "b".repeat(40))) as { count: number };
    expect(count.count).toBe(1);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Lead planning classifies a successful process without schema output", async () => {
  const value = await fixture();
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4323, "2026-08-11T00:00:00.000Z");
    return { exitCode: 0, stderr: "" };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_missing"; }, async read() { return "raw-missing-session"; } } });
    await expect(service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 })).rejects.toMatchObject({ code: "missing-output" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test.each([
  ["login-expired", "OAuth authorization required", "Agent provider authentication is unavailable. Sign in again, then retry."],
  ["rate-limited", "HTTP 429: rate limit exceeded", "Agent provider rate limiting prevented this invocation from completing."],
  ["process-exited", "worker crashed", "The agent invocation did not complete."],
])("Lead process failures are typed without exposing provider stderr (%s)", async (code, stderr, summary) => {
  const value = await fixture();
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4322, "2026-08-11T00:00:00.000Z");
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-failure-session" }));
    return { exitCode: 1, stderr };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_failure"; }, async read() { return "raw-failure-session"; } } });
    await expect(service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 })).rejects.toMatchObject({ code });
    const failure = value.database.authQuery((db) => db.prepare("SELECT failure_code, failure_summary FROM forge_agent_executions WHERE task_id = 'task_1'").get() as { failure_code: string; failure_summary: string });
    expect(failure).toEqual({ failure_code: code, failure_summary: summary });
    expect(failure.failure_summary).not.toContain(stderr);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Lead planning treats a structured unsupported-model response as a permanent actionable failure", async () => {
  const value = await fixture("gpt-5-codex");
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4324, "2026-08-11T00:00:00.000Z");
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-model-failure" }));
    await invocation.onLine(JSON.stringify({ type: "error", message: JSON.stringify({ status: 400, error: { type: "invalid_request_error", message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account." } }) }));
    return { exitCode: 1, stderr: "" };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_model_failure"; }, async read() { return "raw-model-failure"; } } });
    await expect(service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 })).rejects.toMatchObject({
      code: "model-unavailable",
      nonRetryable: true,
      message: "The configured model “gpt-5-codex” is unavailable for the active provider account. Select a supported model, then retry.",
    });
    expect(value.database.authQuery((db) => db.prepare("SELECT failure_code, failure_summary FROM forge_agent_executions WHERE task_id = 'task_1'").get())).toEqual({
      failure_code: "model-unavailable",
      failure_summary: "The configured model “gpt-5-codex” is unavailable for the active provider account. Select a supported model, then retry.",
    });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("permanent agent failures become non-retryable Temporal application failures", () => {
  expect(asNonRetryableApplicationFailure(new AgentFailure("process-exited", "Codex exited"))).toBeUndefined();
  const actual = asNonRetryableApplicationFailure(new AgentFailure("model-unavailable", "Choose a supported model", { nonRetryable: true }));
  expect(actual).toBeInstanceOf(ApplicationFailure);
  expect(actual).toMatchObject({ type: "model-unavailable", nonRetryable: true, message: "Choose a supported model", details: [{ code: "model-unavailable", summary: "Choose a supported model" }] });
  expect(asNonRetryableApplicationFailure(new ProjectionIntegrityFailure("Projection identity conflict", { taskId: "task_1", revision: 0 }))).toMatchObject({ type: "projection_integrity_failure", nonRetryable: true, message: "Projection identity conflict" });
});

test("Developer activities preserve the configured service receiver", async () => {
  const value = await fixture();
  const developer = {
    calls: 0,
    async run() {
      this.calls += 1;
      return { developerExecutionId: "developer_bound", developerSessionRef: "session_bound", worktreePath: join(value.root, "worktrees", "task_1"), branchName: "forge/issue/task_1", targetBaseSha: "a".repeat(40), currentStep: 1, resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_delivery", evidenceArtifactId: "artifact_evidence", deliverySummary: "Bound Developer call", outcome: "completed" as const };
    },
  };
  try {
    const activities = createActivities(value.database, value.config, { developer });
    await activities.runDeveloperExecution({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { developer: "profile_1" }, leadSessionRef: "session_lead", leadOutputArtifactId: "artifact_plan" });
    expect(developer.calls).toBe(1);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, release_reason FROM forge_capacity_requests WHERE task_id = 'task_1' AND turn_kind = 'developer'").get())).toEqual({ status: "released", release_reason: "turn-completed" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("supplemental review uses a fresh session and primary Lead consolidation resumes its session", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const sessions = new Map([["session_primary", "raw-primary"]]);
  const sessionStore: SessionStore = { async create(raw) { sessions.set("session_review", raw); return "session_review"; }, async read(ref) { return sessions.get(ref) ?? ""; } };
  const draft = await artifactStore.put("company_1", "lead-plan", { filename: "draft.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Draft plan", reproduction: null, rootCauseAnalysis: "Fixture root cause", steps: [{ number: 1, instruction: "Inspect repository", verification: "The check passes" }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Run tests.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
  const priorEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "prior.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"turn.completed\"}\n") });
  value.database.authTransaction((db) => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_2', 'Reviewer', 'codex', 'gpt-5.6-luna', 'medium', 'standard', 1, ?, ?)").run(now, now);
    for (const artifact of [draft, priorEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_primary', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_primary', ?, ?, ?)").run(now, now, priorEvidence.id);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_primary', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'agent_primary', 1, 'plan', ?, ?, 'session_primary', 'Draft plan', ?)").run(draft.id, priorEvidence.id, now);
  });
  let calls = 0;
  const runner: LeadProcessRunner = async (invocation) => {
    calls += 1;
    await invocation.onStart(4500 + calls, `2026-08-11T00:00:0${calls}.000Z`);
    if (calls === 1) {
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-review" }));
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "review", summary: "Review is independent", opinion: "approve", concerns: [], requiredChanges: [] }) } }));
    } else {
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "plan", summary: "Consolidated plan", reproduction: null, rootCauseAnalysis: "Fixture root cause", steps: [{ number: 1, instruction: "Inspect repository", verification: "The check passes" }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Run tests.", unresolvedTechnicalQuestions: [], materialCategories: [] }) } }));
    }
    return { exitCode: 0, stderr: "" };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore });
    const review = await service.runSupplementalReview({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1", reviewer: "profile_2" }, revision: 1, leadOutputArtifactId: draft.id, leadEvidenceArtifactId: priorEvidence.id });
    const consolidated = await service.consolidateLeadPlan({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1", reviewer: "profile_2" }, revision: 2, leadSessionRef: "session_primary", leadOutputArtifactId: draft.id, supplementalReviewArtifactId: review.reviewArtifactId });
    expect(review.sessionRef).toBe("session_review");
    expect(consolidated.leadSessionRef).toBe("session_primary");
    expect(calls).toBe(2);
    expect(value.database.authQuery((db) => db.prepare("SELECT profile_id, session_ref, summary FROM forge_plan_reviews WHERE id = ?").get(review.reviewId))).toEqual({ profile_id: "profile_2", session_ref: "session_review", summary: "Review is independent" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Developer execution creates an isolated delivery commit and stores an exact report", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const sessions = new Map<string, string>();
  const sessionStore: SessionStore = { async create(raw) { sessions.set("session_developer", raw); return "session_developer"; }, async read(ref) { return sessions.get(ref) ?? ""; } };
  const plan = await artifactStore.put("company_1", "lead-plan", { filename: "approved.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "A bounded developer fixture", reproduction: null, rootCauseAnalysis: "The fixture needs a marker.", steps: [{ number: 1, instruction: "Add the fixture marker", verification: "The marker is present" }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Inspect the marker and commit.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
  const leadEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"lead\"}\n") });
  value.database.authTransaction((db) => {
    const now = new Date().toISOString();
    for (const artifact of [plan, leadEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_lead_for_developer', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_lead', ?, ?, ?)").run(now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_lead_for_developer', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'agent_lead_for_developer', 1, 'plan', ?, ?, 'session_lead', 'A bounded developer fixture', ?)").run(plan.id, leadEvidence.id, now);
  });
  const runner: LeadProcessRunner = async (invocation) => {
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--add-dir", await realpath(join(value.root, "repo", ".git", "worktrees", "task_1")),
      "--add-dir", await realpath(join(value.root, "repo", ".git")),
    ]));
    await invocation.onStart(4601, "2026-08-11T00:00:00.000Z");
    await writeFile(join(invocation.cwd, "MARKER.md"), "developer delivery\n");
    await execFileAsync("git", ["add", "MARKER.md"], { cwd: invocation.cwd });
    await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "Deliver fixture marker"], { cwd: invocation.cwd });
    const resultCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: invocation.cwd })).stdout.trim();
    const resultTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: invocation.cwd })).stdout.trim();
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer-session" }));
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "delivery", summary: "Marker delivered", steps: [{ number: 1, status: "completed", filesChanged: ["MARKER.md"], commandsRun: ["git add MARKER.md", "git commit"], testResults: ["Marker inspected"], notes: "Committed locally." }], authorizedStepsNotCompleted: [], resultCommit, resultTree, dirtyState: "clean", blocker: null }) } }));
    return { exitCode: 0, stderr: "" };
  };
  try {
    const service = new DeveloperService(value.database, value.config, { processRunner: runner, sessionStore });
    const result = await service.run({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", leadOutputArtifactId: plan.id });
    expect(result).toMatchObject({ outcome: "completed", developerSessionRef: "session_developer", branchName: "forge/issue/task_1", targetBaseSha: expect.any(String), dirtyState: "clean" });
    expect(result.developerSessionRef).not.toBe("session_lead");
    expect(value.database.authQuery((db) => db.prepare("SELECT status, attempt, session_ref, current_step, result_commit, dirty_state FROM forge_developer_executions WHERE id = ?").get(result.developerExecutionId))).toMatchObject({ status: "completed", attempt: 1, session_ref: "session_developer", current_step: 1, dirty_state: "clean" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Developer execution safely resumes an owned worktree after its result was lost", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const plan = await artifactStore.put("company_1", "lead-plan", { filename: "retry.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Retry the bounded developer fixture", reproduction: null, rootCauseAnalysis: "The fixture needs a marker.", steps: [{ number: 1, instruction: "Add the retry marker", verification: "The marker is present" }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Inspect the marker and commit.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
  const leadEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "lead-retry.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"lead\"}\n") });
  value.database.authTransaction((db) => {
    const now = new Date().toISOString();
    for (const artifact of [plan, leadEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_lead_for_retry', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_lead', ?, ?, ?)").run(now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_lead_for_retry', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'agent_lead_for_retry', 1, 'plan', ?, ?, 'session_lead', 'Retry the bounded developer fixture', ?)").run(plan.id, leadEvidence.id, now);
  });
  let calls = 0;
  const runner: LeadProcessRunner = async (invocation) => {
    calls += 1;
    await invocation.onStart(4650 + calls, `2026-08-11T00:00:0${calls}.000Z`);
    if (calls === 1) return { exitCode: 2, stderr: "provider transport closed" };
    await writeFile(join(invocation.cwd, "RETRY.md"), "recovered delivery\n");
    await execFileAsync("git", ["add", "RETRY.md"], { cwd: invocation.cwd });
    await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "Deliver retry marker"], { cwd: invocation.cwd });
    const resultCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: invocation.cwd })).stdout.trim();
    const resultTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: invocation.cwd })).stdout.trim();
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-retry-session" }));
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "delivery", summary: "Retry marker delivered", steps: [{ number: 1, status: "completed", filesChanged: ["RETRY.md"], commandsRun: ["git add RETRY.md", "git commit"], testResults: ["Marker inspected"], notes: "Committed locally." }], authorizedStepsNotCompleted: [], resultCommit, resultTree, dirtyState: "clean", blocker: null }) } }));
    return { exitCode: 0, stderr: "" };
  };
  const service = new DeveloperService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_retry"; }, async read() { return "raw-retry-session"; } } });
  const input = { taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", leadOutputArtifactId: plan.id };
  try {
    await expect(service.run(input)).rejects.toMatchObject({ code: "process-exited" });
    const failed = value.database.authQuery((db) => db.prepare("SELECT id, evidence_artifact_id FROM forge_developer_executions WHERE task_id = 'task_1' AND attempt = 1").get() as { id: string; evidence_artifact_id: string });
    const evidence = value.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ?").get(failed.evidence_artifact_id) as { storage_path: string });
    expect(await readFile(join(value.config.artifactRoot, evidence.storage_path), "utf8")).toContain("provider transport closed");
    const result = await service.run(input);
    expect(result).toMatchObject({ outcome: "completed", developerSessionRef: "session_retry", branchName: "forge/issue/task_1" });
    expect(value.database.authQuery((db) => db.prepare("SELECT attempt, supersedes_execution_id FROM forge_developer_executions WHERE id = ?").get(result.developerExecutionId))).toEqual({ attempt: 2, supersedes_execution_id: failed.id });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Lead reviews the exact Developer delivery and the same Developer session performs bounded repair", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const worktreePath = join(value.root, "worktrees", "task-1");
  await execFileAsync("git", ["worktree", "add", "-b", "forge/issue/task_1", worktreePath, "HEAD"], { cwd: join(value.root, "repo") });
  const targetBaseSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
  await writeFile(join(worktreePath, "DELIVERED.md"), "delivery\n");
  await execFileAsync("git", ["add", "DELIVERED.md"], { cwd: worktreePath });
  await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "Deliver exact fixture"], { cwd: worktreePath });
  const subjectCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
  const subjectTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: worktreePath })).stdout.trim();
  const plan = await artifactStore.put("company_1", "lead-plan", { filename: "review-plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Exact fixture plan", reproduction: null, rootCauseAnalysis: "The fixture needs a delivery marker.", steps: [{ number: 1, instruction: "Create the delivery marker.", verification: "The marker exists." }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Inspect the exact commit.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
  const leadEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "lead-review.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"lead\"}\n") });
  const delivery = await artifactStore.put("company_1", "developer-delivery", { filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from("{\"kind\":\"delivery\"}\n") });
  const developerEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "developer.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"developer\"}\n") });
  const now = new Date().toISOString();
  value.database.authTransaction((db) => {
    for (const artifact of [plan, leadEvidence, delivery, developerEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_lead_review', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_lead', ?, ?, ?)").run(now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_review_plan', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'agent_lead_review', 1, 'plan', ?, ?, 'session_lead', 'Exact fixture plan', ?)").run(plan.id, leadEvidence.id, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, current_step, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_review_subject', 'task_1', 'company_1', 'workflow-test-issue-task_1', 1, 1, 'completed', 'forge/issue/task_1', ?, ?, 'session_developer', 1, ?, ?, ?, ?, 'clean', ?, ?)").run(worktreePath, targetBaseSha, now, now, subjectCommit, subjectTree, delivery.id, developerEvidence.id);
  });
  const sessions = new Map([["session_lead", "raw-lead"], ["session_developer", "raw-developer"]]);
  const sessionStore: SessionStore = { async create(raw) { const ref = `session_${raw}`; sessions.set(ref, raw); return ref; }, async read(ref) { return sessions.get(ref) ?? ""; } };
  let reviewPrompt = "";
  const reviewRunner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4701, "2026-08-11T00:00:00.000Z");
    reviewPrompt = invocation.args.at(-1) ?? "";
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-lead" }));
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "delivery_review", summary: "One required repair remains.", outcome: "blocking", findings: [{ findingId: "finding_blocking", severity: "blocking", rationale: "The proof marker is incomplete.", evidenceRef: "DELIVERED.md", disposition: "open", repairInstruction: "Complete the proof marker." }, { findingId: "finding_advisory", severity: "advisory", rationale: "The report could be more detailed.", evidenceRef: "delivery report", disposition: "open", repairInstruction: null }], repairPlan: "Complete DELIVERED.md with the required proof text." }) } }));
    return { exitCode: 0, stderr: "" };
  };
  try {
    const lead = new AgentService(value.database, value.config, { processRunner: reviewRunner, sessionStore });
    const review = await lead.reviewDelivery({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", leadOutputArtifactId: plan.id, developerExecutionId: "developer_review_subject", deliveryArtifactId: delivery.id, evidenceArtifactId: developerEvidence.id, worktreePath, branchName: "forge/issue/task_1", targetBaseSha, subjectCommit, subjectTree });
    expect(review).toMatchObject({ outcome: "blocking", leadSessionRef: "session_lead", subjectCommit, subjectTree });
    expect(reviewPrompt).toContain(targetBaseSha);
    expect(reviewPrompt).toContain(subjectCommit);
    expect(reviewPrompt).toContain(subjectTree);
    expect(value.database.authQuery((db) => db.prepare("SELECT outcome, session_ref, subject_commit FROM forge_delivery_reviews WHERE id = ?").get(review.reviewId))).toEqual({ outcome: "blocking", session_ref: "session_lead", subject_commit: subjectCommit });

    const repairRunner: LeadProcessRunner = async (invocation) => {
      await invocation.onStart(4702, "2026-08-11T00:01:00.000Z");
      await writeFile(join(invocation.cwd, "DELIVERED.md"), "forge developer proof\n");
      await execFileAsync("git", ["add", "DELIVERED.md"], { cwd: invocation.cwd });
      await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "Repair exact fixture"], { cwd: invocation.cwd });
      const resultCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: invocation.cwd })).stdout.trim();
      const resultTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: invocation.cwd })).stdout.trim();
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" }));
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "repair", summary: "Proof marker repaired.", addressedFindingIds: ["finding_blocking"], commandsRun: ["git add DELIVERED.md", "git commit"], testResults: ["Marker inspected"], resultCommit, resultTree, dirtyState: "clean", blocker: null }) } }));
      return { exitCode: 0, stderr: "" };
    };
    const developer = new DeveloperService(value.database, value.config, { processRunner: repairRunner, sessionStore });
    const repaired = await developer.runRepair({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", developerSessionRef: "session_developer", developerExecutionId: "developer_review_subject", reviewId: review.reviewId, cycle: 1, repairCycleLimit: 2, worktreePath, branchName: "forge/issue/task_1", targetBaseSha, subjectCommit, subjectTree, blockingFindings: review.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open"), repairPlan: review.repairPlan! });
    expect(repaired).toMatchObject({ outcome: "completed", developerSessionRef: "session_developer", supersedesExecutionId: "developer_review_subject", cycle: 1 });
    expect(repaired.resultCommit).not.toBe(subjectCommit);
    expect(value.database.authQuery((db) => db.prepare("SELECT cycle, status, result_commit FROM forge_delivery_repairs WHERE review_id = ?").get(review.reviewId))).toMatchObject({ cycle: 1, status: "completed", result_commit: repaired.resultCommit });
    expect((await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: worktreePath })).stdout.trim()).toBe(subjectCommit);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Developer resolves a guarded merge conflict in the existing session and produces a normal two-parent merge commit", async () => {
  const value = await fixture();
  const worktreePath = join(value.root, "worktrees", "task-1");
  await execFileAsync("git", ["checkout", "-B", "main"], { cwd: join(value.root, "repo") });
  await execFileAsync("git", ["worktree", "add", "-b", "forge/issue/task_1", worktreePath, "main"], { cwd: join(value.root, "repo") });
  await writeFile(join(worktreePath, "README.md"), "issue side\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: worktreePath });
  await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "issue change"], { cwd: worktreePath });
  const priorHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
  await execFileAsync("git", ["checkout", "main"], { cwd: join(value.root, "repo") });
  await writeFile(join(value.root, "repo", "README.md"), "base side\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: join(value.root, "repo") });
  await execFileAsync("git", ["-c", "user.name=Forge Base", "-c", "user.email=base@example.invalid", "commit", "-m", "base change"], { cwd: join(value.root, "repo") });
  const targetBaseSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: join(value.root, "repo") })).stdout.trim();
  await execFileAsync("git", ["checkout", "forge/issue/task_1"], { cwd: worktreePath });
  await expect(execFileAsync("git", ["merge", "--no-ff", "--no-edit", targetBaseSha], { cwd: worktreePath })).rejects.toBeTruthy();
  const plan = await new ArtifactStore(value.config.artifactRoot).put("company_1", "merge-conflict-plan", { filename: "merge-plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "merge_conflict_plan", summary: "Resolve README", resolutions: [{ file: "README.md", resolution: "Keep the issue behavior and include the base change." }], verificationStrategy: "Run the complete local suite.", unresolvedQuestions: [] })) });
  const priorTree = (await execFileAsync("git", ["rev-parse", `${priorHead}^{tree}`], { cwd: worktreePath })).stdout.trim();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const priorDeliveryArtifact = await artifactStore.put("company_1", "developer-delivery", { filename: "prior-delivery.json", mimeType: "application/json", bytes: Buffer.from("{}") });
  const priorEvidenceArtifact = await artifactStore.put("company_1", "agent-evidence", { filename: "prior-evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") });
  const conflictArtifact = await artifactStore.put("company_1", "forward-merge-conflict", { filename: "conflict.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, checkpoint: "pre_release", expectedBaseSha: targetBaseSha, observedBaseSha: targetBaseSha, priorHead, priorTree, conflictFiles: ["README.md"], combinedDiff: "", priorCommitSummary: "", baseCommitSummary: "", commandEvidence: { command: "git diff --cc --no-ext-diff", complete: true } })) });
  const now = new Date().toISOString();
  value.database.authTransaction((db) => {
    for (const artifact of [plan, priorDeliveryArtifact, priorEvidenceArtifact, conflictArtifact]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, "company_1", artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, conflict_artifact_id, conflict_artifact_sha256, conflict_file_count, updated_at) VALUES ('merge-developer-1', 'task_1', 'company_1', ?, ?, ?, NULL, NULL, 'conflict', '[\"README.md\"]', ?, 'workflow-test-issue-task_1', 'revision_1', 'pre_release', ?, ?, ?, 1, ?)").run(targetBaseSha, targetBaseSha, priorHead, now, priorTree, conflictArtifact.id, conflictArtifact.sha256, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_conflict_subject', 'task_1', 'company_1', 'workflow-test-issue-task_1', 1, 1, 'completed', 'forge/issue/task_1', ?, ?, 'session_developer', ?, ?, ?, ?, 'clean', ?, ?)").run(worktreePath, targetBaseSha, now, now, priorHead, priorTree, priorDeliveryArtifact.id, priorEvidenceArtifact.id);
    db.prepare("INSERT INTO forge_merge_conflict_resolutions (id, task_id, company_id, workflow_id, forward_merge_id, prior_head, target_base_sha, conflict_files_json, plan_artifact_id, status, created_at, updated_at) VALUES ('merge-plan-1', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'merge-developer-1', ?, ?, '[\"README.md\"]', ?, 'planned', ?, ?)").run(priorHead, targetBaseSha, plan.id, now, now);
  });
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4802, "2026-08-11T00:00:00.000Z");
    await writeFile(join(invocation.cwd, "README.md"), "issue and base resolved\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: invocation.cwd });
    await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "Resolve target-base conflict"], { cwd: invocation.cwd });
    const resultCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: invocation.cwd })).stdout.trim();
    const resultTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: invocation.cwd })).stdout.trim();
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" }));
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "merge_conflict_resolution", summary: "README conflict resolved.", resolvedFiles: ["README.md"], commandsRun: ["git add README.md", "git commit"], testResults: ["Complete local suite passed"], resultCommit, resultTree, dirtyState: "clean", blocker: null }) } }));
    return { exitCode: 0, stderr: "" };
  };
  try {
    const developer = new DeveloperService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_developer"; }, async read() { return "raw-developer"; } } });
    const result = await developer.runMergeConflictResolution({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", planRevision: 1, forwardMergeId: "merge-developer-1", developerExecutionId: "developer_conflict_subject", developerSessionRef: "session_developer", worktreePath, branchName: "forge/issue/task_1", priorHead, targetBaseSha, conflictArtifact: { id: conflictArtifact.id, sha256: conflictArtifact.sha256, kind: "forward-merge-conflict" }, conflictFileCount: 1, planArtifactId: plan.id });
    if ("outcome" in result) throw new Error("Expected deterministic merge verification to pass");
    expect(result).toMatchObject({ developerSessionRef: "session_developer", summary: "README conflict resolved." });
    const parents = (await execFileAsync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: worktreePath })).stdout.trim().split(/\s+/);
    expect(parents).toEqual([result.resultCommit, priorHead, targetBaseSha]);
    const deliveryRow = value.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ?").get(result.deliveryArtifactId) as { storage_path: string; sha256: string });
    const delivery = JSON.parse((await artifactStore.read({ companyId: "company_1", storagePath: deliveryRow.storage_path, sha256: deliveryRow.sha256 })).toString("utf8")) as Record<string, unknown>;
    expect(delivery).toMatchObject({
      version: 1,
      checkId: "merge-developer-1",
      priorHead,
      priorTree,
      targetBaseSha,
      resultCommit: result.resultCommit,
      resultTree: result.resultTree,
      developerExecutionId: result.developerExecutionId,
      supersededDeliveryArtifactId: priorDeliveryArtifact.id,
      supersededEvidenceArtifactId: priorEvidenceArtifact.id,
      verificationArtifactId: result.verificationArtifactId,
      verification: { outcome: "passed" },
    });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, result_commit FROM forge_merge_conflict_resolutions WHERE id = 'merge-plan-1'").get())).toEqual({ status: "completed", result_commit: result.resultCommit });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test.skipIf(process.env.FORGE_RUN_REAL_CODEX !== "1")("real authenticated Lead reviews and the same Developer session repairs a controlled defect", async () => {
  const value = await fixture(process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-luna", "Create CONTROLLED_PROOF.md with the exact text `forge developer proof`. The file content is mandatory and must remain exact.");
  try {
    const lead = new AgentService(value.database, value.config);
    const plan = await lead.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1", developer: "profile_1" }, revision: 1 });
    expect(plan.leadOutputKind).toBe("plan");
    const developer = new DeveloperService(value.database, value.config);
    const delivery = await developer.run({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: plan.leadSessionRef, leadOutputArtifactId: plan.leadOutputArtifactId });
    expect(delivery.outcome).toBe("completed");
    const defectPath = join(delivery.worktreePath, "CONTROLLED_PROOF.md");
    await writeFile(defectPath, "wrong proof\n");
    await execFileAsync("git", ["add", "CONTROLLED_PROOF.md"], { cwd: delivery.worktreePath });
    await execFileAsync("git", ["-c", "user.name=Forge Test", "-c", "user.email=forge-test@example.invalid", "commit", "-m", "Introduce controlled review defect"], { cwd: delivery.worktreePath });
    const subjectCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: delivery.worktreePath })).stdout.trim();
    const subjectTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: delivery.worktreePath })).stdout.trim();
    value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET result_commit = ?, result_tree = ?, dirty_state = 'clean' WHERE id = ?").run(subjectCommit, subjectTree, delivery.developerExecutionId));
    let review: Awaited<ReturnType<AgentService["reviewDelivery"]>>;
    try {
      review = await lead.reviewDelivery({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: plan.leadSessionRef, leadOutputArtifactId: plan.leadOutputArtifactId, developerExecutionId: delivery.developerExecutionId, deliveryArtifactId: delivery.deliveryArtifactId, evidenceArtifactId: delivery.evidenceArtifactId, worktreePath: delivery.worktreePath, branchName: delivery.branchName, targetBaseSha: delivery.targetBaseSha, subjectCommit, subjectTree });
    } catch (error) {
      const evidenceRow = value.database.authQuery((db) => db.prepare("SELECT a.storage_path, a.sha256 FROM forge_agent_executions e JOIN forge_artifacts a ON a.id = e.evidence_artifact_id WHERE e.task_id = 'task_1' ORDER BY e.started_at DESC LIMIT 1").get() as { storage_path: string; sha256: string } | undefined);
      if (evidenceRow) console.log("real review evidence", (await readFile(join(value.config.artifactRoot, evidenceRow.storage_path), "utf8")).slice(-12_000));
      throw error;
    }
    expect(review.leadSessionRef).toBe(plan.leadSessionRef);
    expect(review.leadSessionRef).not.toBe(delivery.developerSessionRef);
    expect(review.outcome).toBe("blocking");
    expect(review.repairPlan).toBeTruthy();
    let repaired: Awaited<ReturnType<DeveloperService["runRepair"]>>;
    try {
      repaired = await developer.runRepair({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: plan.leadSessionRef, developerSessionRef: delivery.developerSessionRef, developerExecutionId: delivery.developerExecutionId, reviewId: review.reviewId, cycle: 1, repairCycleLimit: 2, worktreePath: delivery.worktreePath, branchName: delivery.branchName, targetBaseSha: delivery.targetBaseSha, subjectCommit, subjectTree, blockingFindings: review.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open"), repairPlan: review.repairPlan! });
    } catch (error) {
      const evidenceRow = value.database.authQuery((db) => db.prepare("SELECT a.storage_path, a.sha256 FROM forge_developer_executions e JOIN forge_artifacts a ON a.id = e.evidence_artifact_id WHERE e.task_id = 'task_1' ORDER BY e.started_at DESC LIMIT 1").get() as { storage_path: string; sha256: string } | undefined);
      if (evidenceRow) console.log("real repair evidence", (await readFile(join(value.config.artifactRoot, evidenceRow.storage_path), "utf8")).slice(-12_000));
      throw error;
    }
    expect(repaired.outcome).toBe("completed");
    expect(repaired.developerSessionRef).toBe(delivery.developerSessionRef);
    expect(repaired.resultCommit).not.toBe(subjectCommit);
    expect((await execFileAsync("git", ["show", `HEAD:CONTROLLED_PROOF.md`], { cwd: delivery.worktreePath })).stdout.trim()).toBe("forge developer proof");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
}, 600_000);

test.skipIf(process.env.FORGE_RUN_REAL_CODEX !== "1")("real authenticated Developer executes a controlled fixture plan in a fresh issue worktree", async () => {
  const value = await fixture(process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-luna");
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const plan = await artifactStore.put("company_1", "lead-plan", { filename: "approved-real.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Create one owner-controlled proof marker", reproduction: null, rootCauseAnalysis: "The fixture intentionally lacks a marker.", steps: [{ number: 1, instruction: "Create REAL_DEVELOPER_PROOF.md containing exactly the text forge developer proof, then commit the file locally.", verification: "REAL_DEVELOPER_PROOF.md exists with the exact text and the worktree is clean." }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No provider or deployment operation is authorized.", verificationStrategy: "Read the file, inspect git status, and report the exact commit and tree.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
  const leadEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "lead-real.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"lead\",\"session\":\"real-lead\"}\n") });
  value.database.authTransaction((db) => {
    const now = new Date().toISOString();
    for (const artifact of [plan, leadEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_real_lead', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_real_lead', ?, ?, ?)").run(now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_real_lead', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'agent_real_lead', 1, 'plan', ?, ?, 'session_real_lead', 'Create one owner-controlled proof marker', ?)").run(plan.id, leadEvidence.id, now);
  });
  try {
    const service = new DeveloperService(value.database, value.config);
    const result = await service.run({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_real_lead", leadOutputArtifactId: plan.id });
    expect(result.outcome).toBe("completed");
    expect(result.developerSessionRef).toMatch(/^session_[a-f0-9]{24}$/);
    expect(result.developerSessionRef).not.toBe("session_real_lead");
    expect(result.resultCommit).toMatch(/^[a-f0-9]{40,64}$/);
    expect(result.dirtyState).toBe("clean");
    expect(value.database.authQuery((db) => db.prepare("SELECT status, session_ref, result_commit, dirty_state FROM forge_developer_executions WHERE id = ?").get(result.developerExecutionId))).toMatchObject({ status: "completed", session_ref: result.developerSessionRef, result_commit: result.resultCommit, dirty_state: "clean" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
}, 300_000);

test.skipIf(process.env.FORGE_RUN_REAL_CODEX !== "1")("real authenticated Codex produces a Lead result in the isolated fixture repository", async () => {
  const value = await fixture(process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-luna");
  value.database.authQuery((db) => db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_2', 'Supplemental reviewer', 'codex', ?, 'medium', 'standard', 1, ?, ?)").run(process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-luna", new Date().toISOString(), new Date().toISOString()));
  const calls: string[][] = [];
  let firstTurn = true;
  const runner: LeadProcessRunner = async (invocation) => {
    calls.push(invocation.args);
    if (!firstTurn) return runCodexProcess(invocation);
    firstTurn = false;
    const lines: string[] = [];
    const result = await runCodexProcess({ ...invocation, onLine: async (line) => { lines.push(line); } });
    let changed = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(lines[index]!) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
        if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
          lines[index] = JSON.stringify({ ...event, item: { ...event.item, text: "not valid Lead JSON" } });
          changed = true;
          break;
        }
      } catch {
        // Ignore non-JSON diagnostic lines; the real runner already records them as evidence.
      }
    }
    expect(changed).toBe(true);
    for (const line of lines) await invocation.onLine(line);
    return result;
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner });
    const result = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 });
    expect(result.leadSessionRef).toMatch(/^session_[a-f0-9]{24}$/);
    expect(result.leadOutputKind).toBe("plan");
    const review = await service.runSupplementalReview({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1", reviewer: "profile_2" }, revision: 1, leadOutputArtifactId: result.leadOutputArtifactId, leadEvidenceArtifactId: result.leadEvidenceArtifactId });
    const consolidated = await service.consolidateLeadPlan({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1", reviewer: "profile_2" }, revision: 2, leadSessionRef: result.leadSessionRef, leadOutputArtifactId: result.leadOutputArtifactId, supplementalReviewArtifactId: review.reviewArtifactId });
    expect(review.sessionRef).toMatch(/^session_[a-f0-9]{24}$/);
    expect(review.sessionRef).not.toBe(result.leadSessionRef);
    expect(consolidated.leadSessionRef).toBe(result.leadSessionRef);
    expect(calls).toHaveLength(4);
    expect(calls[1]?.slice(0, 4)).toEqual(["exec", "resume", expect.any(String), "--json"]);
    expect(calls[3]?.slice(0, 4)).toEqual(["exec", "resume", expect.any(String), "--json"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
}, 300_000);

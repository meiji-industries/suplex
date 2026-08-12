import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";

import { ArtifactStore } from "../src/artifacts.js";
import { CapacityManager } from "../src/capacity.js";
import { AgentFailure, AgentService, LeadOutputSchema, resolveAgentCommand, runCodexProcess, type LeadProcessRunner, type SessionStore } from "../src/codex-lead.js";
import { DeveloperService } from "../src/codex-developer.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase, ProjectionIntegrityFailure } from "../src/database.js";
import { asNonRetryableApplicationFailure, createActivities } from "../src/temporal/activities.js";
import { DeliveryOperationBlockCodeSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeveloperRepairActivityResultSchema } from "../src/temporal/issue-contracts.js";

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

async function repairFixture() {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const worktreePath = join(value.root, "worktrees", "task-1");
  await execFileAsync("git", ["worktree", "add", "-b", "forge/issue/task_1", worktreePath, "HEAD"], { cwd: join(value.root, "repo") });
  const targetBaseSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
  await writeFile(join(worktreePath, "DELIVERED.md"), "delivery\n");
  await execFileAsync("git", ["add", "DELIVERED.md"], { cwd: worktreePath });
  await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "Deliver repair fixture"], { cwd: worktreePath });
  const subjectCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
  const subjectTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: worktreePath })).stdout.trim();
  const delivery = await artifactStore.put("company_1", "developer-delivery", { filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from("{\"kind\":\"delivery\"}\n") });
  const developerEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "developer.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"developer\"}\n") });
  const opinion = await artifactStore.put("company_1", "delivery-review", { filename: "review.json", mimeType: "application/json", bytes: Buffer.from("{\"outcome\":\"blocking\"}\n") });
  const reviewEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "review.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"review\"}\n") });
  const now = new Date().toISOString();
  value.database.authTransaction((db) => {
    for (const artifact of [delivery, developerEvidence, opinion, reviewEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_repair_fixture', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_lead', ?, ?, ?)").run(now, now, reviewEvidence.id);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, current_step, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_repair_fixture', 'task_1', 'company_1', 'workflow-test-issue-task_1', 1, 1, 'completed', 'forge/issue/task_1', ?, ?, 'session_developer', 1, ?, ?, ?, ?, 'clean', ?, ?)").run(worktreePath, targetBaseSha, now, now, subjectCommit, subjectTree, delivery.id, developerEvidence.id);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, supersedes_review_id, created_at) VALUES ('delivery_review_fixture', 'task_1', 'company_1', 'workflow-test-issue-task_1', 1, ?, ?, ?, 'agent_repair_fixture', 'session_lead', 'blocking', 'Repair fixture needs correction.', ?, ?, 0, NULL, ?)").run(targetBaseSha, subjectCommit, subjectTree, opinion.id, reviewEvidence.id, now);
  });
  const sessionStore: SessionStore = { async create() { return "session_developer"; }, async read(ref) { return ref === "session_developer" ? "raw-developer" : ""; } };
  const repairInput = { taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", developerSessionRef: "session_developer", developerExecutionId: "developer_repair_fixture", reviewId: "delivery_review_fixture", repairCycleLimit: 5, worktreePath, branchName: "forge/issue/task_1", targetBaseSha, subjectCommit, subjectTree, blockingFindings: [{ findingId: "finding_blocking", severity: "blocking" as const, rationale: "The marker is incomplete.", evidenceRef: "DELIVERED.md", disposition: "open" as const, repairInstruction: "Complete the marker." }], repairPlan: "Complete the marker." };
  return { ...value, worktreePath, subjectCommit, subjectTree, sessionStore, repairInput };
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
    expect(evidenceText.toString("utf8")).not.toContain("raw-session-1");
    expect(value.database.authQuery((db) => db.prepare("SELECT kind, revision, session_ref FROM forge_issue_outputs WHERE task_id = 'task_1'").get())).toEqual({ kind: "plan", revision: 1, session_ref: "session_opaque" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a capacity request pins model, reasoning, and service priority through later profile edits", async () => {
  const value = await fixture("pinned-model");
  const calls: string[][] = [];
  const runner: LeadProcessRunner = async (invocation) => {
    calls.push(invocation.args);
    await invocation.onStart(4330, "2026-08-12T00:00:00.000Z");
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-pinned-session" }));
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "plan", summary: "Pinned profile plan", reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "Inspect the fixture", verification: "The focused test passes" }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Run the focused test.", unresolvedTechnicalQuestions: [], materialCategories: [] }) } }));
    return { exitCode: 0, stderr: "" };
  };
  try {
    value.database.authQuery((db) => db.prepare("UPDATE forge_profiles SET reasoning_level = 'high', service_priority = 'priority' WHERE id = 'profile_1'").run());
    const capacity = new CapacityManager(value.database, value.config);
    const request = capacity.request({ logicalTurnKey: "workflow-test-issue-task_1:1:lead_planning", companyId: "company_1", taskId: "task_1", workflowId: "workflow-test-issue-task_1", projectRevisionId: "revision_1", workflowRevision: 1, operation: "lead_planning", role: "lead", profileId: "profile_1" });
    expect(capacity.tryAcquire(request.id, 1).status).toBe("active");
    value.database.authQuery((db) => db.prepare("UPDATE forge_profiles SET model = 'later-model', reasoning_level = 'low', service_priority = 'standard' WHERE id = 'profile_1'").run());

    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_pinned"; }, async read() { return "raw-pinned-session"; } } });
    const result = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1, capacityRequestId: request.id });

    expect(calls[0]).toEqual(expect.arrayContaining(["--model", "pinned-model", "-c", 'model_reasoning_effort="high"', "-c", 'service_tier="priority"']));
    expect(calls[0]).not.toContain("later-model");
    expect(value.database.authQuery((db) => db.prepare("SELECT profile_id, model, reasoning_level, service_priority, capacity_request_id FROM forge_agent_executions WHERE id = ?").get(result.leadExecutionId))).toEqual({ profile_id: "profile_1", model: "pinned-model", reasoning_level: "high", service_priority: "priority", capacity_request_id: request.id });
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
    const service = new AgentService(value.database, value.config, { processRunner: async () => { throw new Error("runner must not be called"); } });
    const invalidInput = {
      taskId: "task_1",
      companyId: "company_1",
      workflowId: "workflow-test-issue-task_1",
      projectId: "project_1",
      projectRevisionId: "revision_1",
      briefArtifactId: value.briefId,
      planRevision: 1,
      roleProfiles: { lead: "profile_1", developer: "profile_1" },
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
    const delivery = await artifactStore.put("company_1", "developer-delivery", { filename: "preflight-delivery.json", mimeType: "application/json", bytes: Buffer.from("{\"kind\":\"delivery\"}") });
    const evidence = await artifactStore.put("company_1", "agent-evidence", { filename: "preflight-evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"developer\"}\n") });
    const now = new Date().toISOString();
    value.database.authTransaction((db) => {
      for (const artifact of [delivery, evidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_preflight', 'task_1', 'company_1', 'workflow-test-issue-task_1', 1, 1, 'completed', 'forge/issue/task_1', ?, ?, 'session_developer', ?, ?, ?, ?, 'clean', ?, ?)").run(invalidInput.worktreePath, "a".repeat(40), now, now, "b".repeat(40), "c".repeat(40), delivery.id, evidence.id);
    });
    const result = await service.reviewDelivery({ ...invalidInput, subject: { ...invalidInput.subject, developerExecutionId: "developer_preflight", deliveryArtifactId: delivery.id, developerEvidenceArtifactId: evidence.id } });
    expect(result).toMatchObject({ outcome: "blocked", code: "process-failed", correctionAttempts: 0 });
    if (result.outcome !== "blocked") throw new Error("Expected a typed blocked review result");
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, completed_review_id, evidence_artifact_id, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id FROM forge_delivery_review_attempts WHERE id = ?").get(result.attemptId))).toMatchObject({ status: "blocked", failure_code: "process-failed", completed_review_id: null, evidence_artifact_id: result.evidenceArtifactId, developer_execution_id: "developer_preflight", delivery_artifact_id: delivery.id, developer_evidence_artifact_id: evidence.id });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, evidence_artifact_id FROM forge_agent_executions WHERE id = ?").get(result.executionId))).toEqual({ status: "blocked", failure_code: "process-failed", evidence_artifact_id: result.evidenceArtifactId });
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

test("a late Developer failure cannot overwrite a cancellation", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const plan = await artifactStore.put("company_1", "lead-plan", { filename: "cancel-plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Cancellation plan", reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "Wait for cancellation.", verification: "The execution remains cancelled." }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Inspect execution state.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
  const leadEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "cancel-lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"lead\"}\n") });
  value.database.authTransaction((db) => {
    const now = new Date().toISOString();
    for (const artifact of [plan, leadEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_cancel_lead', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_lead', ?, ?, ?)").run(now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_cancel_plan', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'agent_cancel_lead', 1, 'plan', ?, ?, 'session_lead', 'Cancellation plan', ?)").run(plan.id, leadEvidence.id, now);
  });
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4611, "2026-08-11T00:00:00.000Z");
    const executionId = (value.database.authQuery((db) => db.prepare("SELECT id FROM forge_developer_executions ORDER BY started_at DESC LIMIT 1").get() as { id: string })).id;
    value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'cancelled', finished_at = ?, failure_code = NULL, failure_summary = NULL WHERE id = ?").run(new Date().toISOString(), executionId));
    return { exitCode: 143, stderr: "terminated" };
  };
  try {
    const service = new DeveloperService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_developer"; }, async read() { return "raw-developer"; } } });
    await expect(service.run({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", leadOutputArtifactId: plan.id })).rejects.toBeInstanceOf(AgentFailure);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, evidence_artifact_id FROM forge_developer_executions ORDER BY started_at DESC LIMIT 1").get())).toMatchObject({ status: "cancelled", failure_code: null, evidence_artifact_id: expect.any(String) });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a late Developer success cannot overwrite a cancellation", async () => {
  const value = await fixture();
  const artifactStore = new ArtifactStore(value.config.artifactRoot);
  const plan = await artifactStore.put("company_1", "lead-plan", { filename: "cancel-success-plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Cancellation success race", reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "Create the marker.", verification: "The marker exists." }], compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "No operational change.", verificationStrategy: "Inspect the marker.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
  const leadEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "cancel-success-lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"lead\"}\n") });
  value.database.authTransaction((db) => {
    const now = new Date().toISOString();
    for (const artifact of [plan, leadEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_cancel_success_lead', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'lead', 'completed', 1, 'session_lead', ?, ?, ?)").run(now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_cancel_success_plan', 'task_1', 'company_1', 'workflow-test-issue-task_1', 'agent_cancel_success_lead', 1, 'plan', ?, ?, 'session_lead', 'Cancellation success race', ?)").run(plan.id, leadEvidence.id, now);
  });
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4612, "2026-08-11T00:00:00.000Z");
    await writeFile(join(invocation.cwd, "CANCELLED_MARKER.md"), "cancelled delivery\n");
    await execFileAsync("git", ["add", "CANCELLED_MARKER.md"], { cwd: invocation.cwd });
    await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "Create cancelled marker"], { cwd: invocation.cwd });
    const resultCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: invocation.cwd })).stdout.trim();
    const resultTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: invocation.cwd })).stdout.trim();
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-cancelled-developer" }));
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "delivery", summary: "Late delivery", steps: [{ number: 1, status: "completed", filesChanged: ["CANCELLED_MARKER.md"], commandsRun: ["git commit"], testResults: ["Marker inspected"], notes: "Late success." }], authorizedStepsNotCompleted: [], resultCommit, resultTree, dirtyState: "clean", blocker: null }) } }));
    const executionId = (value.database.authQuery((db) => db.prepare("SELECT id FROM forge_developer_executions ORDER BY started_at DESC LIMIT 1").get() as { id: string })).id;
    value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'cancelled', finished_at = ? WHERE id = ?").run(new Date().toISOString(), executionId));
    return { exitCode: 0, stderr: "" };
  };
  try {
    const service = new DeveloperService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_developer"; }, async read() { return "raw-developer"; } } });
    await expect(service.run({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", leadOutputArtifactId: plan.id })).rejects.toMatchObject({ code: "developer-cancelled" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions ORDER BY started_at DESC LIMIT 1").get())).toEqual({ status: "cancelled" });
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
  let reviewCalls = 0;
  const reviewRunner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4701, "2026-08-11T00:00:00.000Z");
    if (reviewCalls === 0) reviewPrompt = invocation.args.at(-1) ?? "";
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-lead" }));
    reviewCalls += 1;
    const reviewOutput = reviewCalls === 1
      ? "not machine-readable"
      : JSON.stringify({ kind: "delivery_review", summary: "One required repair remains.", outcome: "blocking", findings: [{ findingId: "finding_blocking", severity: "blocking", rationale: "The proof marker is incomplete.", evidenceRef: "DELIVERED.md", disposition: "open", repairInstruction: "Complete the proof marker." }, { findingId: "finding_advisory", severity: "advisory", rationale: "The report could be more detailed.", evidenceRef: "delivery report", disposition: "open", repairInstruction: null }], repairPlan: "Complete DELIVERED.md with the required proof text." });
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: reviewOutput } }));
    return { exitCode: 0, stderr: "" };
  };
  try {
    const lead = new AgentService(value.database, value.config, { processRunner: reviewRunner, sessionStore });
    const reviewInput = { taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadOutputArtifactId: plan.id, subject: { planRevision: 1, targetBaseSha, subjectCommit, subjectTree, developerExecutionId: "developer_review_subject", deliveryArtifactId: delivery.id, developerEvidenceArtifactId: developerEvidence.id, leadSessionRef: "session_lead", developerSessionRef: "session_developer" }, worktreePath, branchName: "forge/issue/task_1", supersedesReviewId: null };
    const review = await lead.reviewDelivery(reviewInput);
    expect(review).toMatchObject({ outcome: "completed", subject: { subjectCommit, subjectTree }, review: { opinion: "blocking", leadSessionRef: "session_lead" } });
    if (review.outcome !== "completed") throw new Error("Fixture review did not complete");
    const completedReview = review;
    expect(review.correctionAttempts).toBe(1);
    expect(reviewCalls).toBe(2);
    expect(reviewPrompt).toContain(targetBaseSha);
    expect(reviewPrompt).toContain(subjectCommit);
    expect(reviewPrompt).toContain(subjectTree);
    expect(value.database.authQuery((db) => db.prepare("SELECT outcome, session_ref, subject_commit FROM forge_delivery_reviews WHERE id = ?").get(completedReview.review.reviewId))).toEqual({ outcome: "blocking", session_ref: "session_lead", subject_commit: subjectCommit });
    const reviewEvidenceRow = value.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a JOIN forge_delivery_review_attempts attempt ON attempt.evidence_artifact_id = a.id WHERE attempt.completed_review_id = ?").get(completedReview.review.reviewId) as { storagePath: string; sha256: string });
    const reviewEvidenceText = (await new ArtifactStore(value.config.artifactRoot).read({ companyId: "company_1", storagePath: reviewEvidenceRow.storagePath, sha256: reviewEvidenceRow.sha256 })).toString("utf8");
    expect(reviewEvidenceText).toContain("forge.review-turn-start");
    expect(reviewEvidenceText).toContain('"turn":1');
    expect(reviewEvidenceText).toContain('"turn":2');
    expect(reviewEvidenceText).not.toContain("raw-lead");
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_delivery_review_attempts WHERE completed_review_id = ?").get(completedReview.review.reviewId))).toEqual({ count: 1 });

    let correctionFailureCalls = 0;
    const correctionFailure = await new AgentService(value.database, value.config, { processRunner: async (invocation) => {
      await invocation.onStart(4710 + correctionFailureCalls, "2026-08-11T00:00:30.000Z");
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-lead" }));
      correctionFailureCalls += 1;
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "not machine-readable" } }));
      return { exitCode: 0, stderr: "" };
    }, sessionStore }).reviewDelivery(reviewInput);
    expect(correctionFailure).toMatchObject({ outcome: "blocked", code: "correction-exhausted", correctionAttempts: 1 });
    expect(correctionFailureCalls).toBe(2);

    const blockedReviewCases: Array<[string, LeadProcessRunner]> = [
      ["session-conflict", async (invocation) => { await invocation.onStart(4720, "2026-08-11T00:00:40.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "different-lead" })); return { exitCode: 0, stderr: "" }; }],
      ["authentication-required", async (invocation) => { await invocation.onStart(4719, "2026-08-11T00:00:35.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-lead" })); return { exitCode: 1, stderr: "OAuth authorization required" }; }],
      ["rate-limited", async (invocation) => { await invocation.onStart(4721, "2026-08-11T00:00:50.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-lead" })); return { exitCode: 1, stderr: "HTTP 429: rate limit exceeded" }; }],
      ["process-failed", async (invocation) => { await invocation.onStart(4722, "2026-08-11T00:01:00.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-lead" })); return { exitCode: 1, stderr: "worker crashed" }; }],
      ["evidence-too-large", async (invocation) => { await invocation.onStart(4723, "2026-08-11T00:01:10.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-lead" })); await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x".repeat(7 * 1024 * 1024) } })); return { exitCode: 0, stderr: "" }; }],
    ];
    for (const [code, runner] of blockedReviewCases) {
      const blocked = await new AgentService(value.database, value.config, { processRunner: runner, sessionStore }).reviewDelivery(reviewInput);
      expect(blocked).toMatchObject({ outcome: "blocked", code, subject: { subjectCommit, subjectTree } });
      if (blocked.outcome !== "blocked") throw new Error("Expected a blocked review fixture");
      expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, finished_at FROM forge_delivery_review_attempts WHERE id = ?").get(blocked.attemptId))).toMatchObject({ status: "blocked", failure_code: code, finished_at: expect.any(String) });
    }
    const oversizedRepairRunner: LeadProcessRunner = async (invocation) => {
      await invocation.onStart(4702, "2026-08-11T00:01:00.000Z");
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" }));
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x".repeat(7 * 1024 * 1024) } }));
      return { exitCode: 0, stderr: "" };
    };
    const oversizedDeveloper = new DeveloperService(value.database, value.config, { processRunner: oversizedRepairRunner, sessionStore });
    const repairInput = { taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", developerSessionRef: "session_developer", developerExecutionId: "developer_review_subject", reviewId: completedReview.review.reviewId, repairCycleLimit: 5, worktreePath, branchName: "forge/issue/task_1", targetBaseSha, subjectCommit, subjectTree, blockingFindings: completedReview.review.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open"), repairPlan: completedReview.review.repairPlan! };
    const oversized = await oversizedDeveloper.runRepair({ ...repairInput, cycle: 1 });
    expect(oversized).toMatchObject({ outcome: "blocked", code: "evidence-too-large", cycle: 1, subject: { developerExecutionId: "developer_review_subject", subjectCommit, subjectTree } });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, evidence_artifact_id, finished_at FROM forge_delivery_repairs WHERE id = ?").get(oversized.repairAttemptId))).toMatchObject({ status: "blocked", failure_code: "evidence-too-large", evidence_artifact_id: oversized.evidenceArtifactId, finished_at: expect.any(String) });

    const blockedRepairCases: Array<[number, string, LeadProcessRunner]> = [
      [2, "invalid-output", async (invocation) => { await invocation.onStart(4730, "2026-08-11T00:01:20.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" })); await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "not repair JSON" } })); return { exitCode: 0, stderr: "" }; }],
      [3, "session-conflict", async (invocation) => { await invocation.onStart(4731, "2026-08-11T00:01:30.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "different-developer" })); return { exitCode: 0, stderr: "" }; }],
      [4, "rate-limited", async (invocation) => { await invocation.onStart(4732, "2026-08-11T00:01:40.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" })); return { exitCode: 1, stderr: "HTTP 429: rate limit exceeded" }; }],
    ];
    for (const [cycle, code, runner] of blockedRepairCases) {
      const blocked = await new DeveloperService(value.database, value.config, { processRunner: runner, sessionStore }).runRepair({ ...repairInput, cycle });
      expect(blocked).toMatchObject({ outcome: "blocked", code, cycle, subject: { developerExecutionId: "developer_review_subject", subjectCommit, subjectTree } });
      expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, finished_at FROM forge_delivery_repairs WHERE id = ?").get(blocked.repairAttemptId))).toMatchObject({ status: "blocked", failure_code: code, finished_at: expect.any(String) });
    }

    const repairRunner: LeadProcessRunner = async (invocation) => {
      await invocation.onStart(4703, "2026-08-11T00:02:00.000Z");
      await writeFile(join(invocation.cwd, "DELIVERED.md"), "forge developer proof\n");
      await execFileAsync("git", ["add", "DELIVERED.md"], { cwd: invocation.cwd });
      await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", "Repair exact fixture"], { cwd: invocation.cwd });
      const resultCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: invocation.cwd })).stdout.trim();
      const resultTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: invocation.cwd })).stdout.trim();
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" }));
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "repair", summary: "Proof marker repaired.", addressedFindingIds: ["finding_blocking"], commandsRun: ["git add DELIVERED.md", "git commit"], testResults: ["Marker inspected"], resultCommit, resultTree, dirtyState: "clean", blocker: null }) } }));
      return { exitCode: 0, stderr: "" };
    };
    const filenameOnlyPlan = await artifactStore.put("company_1", "delivery-repair-plan", { filename: "final_review_blocking-1.md", mimeType: "text/markdown", bytes: Buffer.from("This filename is not durable repair authority.") });
    value.database.authTransaction((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(filenameOnlyPlan.id, filenameOnlyPlan.companyId, filenameOnlyPlan.kind, filenameOnlyPlan.filename, filenameOnlyPlan.mimeType, filenameOnlyPlan.byteSize, filenameOnlyPlan.sha256, filenameOnlyPlan.storagePath, filenameOnlyPlan.createdAt));
    const guardedDeveloper = new DeveloperService(value.database, value.config, { processRunner: async () => { throw new Error("A filename-only repair plan reached execution"); }, sessionStore });
    await expect(guardedDeveloper.runRepair({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: "session_lead", developerSessionRef: "session_developer", developerExecutionId: "developer_review_subject", reviewId: completedReview.review.reviewId, repairAuthority: "final_review", cycle: 1, repairCycleLimit: 2, worktreePath, branchName: "forge/issue/task_1", targetBaseSha, subjectCommit, subjectTree, blockingFindings: completedReview.review.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open"), repairPlanArtifactId: filenameOnlyPlan.id, repairPlanSha256: filenameOnlyPlan.sha256 })).rejects.toMatchObject({ code: "repair-authority-mismatch" });
    const developer = new DeveloperService(value.database, value.config, { processRunner: repairRunner, sessionStore });
    const repaired = await developer.runRepair({ ...repairInput, cycle: 5 });
    expect(repaired).toMatchObject({ outcome: "completed", developerSessionRef: "session_developer", repairAttemptId: expect.any(String), reviewId: completedReview.review.reviewId, cycle: 5, subject: { subjectCommit, subjectTree } });
    expect(repaired.resultCommit).not.toBe(subjectCommit);
    expect(value.database.authQuery((db) => db.prepare("SELECT cycle, status, result_commit FROM forge_delivery_repairs WHERE id = ?").get(repaired.repairAttemptId))).toMatchObject({ cycle: 5, status: "completed", result_commit: repaired.resultCommit });
    expect((await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: worktreePath })).stdout.trim()).toBe(subjectCommit);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Developer repair expected failures are typed, durable, and consume bounded cycles", async () => {
  const value = await repairFixture();
  const reportRunner = (pid: number, report: Record<string, unknown>): LeadProcessRunner => async (invocation) => {
    await invocation.onStart(pid, "2026-08-11T00:03:00.000Z");
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" }));
    await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(report) } }));
    return { exitCode: 0, stderr: "" };
  };
  const baseReport = { kind: "repair", summary: "Repair fixture result.", addressedFindingIds: ["finding_blocking"], commandsRun: [], testResults: [], resultCommit: value.subjectCommit, resultTree: value.subjectTree, dirtyState: "clean", blocker: null };
  const cases: Array<[number, string, LeadProcessRunner]> = [
    [1, "authentication-required", async (invocation) => { await invocation.onStart(4741, "2026-08-11T00:03:01.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" })); return { exitCode: 1, stderr: "OAuth authorization required" }; }],
    [2, "process-failed", async (invocation) => { await invocation.onStart(4742, "2026-08-11T00:03:02.000Z"); await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" })); return { exitCode: 1, stderr: "worker crashed" }; }],
    [3, "repair-incomplete", reportRunner(4743, { ...baseReport, addressedFindingIds: [] })],
    [4, "repair-scope", reportRunner(4744, { ...baseReport, addressedFindingIds: [], blocker: "A required dependency is unavailable." })],
  ];
  try {
    for (const [cycle, code, runner] of cases) {
      const blocked = await new DeveloperService(value.database, value.config, { processRunner: runner, sessionStore: value.sessionStore }).runRepair({ ...value.repairInput, cycle });
      expect(blocked).toMatchObject({ outcome: "blocked", code, cycle, subject: { subjectCommit: value.subjectCommit, subjectTree: value.subjectTree } });
      expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, evidence_artifact_id, finished_at FROM forge_delivery_repairs WHERE id = ?").get(blocked.repairAttemptId))).toMatchObject({ status: "blocked", failure_code: code, evidence_artifact_id: blocked.evidenceArtifactId, finished_at: expect.any(String) });
    }
    let capRunnerCalled = false;
    const capExhausted = await new DeveloperService(value.database, value.config, { processRunner: async () => { capRunnerCalled = true; return { exitCode: 0, stderr: "" }; }, sessionStore: value.sessionStore }).runRepair({ ...value.repairInput, cycle: 5, repairCycleLimit: 4 });
    expect(capExhausted).toMatchObject({ outcome: "blocked", code: "repair-cap-exhausted", cycle: 5 });
    expect(capRunnerCalled).toBe(false);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Developer repair rejects dirty and non-child revisions with durable observed coordinates", async () => {
  const value = await repairFixture();
  try {
    const dirty = await new DeveloperService(value.database, value.config, { processRunner: async (invocation) => {
      await invocation.onStart(4751, "2026-08-11T00:04:01.000Z");
      await writeFile(join(invocation.cwd, "DELIVERED.md"), "dirty repair\n");
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" }));
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "repair", summary: "Repair left the worktree dirty.", addressedFindingIds: ["finding_blocking"], commandsRun: [], testResults: [], resultCommit: value.subjectCommit, resultTree: value.subjectTree, dirtyState: "dirty", blocker: null }) } }));
      return { exitCode: 0, stderr: "" };
    }, sessionStore: value.sessionStore }).runRepair({ ...value.repairInput, cycle: 1 });
    expect(dirty).toMatchObject({ outcome: "blocked", code: "worktree-unsafe", resultCommit: value.subjectCommit, resultTree: value.subjectTree, dirtyState: "dirty" });
    await writeFile(join(value.worktreePath, "DELIVERED.md"), "delivery\n");
    expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: value.worktreePath })).stdout).toBe("");

    const nonChild = await new DeveloperService(value.database, value.config, { processRunner: async (invocation) => {
      await invocation.onStart(4752, "2026-08-11T00:04:02.000Z");
      for (const marker of ["first", "second"]) {
        await writeFile(join(invocation.cwd, "DELIVERED.md"), `${marker} repair commit\n`);
        await execFileAsync("git", ["add", "DELIVERED.md"], { cwd: invocation.cwd });
        await execFileAsync("git", ["-c", "user.name=Forge Developer", "-c", "user.email=developer@example.invalid", "commit", "-m", `${marker} repair commit`], { cwd: invocation.cwd });
      }
      const resultCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: invocation.cwd })).stdout.trim();
      const resultTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: invocation.cwd })).stdout.trim();
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-developer" }));
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "repair", summary: "Repair created two commits.", addressedFindingIds: ["finding_blocking"], commandsRun: [], testResults: [], resultCommit, resultTree, dirtyState: "clean", blocker: null }) } }));
      return { exitCode: 0, stderr: "" };
    }, sessionStore: value.sessionStore }).runRepair({ ...value.repairInput, cycle: 2 });
    expect(nonChild).toMatchObject({ outcome: "blocked", code: "worktree-unsafe", resultCommit: expect.not.stringMatching(new RegExp(`^${value.subjectCommit}$`, "i")), dirtyState: "clean" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code, result_commit, result_tree, finished_at FROM forge_delivery_repairs WHERE id = ?").get(nonChild.repairAttemptId))).toMatchObject({ status: "blocked", failure_code: "worktree-unsafe", result_commit: nonChild.resultCommit, result_tree: nonChild.resultTree, finished_at: expect.any(String) });
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

test.skipIf(process.env.FORGE_RUN_REAL_CODEX !== "1")("real authenticated Lead reviews, repairs, and fresh-reviews a controlled defect", async () => {
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
    const artifactStore = new ArtifactStore(value.config.artifactRoot);
    const controlledDelivery = await artifactStore.put("company_1", "developer-delivery", { filename: "controlled-defect-delivery.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "delivery", summary: "Controlled exact-subject defect for authenticated review proof.", resultCommit: subjectCommit, resultTree: subjectTree, dirtyState: "clean" })) });
    const controlledEvidence = await artifactStore.put("company_1", "agent-evidence", { filename: "controlled-defect-evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from(`${JSON.stringify({ type: "forge.controlled-proof-defect", subjectCommit, subjectTree })}\n`) });
    value.database.authTransaction((db) => {
      for (const artifact of [controlledDelivery, controlledEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("UPDATE forge_developer_executions SET result_commit = ?, result_tree = ?, dirty_state = 'clean', delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?").run(subjectCommit, subjectTree, controlledDelivery.id, controlledEvidence.id, delivery.developerExecutionId);
    });
    const review = await lead.reviewDelivery({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadOutputArtifactId: plan.leadOutputArtifactId, subject: { planRevision: 1, targetBaseSha: delivery.targetBaseSha, subjectCommit, subjectTree, developerExecutionId: delivery.developerExecutionId, deliveryArtifactId: controlledDelivery.id, developerEvidenceArtifactId: controlledEvidence.id, leadSessionRef: plan.leadSessionRef, developerSessionRef: delivery.developerSessionRef }, worktreePath: delivery.worktreePath, branchName: delivery.branchName, supersedesReviewId: null });
    if (review.outcome !== "completed") throw new Error("Real review did not return a completed result");
    expect(review.review.leadSessionRef).toBe(plan.leadSessionRef);
    expect(review.review.leadSessionRef).not.toBe(delivery.developerSessionRef);
    expect(review.review.opinion).toBe("blocking");
    expect(review.review.repairPlan).toBeTruthy();
    const originalReviewRow = value.database.authQuery((db) => db.prepare("SELECT id, subject_commit, subject_tree, opinion_artifact_id, evidence_artifact_id FROM forge_delivery_reviews WHERE id = ?").get(review.review.reviewId) as { id: string; subject_commit: string; subject_tree: string; opinion_artifact_id: string; evidence_artifact_id: string } | undefined);
    const originalFindingRows = value.database.authQuery((db) => db.prepare("SELECT id, rationale, disposition, repair_instruction FROM forge_delivery_findings WHERE review_id = ? ORDER BY id").all(review.review.reviewId) as Array<{ id: string; rationale: string; disposition: string; repair_instruction: string | null }>);
    const readArtifact = async (artifactId: string): Promise<Buffer> => {
      const artifact = value.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = 'company_1'").get(artifactId) as { storage_path: string; sha256: string });
      return artifactStore.read({ companyId: "company_1", storagePath: artifact.storage_path, sha256: artifact.sha256 });
    };
    const originalOpinionBytes = await readArtifact(review.review.opinionArtifactId);
    const originalEvidenceBytes = await readArtifact(review.review.evidenceArtifactId);
    const repaired = await developer.runRepair({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadSessionRef: plan.leadSessionRef, developerSessionRef: delivery.developerSessionRef, developerExecutionId: delivery.developerExecutionId, reviewId: review.review.reviewId, cycle: 1, repairCycleLimit: 2, worktreePath: delivery.worktreePath, branchName: delivery.branchName, targetBaseSha: delivery.targetBaseSha, subjectCommit, subjectTree, blockingFindings: review.review.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open"), repairPlan: review.review.repairPlan! });
    expect(repaired.outcome).toBe("completed");
    expect(repaired.developerSessionRef).toBe(delivery.developerSessionRef);
    expect(repaired.resultCommit).not.toBe(subjectCommit);
    expect((await execFileAsync("git", ["show", `HEAD:CONTROLLED_PROOF.md`], { cwd: delivery.worktreePath })).stdout.trim()).toBe("forge developer proof");
    if (repaired.outcome !== "completed") throw new Error("Real repair did not complete");
    const fresh = await lead.reviewDelivery({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, planRevision: 1, roleProfiles: { lead: "profile_1", developer: "profile_1" }, leadOutputArtifactId: plan.leadOutputArtifactId, supersedesReviewId: review.review.reviewId, subject: { planRevision: 1, targetBaseSha: delivery.targetBaseSha, subjectCommit: repaired.resultCommit!, subjectTree: repaired.resultTree!, developerExecutionId: repaired.developerExecutionId, deliveryArtifactId: repaired.deliveryArtifactId, developerEvidenceArtifactId: repaired.evidenceArtifactId, leadSessionRef: plan.leadSessionRef, developerSessionRef: repaired.developerSessionRef }, worktreePath: delivery.worktreePath, branchName: delivery.branchName });
    if (fresh.outcome !== "completed") throw new Error("Fresh real review did not return a completed result");
    expect(fresh.review.opinion).toBe("approved");
    expect(fresh.review.supersedesReviewId).toBe(review.review.reviewId);
    expect(fresh.subject.subjectCommit).toBe(repaired.resultCommit);
    expect(fresh.subject.subjectTree).toBe(repaired.resultTree);
    expect(fresh.review.leadSessionRef).toBe(review.review.leadSessionRef);
    expect(value.database.authQuery((db) => db.prepare("SELECT id, subject_commit, subject_tree, opinion_artifact_id, evidence_artifact_id FROM forge_delivery_reviews WHERE id = ?").get(review.review.reviewId))).toEqual(originalReviewRow);
    expect(value.database.authQuery((db) => db.prepare("SELECT id, rationale, disposition, repair_instruction FROM forge_delivery_findings WHERE review_id = ? ORDER BY id").all(review.review.reviewId))).toEqual(originalFindingRows);
    expect(await readArtifact(review.review.opinionArtifactId)).toEqual(originalOpinionBytes);
    expect(await readArtifact(review.review.evidenceArtifactId)).toEqual(originalEvidenceBytes);
    expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: delivery.worktreePath })).stdout).toBe("");
    expect((await execFileAsync("git", ["remote"], { cwd: delivery.worktreePath })).stdout).toBe("");
    expect((await execFileAsync("git", ["for-each-ref", "--format=%(refname)", "refs/remotes"], { cwd: delivery.worktreePath })).stdout).toBe("");
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
    for (const call of [calls[1], calls[3]]) {
      expect(call?.slice(0, 2)).toEqual(["exec", "resume"]);
      expect(call).toEqual(expect.arrayContaining(["--model", process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-luna", "-c", 'model_reasoning_effort="medium"', "-c", 'service_tier="default"', "--json"]));
    }
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
}, 300_000);

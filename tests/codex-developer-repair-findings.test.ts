import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { DeveloperService } from "../src/codex-developer.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { HerdrTurnInput } from "../src/herdr-turn-runner.js";
import { createActivities } from "../src/temporal/activities.js";

const workflowId = "workflow-repair-findings";
const branchName = "forge/issue/repair-findings";

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test("supervised Developer repair forwards every scheduled blocking finding to its prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-repair-findings-"));
  const repositoryPath = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const worktreePath = join(worktreeRoot, "repair-findings");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await git(["init"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["add", "README.md"], repositoryPath);
  await git(["commit", "-m", "fixture"], repositoryPath);
  await git(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], repositoryPath);

  const config = createTestConfig(root, { repositoryRoot: root, worktreeRoot, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactRoot);
  const targetBaseSha = await git(["rev-parse", "HEAD"], worktreePath);
  const subjectTree = await git(["rev-parse", "HEAD^{tree}"], worktreePath);
  const findings = ["finding_migration", "finding_backfill", "finding_verification"].map((findingId) => ({
    findingId,
    severity: "blocking" as const,
    rationale: `Repair ${findingId}`,
    evidenceRef: "delivery review",
    disposition: "open" as const,
    repairInstruction: `Address ${findingId}`,
  }));
  const [brief, leadEvidence, delivery, developerEvidence, opinion] = await Promise.all([
    artifacts.put("company_1", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from("Repair fixture") }),
    artifacts.put("company_1", "agent-evidence", { filename: "lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") }),
    artifacts.put("company_1", "developer-delivery", { filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from("{}") }),
    artifacts.put("company_1", "agent-evidence", { filename: "developer.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") }),
    artifacts.put("company_1", "delivery-review", { filename: "review.json", mimeType: "application/json", bytes: Buffer.from("{}") }),
  ]);
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company One', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project One', ?, ?, 'acme/forge', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(repositoryPath, worktreeRoot, now, now);
    for (const artifact of [brief, leadEvidence, delivery, developerEvidence, opinion]) db.prepare("INSERT INTO forge_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, 'task_1', ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Repair fixture', ?, '[]', '{}', 0, ?, 'revision_1', 'repair-findings', ?, ?)").run(brief.id, workflowId, now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('lead_review', 'task_1', 'company_1', ?, 'reviewer', 'completed', 1, 'session_lead', ?, ?, ?)").run(workflowId, now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_prior', 'task_1', 'company_1', ?, 1, 1, 'completed', ?, ?, ?, 'session_developer', ?, ?, ?, ?, 'clean', ?, ?)").run(workflowId, branchName, worktreePath, targetBaseSha, now, now, targetBaseSha, subjectTree, delivery.id, developerEvidence.id);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, provider_kind, status, created_at, updated_at) VALUES ('session_developer', 'task_1', 'developer', 0, 'codex', 'ready', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('review_1', 'task_1', 'company_1', ?, 1, ?, ?, ?, 'lead_review', 'session_lead', 'blocking', 'Repair required', ?, ?, 0, ?)").run(workflowId, targetBaseSha, targetBaseSha, subjectTree, opinion.id, leadEvidence.id, now);
  });

  let prompt = "";
  const developer = new DeveloperService(database, config, {
    turnRunner: {
      async run<T>(input: HerdrTurnInput<T>) {
        prompt = input.prompt;
        return { turnId: "turn_repair", sessionId: "raw-developer", roleSessionId: "session_developer", result: { summary: "Findings reviewed.", blocker: null } as T, resultHash: "a".repeat(64) };
      },
    },
  });
  try {
    const activities = createActivities(database, config, { developer });
    await activities.runDeveloperRepairSupervised({
      taskId: "task_1", companyId: "company_1", workflowId, projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1,
      roleProfiles: {}, leadSessionRef: "session_lead", developerSessionRef: "session_developer", developerExecutionId: "developer_prior", reviewId: "review_1",
      cycle: 1, repairCycleLimit: 5, worktreePath, branchName, targetBaseSha, subjectCommit: targetBaseSha, subjectTree, blockingFindings: findings,
      repairPlan: null, developerTurnExecutionId: `developer_${"a".repeat(24)}`, developerAttempt: 2, turnKind: "repair",
    });
    for (const finding of findings) expect(prompt).toContain(finding.findingId);
    expect(prompt).toContain("Run appropriate local verification, including the configured project suite when it applies.");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Developer repair forbids every test suite when project tests are disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-repair-no-tests-"));
  const repositoryPath = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const worktreePath = join(worktreeRoot, "repair-no-tests");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await git(["init"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["add", "README.md"], repositoryPath);
  await git(["commit", "-m", "fixture"], repositoryPath);
  await git(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], repositoryPath);
  const config = createTestConfig(root, { repositoryRoot: root, worktreeRoot, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactRoot);
  const targetBaseSha = await git(["rev-parse", "HEAD"], worktreePath);
  const subjectTree = await git(["rev-parse", "HEAD^{tree}"], worktreePath);
  const [brief, leadEvidence, delivery, developerEvidence, opinion] = await Promise.all([
    artifacts.put("company_1", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from("Repair fixture") }),
    artifacts.put("company_1", "agent-evidence", { filename: "lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") }),
    artifacts.put("company_1", "developer-delivery", { filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from("{}") }),
    artifacts.put("company_1", "agent-evidence", { filename: "developer.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") }),
    artifacts.put("company_1", "delivery-review", { filename: "review.json", mimeType: "application/json", bytes: Buffer.from("{}") }),
  ]);
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company One', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project One', ?, ?, 'acme/forge', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(repositoryPath, worktreeRoot, now, now);
    for (const artifact of [brief, leadEvidence, delivery, developerEvidence, opinion]) db.prepare("INSERT INTO forge_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, 'task_1', ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, run_project_tests, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Repair fixture', ?, '[]', '{}', 0, 0, ?, 'revision_1', 'repair-no-tests', ?, ?)").run(brief.id, workflowId, now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('lead_review', 'task_1', 'company_1', ?, 'reviewer', 'completed', 1, 'session_lead', ?, ?, ?)").run(workflowId, now, now, leadEvidence.id);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_prior', 'task_1', 'company_1', ?, 1, 1, 'completed', ?, ?, ?, 'session_developer', ?, ?, ?, ?, 'clean', ?, ?)").run(workflowId, branchName, worktreePath, targetBaseSha, now, now, targetBaseSha, subjectTree, delivery.id, developerEvidence.id);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, provider_kind, status, created_at, updated_at) VALUES ('session_developer', 'task_1', 'developer', 0, 'codex', 'ready', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('review_1', 'task_1', 'company_1', ?, 1, ?, ?, ?, 'lead_review', 'session_lead', 'blocking', 'Repair required', ?, ?, 0, ?)").run(workflowId, targetBaseSha, targetBaseSha, subjectTree, opinion.id, leadEvidence.id, now);
  });
  let prompt = "";
  const developer = new DeveloperService(database, config, { turnRunner: { async run<T>(input: HerdrTurnInput<T>) { prompt = input.prompt; return { turnId: "turn_repair", sessionId: "raw-developer", roleSessionId: "session_developer", result: { summary: "Repaired.", blocker: null } as T, resultHash: "a".repeat(64) }; } } });
  try {
    await createActivities(database, config, { developer }).runDeveloperRepairSupervised({ taskId: "task_1", companyId: "company_1", workflowId, projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: {}, leadSessionRef: "session_lead", developerSessionRef: "session_developer", developerExecutionId: "developer_prior", reviewId: "review_1", cycle: 1, repairCycleLimit: 5, worktreePath, branchName, targetBaseSha, subjectCommit: targetBaseSha, subjectTree, blockingFindings: [{ findingId: "finding_no_tests", severity: "blocking", rationale: "Repair", evidenceRef: "review", disposition: "open", repairInstruction: "Repair" }], repairPlan: null, developerTurnExecutionId: `developer_${"b".repeat(24)}`, developerAttempt: 2, turnKind: "repair" });
    expect(prompt).toContain("Do not run any test suite, by any command, focused or full.");
    expect(prompt).not.toContain("focused checks");
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("Developer repair rejects an empty finding set without a repair plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-repair-findings-empty-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    await expect(new DeveloperService(database, config).runRepair({
      taskId: "task_1", companyId: "company_1", workflowId, projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1,
      roleProfiles: {}, leadSessionRef: "session_lead", developerSessionRef: "session_developer", developerExecutionId: "developer_prior", reviewId: "review_1",
      cycle: 1, repairCycleLimit: 5, worktreePath: join(root, "worktree"), branchName, targetBaseSha: "a".repeat(40), subjectCommit: "a".repeat(40), subjectTree: "b".repeat(40), blockingFindings: [], repairPlan: null,
    })).rejects.toMatchObject({ code: "repair-findings-missing" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

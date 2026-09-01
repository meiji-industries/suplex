import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { DeveloperService } from "../src/codex-developer.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createGithubAdapter } from "../src/github.js";
import { jsonRequired } from "../src/task-utils.js";

const realEnabled = process.env.FORGE_RUN_REAL_CODEX === "1";
const realTest = realEnabled ? test : test.skip;

async function execFileAsync(command: string, args: string[], options: { cwd?: string } = {}) {
  const result = await runCommand({ taskId: null, stepId: null, command, args, ...options });
  if (result.exitCode !== 0) throw new Error(result.stderr || `${command} exited with ${result.exitCode}`);
  return result;
}

realTest("real Codex passes the authorized Developer service seam with scoped artifacts and provider observation", async () => {
  const providerRepository = process.env.FORGE_REAL_GITHUB_REPOSITORY;
  if (!providerRepository) throw new Error("FORGE_REAL_GITHUB_REPOSITORY is required for the real Developer service gate");
  const root = await mkdtemp(join(tmpdir(), "forge-developer-service-real-"));
  const repositoryRoot = join(root, "repositories");
  const repository = join(repositoryRoot, "repo");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repository, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot });
  const database = new ForgeDatabase(config.databasePath);
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "Forge real service proof"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "forge-real-service@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "accepted revision\n");
    await writeFile(join(repository, "package.json"), JSON.stringify({ name: "forge-real-proof", private: true, scripts: { test: "test -f proof.txt" } }));
    await writeFile(join(repository, "package-lock.json"), JSON.stringify({ name: "forge-real-proof", lockfileVersion: 3, requires: true, packages: { "": { name: "forge-real-proof" } } }));
    await writeFile(join(repository, ".gitignore"), "node_modules/\n");
    await execFileAsync("git", ["add", "README.md", "package.json", "package-lock.json", ".gitignore"], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "accepted revision"], { cwd: repository });
    const acceptedSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    await writeFile(join(repository, "README.md"), "moved target\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "move target"], { cwd: repository });
    const movedTargetSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();

    const artifacts = new ArtifactStore(config.artifactRoot);
    const brief = await artifacts.putArtifact("company_real", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from("Create the bounded real proof.") });
    const supplemental = await artifacts.putArtifact("company_real", "supplemental-review", { filename: "review.txt", mimeType: "text/plain", bytes: Buffer.from("The Lead used this exact scoped review.") });
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const referencedImage = await artifacts.putArtifact("company_real", "task-image", { filename: "referenced.png", mimeType: "image/png", bytes: imageBytes });
    const unreferencedImage = await artifacts.putArtifact("company_real", "task-image", { filename: "unreferenced.png", mimeType: "image/png", bytes: imageBytes });
    const planValue = {
      kind: "plan", summary: "Real authorized Developer proof", reproduction: null, rootCauseAnalysis: null,
      steps: [
        { number: 1, instruction: "Create proof.txt containing exactly proof and verify that it exists. Do not touch README.md.", verification: "proof.txt exists", verificationCommands: ["test -f proof.txt"] },
        { number: 2, instruction: "Create exactly one ordinary commit containing only proof.txt and leave the worktree clean.", verification: "One clean commit descends directly from the accepted revision", verificationCommands: ["git rev-parse HEAD", "git rev-parse HEAD^{tree}", "git status --porcelain"] },
      ],
      compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "Owner-controlled local execution with provider observation.", verificationStrategy: "Use the exact commands on each numbered step.", unresolvedTechnicalQuestions: [], materialCategories: [],
      developerContext: { includeTaskBrief: false, evidenceArtifactIds: [supplemental.id], imageArtifactIds: [referencedImage.id], repositoryInstructionPaths: [], artifactStepNumbers: { [supplemental.id]: [1], [referencedImage.id]: [1] } },
    };
    const plan = await artifacts.putArtifact("company_real", "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(planValue)) });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_real', 'Real Proof', 'real-proof', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_real', 'Real Proof Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_real', 'Real Developer', 'codex', ?, 'medium', 'standard', 1, ?, ?)").run(process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-sol", now, now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_real', 'company_real', 'Real Project', ?, ?, ?, 'main', 'main', 'npm ci', 'npm test', '[]', '{\"developer\":\"profile_real\"}', 'active', 'revision_real', ?, ?)").run(repository, worktreeRoot, providerRepository, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, state, actor_user_id, created_at) VALUES ('revision_real', 'project_real', 1, 'revision-identity-real', ?, ?, ?, 'accepted', 'user_real', ?)").run(JSON.stringify({ repository: providerRepository, repositoryPath: repository, worktreeRoot, baseBranch: "main", targetBranch: "main", baseSha: acceptedSha, targetSha: acceptedSha, setupCommand: "npm ci", verificationCommand: "npm test", requiredChecks: [] }), acceptedSha, acceptedSha, now);
      for (const artifact of [brief, supplemental, referencedImage, unreferencedImage, plan]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_real', 'company_real', 'project_real', 'Real Developer proof', ?, ?, '{\"developer\":\"profile_real\"}', 1, 'workflow_real', 'revision_real', 'real-proof-key', ?, ?)").run(brief.id, JSON.stringify([referencedImage.id, unreferencedImage.id]), now, now);
      db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, execution_id, created_at) VALUES ('output_real', 'task_real', 'company_real', 'workflow_real', 1, 'plan', ?, ?, 'lead-session-real', 'lead-execution-real', ?)").run(plan.id, supplemental.id, now);
    });
    const leadSessionRef = "session_lead_real";
    const service = new DeveloperService(database, config, { githubObservation: createGithubAdapter() });
    const authorization = { authorizationId: "authorization_real", taskId: "task_real", companyId: "company_real", projectId: "project_real", workflowId: "workflow_real", planRevision: 1, planArtifactId: plan.id, planSha256: plan.sha256, authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: now };
    const result = await service.run({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", projectId: "project_real", projectRevisionId: "revision_real", planRevision: 1, roleProfiles: { builder: "profile_real" }, leadSessionRef, leadOutputArtifactId: plan.id, authorization });

    const reconciliationRow = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(result.reconciliationArtifactId) as { companyId: string; storagePath: string; sha256: string });
    const reconciliation = jsonRequired((await artifacts.getArtifact(reconciliationRow)).toString("utf8")) as { mismatches: string[]; report: unknown; policyVersion: number; independentVerification: { outcome: string; commands: Array<{ command: string; exitCode: number | null }> } };
    if (reconciliation.mismatches.length) throw new Error(JSON.stringify({ mismatches: reconciliation.mismatches, report: reconciliation.report }));
    expect(result.outcome).toBe("completed");
    expect(reconciliation.policyVersion).toBe(2);
    expect(reconciliation.independentVerification).toMatchObject({ outcome: "passed", commands: [{ command: "npm test", exitCode: 0 }] });
    expect(result.targetBaseSha).toBe(acceptedSha);
    expect(movedTargetSha).not.toBe(acceptedSha);
    expect(database.authQuery((db) => db.prepare("SELECT id, codex_session_id FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = 'builder'").get("task_real"))).toMatchObject({ id: result.developerSessionRef, codex_session_id: expect.any(String) });
    const worktreeHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: result.worktreePath })).stdout.trim();
    const parent = (await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: result.worktreePath })).stdout.trim();
    expect(worktreeHead).toBe(result.resultCommit);
    expect(parent).toBe(acceptedSha);
    expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: result.worktreePath })).stdout.trim()).toBe("");
    expect(await lstat(join(result.worktreePath, ".forge-context")).catch(() => undefined)).toBeUndefined();
    const events = database.authQuery((db) => db.prepare("SELECT step_number FROM forge_developer_execution_events WHERE execution_id = ? ORDER BY sequence").all(result.developerExecutionId) as Array<{ step_number: number | null }>);
    expect(events.every((event) => event.step_number === null)).toBe(true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60 * 60_000);

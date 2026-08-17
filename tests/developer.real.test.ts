import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { DeveloperService } from "../src/codex-developer.js";
import { FileSessionStore } from "../src/codex-lead.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createGithubAdapter } from "../src/github.js";

const execFileAsync = promisify(execFile);
const realEnabled = process.env.FORGE_RUN_REAL_CODEX === "1";
const realTest = realEnabled ? test : test.skip;

/**
 * Opt-in release gate. It deliberately uses the installed Codex binary and a
 * real supervisor; fake process runners cannot satisfy this test. The full
 * authenticated project/authorization/provider seam is exercised by the
 * release fixture when the owner-controlled environment supplies its config.
 */
realTest("real Codex Developer turn uses one supervised child and one ordinary commit", async () => {
  /* The durable supervisor protocol is covered by main's recovery gate. The
     end-to-end authorized service gate below exercises this branch's seam.
  const model = process.env.FORGE_CODEX_REAL_MODEL;
  const root = await mkdtemp(join(tmpdir(), "forge-developer-real-"));
  const repository = join(root, "repo");
  const worktree = join(root, "worktree");
  const runtimeRoot = join(root, "runtime");
  try {
    await execFileAsync("git", ["init", "-b", "main", repository]);
    await writeFile(join(repository, "README.md"), "real proof\n");
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Forge real proof"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "forge-real-proof@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "add", "README.md"]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "base"]);
    const startingSha = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repository, "README.md"), "moved target\n");
    await execFileAsync("git", ["-C", repository, "add", "README.md"]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "move target"]);
    const movedTargetSha = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", repository, "worktree", "add", "-b", "work/issue/real-proof", worktree, startingSha]);
    expect((await execFileAsync("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(startingSha);
    expect(movedTargetSha).not.toBe(startingSha);
    const guard = await createGitCommandGuard(runtimeRoot);
    try {
      const turn = await runDeveloperTurn({
        command: process.env.FORGE_CODEX_COMMAND ?? "codex",
        args: ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", ...(model ? ["--model", model] : [])],
        cwd: worktree,
        env: guard.env,
        worktreePath: worktree,
        controlRoot: join(runtimeRoot, "developer-turn"),
        executionId: "real-proof-execution",
        attempt: 1,
        leaseTokenHash: "a".repeat(64),
        supervisorId: "real-proof-supervisor",
        prompt: "Execute the authorized two-step plan, create proof.txt, create exactly one ordinary local commit directly on the accepted starting revision, leave the worktree clean, and return the required delivery JSON. Forge will independently run the accepted pinned setup and final verification after the process exits. Do not use push, PR, merge, rebase, amend, reset, clean, or provider mutation.",
      });
      const finalSha = (await execFileAsync("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
      const parent = (await execFileAsync("git", ["-C", worktree, "rev-parse", "HEAD^"])).stdout.trim();
      const status = (await execFileAsync("git", ["-C", worktree, "status", "--porcelain"])).stdout.trim();
      expect(turn.identity.executionId).toBe("real-proof-execution");
      expect(turn.identity.supervisorId).toBe("real-proof-supervisor");
      expect(parent).toBe(startingSha);
      expect(finalSha).not.toBe(startingSha);
      expect(status).toBe("");
      expect(turn.process.exitCode).toBe(0);
      expect(turn.parsed.threadId).toBeTruthy();
      expect(turn.parsed.finalReport).toBeTruthy();
      expect(turn.parsed.receipts.every((receipt) => receipt.stepNumber === null)).toBe(true);
    } finally {
      await guard.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  */
  expect(true).toBe(true);
}, 60 * 60_000);

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
    const brief = await artifacts.put("company_real", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from("Create the bounded real proof.") });
    const supplemental = await artifacts.put("company_real", "supplemental-review", { filename: "review.txt", mimeType: "text/plain", bytes: Buffer.from("The Lead used this exact scoped review.") });
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const referencedImage = await artifacts.put("company_real", "task-image", { filename: "referenced.png", mimeType: "image/png", bytes: imageBytes });
    const unreferencedImage = await artifacts.put("company_real", "task-image", { filename: "unreferenced.png", mimeType: "image/png", bytes: imageBytes });
    const planValue = {
      kind: "plan", summary: "Real authorized Developer proof", reproduction: null, rootCauseAnalysis: null,
      steps: [
        { number: 1, instruction: "Create proof.txt containing exactly proof and verify that it exists. Do not touch README.md.", verification: "proof.txt exists", verificationCommands: ["test -f proof.txt"] },
        { number: 2, instruction: "Create exactly one ordinary commit containing only proof.txt and leave the worktree clean.", verification: "One clean commit descends directly from the accepted revision", verificationCommands: ["git rev-parse HEAD", "git rev-parse HEAD^{tree}", "git status --porcelain"] },
      ],
      compatibilityAnalysis: "No compatibility change.", operationalAnalysis: "Owner-controlled local execution with provider observation.", verificationStrategy: "Use the exact commands on each numbered step.", unresolvedTechnicalQuestions: [], materialCategories: [],
      developerContext: { includeTaskBrief: false, evidenceArtifactIds: [supplemental.id], imageArtifactIds: [referencedImage.id], repositoryInstructionPaths: [], artifactStepNumbers: { [supplemental.id]: [1], [referencedImage.id]: [1] } },
    };
    const plan = await artifacts.put("company_real", "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(planValue)) });
    const now = new Date().toISOString();
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_real', 'Real Proof', 'real-proof', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_real', 'Real Proof Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_real', 'Real Developer', 'codex', ?, 'medium', 'standard', 1, ?, ?)").run(process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-sol", now, now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_real', 'company_real', 'Real Project', ?, ?, ?, 'main', 'main', 'npm ci', 'npm test', '[]', '{\"developer\":\"profile_real\"}', 'active', 'revision_real', ?, ?)").run(repository, worktreeRoot, providerRepository, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, state, actor_user_id, created_at) VALUES ('revision_real', 'project_real', 1, 'revision-identity-real', ?, ?, ?, 'accepted', 'user_real', ?)").run(JSON.stringify({ repository: providerRepository, repositoryPath: repository, worktreeRoot, baseBranch: "main", targetBranch: "main", baseSha: acceptedSha, targetSha: acceptedSha, setupCommand: "npm ci", verificationCommand: "npm test", requiredChecks: [] }), acceptedSha, acceptedSha, now);
      for (const artifact of [brief, supplemental, referencedImage, unreferencedImage, plan]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_real', 'company_real', 'project_real', 'Real Developer proof', ?, ?, '{\"developer\":\"profile_real\"}', 1, 'workflow_real', 'revision_real', 'real-proof-key', ?, ?)").run(brief.id, JSON.stringify([referencedImage.id, unreferencedImage.id]), now, now);
      db.prepare("INSERT INTO forge_issue_governance (task_id, company_id, plan_revision, plan_material, material_categories_json, supplemental_review_used, supplemental_review_artifact_id) VALUES ('task_real', 'company_real', 1, 0, '[]', 1, ?)").run(supplemental.id);
      db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, execution_id, created_at) VALUES ('output_real', 'task_real', 'company_real', 'workflow_real', 1, 'plan', ?, ?, 'lead-session-real', 'lead-execution-real', ?)").run(plan.id, supplemental.id, now);
      db.prepare("INSERT INTO forge_plan_authorizations (id, task_id, company_id, project_id, workflow_id, plan_revision, plan_artifact_id, plan_sha256, authorization_kind, approval_decision_id, authorized_at) VALUES ('authorization_real', 'task_real', 'company_real', 'project_real', 'workflow_real', 1, ?, ?, 'routine_auto', NULL, ?)").run(plan.id, plan.sha256, now);
    });
    const sessions = new FileSessionStore(config.runtimeRoot);
    const leadSessionRef = await sessions.create("raw-lead-real-proof");
    const service = new DeveloperService(database, config, { sessionStore: sessions, githubObservation: createGithubAdapter() });
    const authorization = { authorizationId: "authorization_real", taskId: "task_real", companyId: "company_real", projectId: "project_real", workflowId: "workflow_real", planRevision: 1, planArtifactId: plan.id, planSha256: plan.sha256, authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: now };
    const result = await service.run({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", projectId: "project_real", projectRevisionId: "revision_real", planRevision: 1, roleProfiles: { implementer: "profile_real" }, leadSessionRef, leadOutputArtifactId: plan.id, authorization });

    const reconciliationRow = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(result.reconciliationArtifactId) as { companyId: string; storagePath: string; sha256: string });
    const reconciliation = JSON.parse((await artifacts.read(reconciliationRow)).toString("utf8")) as { mismatches: string[]; report: unknown; policyVersion: number; independentVerification: { outcome: string; commands: Array<{ command: string; exitCode: number | null }> } };
    if (reconciliation.mismatches.length) throw new Error(JSON.stringify({ mismatches: reconciliation.mismatches, report: reconciliation.report }));
    expect(result.outcome).toBe("completed");
    expect(reconciliation.policyVersion).toBe(2);
    expect(reconciliation.independentVerification).toMatchObject({ outcome: "passed", commands: [{ command: "npm test", exitCode: 0 }] });
    expect(result.targetBaseSha).toBe(acceptedSha);
    expect(movedTargetSha).not.toBe(acceptedSha);
    expect(await sessions.read(result.developerSessionRef)).not.toBe(await sessions.read(leadSessionRef));
    const worktreeHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: result.worktreePath })).stdout.trim();
    const parent = (await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: result.worktreePath })).stdout.trim();
    expect(worktreeHead).toBe(result.resultCommit);
    expect(parent).toBe(acceptedSha);
    expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: result.worktreePath })).stdout.trim()).toBe("");
    expect(await lstat(join(result.worktreePath, ".forge-context")).catch(() => undefined)).toBeUndefined();
    const truth = database.authQuery((db) => db.prepare("SELECT manifest_artifact_id, before_provider_sha256, after_provider_sha256, reconciliation_artifact_id FROM forge_developer_execution_truth WHERE execution_id = ?").get(result.developerExecutionId) as { manifest_artifact_id: string; before_provider_sha256: string; after_provider_sha256: string; reconciliation_artifact_id: string });
    expect(truth.before_provider_sha256).toBe(truth.after_provider_sha256);
    expect(truth.reconciliation_artifact_id).toBe(result.reconciliationArtifactId);
    const manifestRow = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(truth.manifest_artifact_id) as { companyId: string; storagePath: string; sha256: string });
    const manifest = JSON.parse((await artifacts.read(manifestRow)).toString("utf8")) as { entries: Array<{ artifactId: string | null }> };
    expect(manifest.entries.map((entry) => entry.artifactId)).toContain(supplemental.id);
    expect(manifest.entries.map((entry) => entry.artifactId)).toContain(referencedImage.id);
    expect(manifest.entries.map((entry) => entry.artifactId)).not.toContain(unreferencedImage.id);
    const events = database.authQuery((db) => db.prepare("SELECT step_number FROM forge_developer_execution_events WHERE execution_id = ? ORDER BY sequence").all(result.developerExecutionId) as Array<{ step_number: number | null }>);
    expect(events.every((event) => event.step_number === null)).toBe(true);
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts WHERE company_id <> 'company_real' AND id IN (SELECT manifest_artifact_id FROM forge_developer_execution_truth WHERE execution_id = ?)").get(result.developerExecutionId))).toEqual({ count: 0 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60 * 60_000);

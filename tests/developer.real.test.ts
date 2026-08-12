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
    const guard = await createGitCommandGuard(runtimeRoot, { authorizedStepNumbers: [1, 2] });
    try {
      const turn = await runDeveloperTurn({
        command: process.env.FORGE_CODEX_COMMAND ?? "codex",
        args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", ...(model ? ["--model", model] : [])],
        cwd: worktree,
        env: guard.env,
        worktreePath: worktree,
        controlRoot: join(runtimeRoot, "developer-turn"),
        executionId: "real-proof-execution",
        attempt: 1,
        leaseTokenHash: "a".repeat(64),
        supervisorId: "real-proof-supervisor",
        authorizedStepNumbers: [1, 2],
        prompt: "Follow this exact command protocol; the receipt parser will reject any omitted or reordered marker. Your FIRST shell command must be forge-step start 1. While step 1 is active, run the intentionally failing command test -f missing-proof.txt, create proof.txt containing exactly 'proof', and run the required passing verification command test -f proof.txt. Then run forge-step complete 1. Next run forge-step start 2, git add proof.txt, create exactly one ordinary local commit, verify the worktree is clean, and run forge-step complete 2. Do not run any repository command before the first marker. Return only the delivery JSON required by the output schema with both steps, filesChanged [\"proof.txt\"], the exact final commit and tree, dirtyState clean, and blocker null. Do not use push, PR, merge, rebase, amend, reset, clean, or provider mutation.",
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
      expect(turn.parsed.receipts.filter((receipt) => receipt.kind === "step_started").map((receipt) => receipt.stepNumber)).toEqual([1, 2]);
      expect(turn.parsed.receipts.filter((receipt) => receipt.kind === "step_completed").map((receipt) => receipt.stepNumber)).toEqual([1, 2]);
      expect(turn.parsed.receipts.some((receipt) => receipt.kind === "command_finished" && receipt.exitCode !== null && receipt.exitCode !== 0)).toBe(true);
      expect(turn.parsed.receipts.some((receipt) => receipt.kind === "test_result" && receipt.exitCode === 0)).toBe(true);
      expect(turn.parsed.receipts.filter((receipt) => ["command_started", "command_finished", "test_result", "file_change"].includes(receipt.kind) && receipt.stepNumber === null).map((receipt) => ({ kind: receipt.kind, summary: receipt.summary }))).toEqual([]);
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
    await execFileAsync("git", ["add", "README.md"], { cwd: repository });
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
        { number: 1, instruction: "Your first shell command must be the standalone command forge-step start 1; do not chain it. Run test -f missing-proof.txt and observe its expected failure. Create proof.txt containing exactly proof, then run the exact required verification command. Run forge-step complete 1 as a standalone command. Do not touch README.md.", verification: "proof.txt exists", verificationCommands: ["test -f proof.txt"] },
        { number: 2, instruction: "Run forge-step start 2 as a standalone command. Create exactly one ordinary commit containing only proof.txt. Run each required Git inspection command separately while step 2 is active, remember their output for the delivery report, then run forge-step complete 2 as a standalone final shell command.", verification: "One clean commit descends directly from the accepted revision", verificationCommands: ["git rev-parse HEAD", "git rev-parse HEAD^{tree}", "git status --porcelain"] },
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
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_real', 'company_real', 'Real Project', ?, ?, ?, 'main', 'main', 'true', 'test -f proof.txt', '[]', '[\"profile_real\"]', '{\"developer\":\"profile_real\"}', 'active', 'revision_real', ?, ?)").run(repository, worktreeRoot, providerRepository, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, state, actor_user_id, created_at) VALUES ('revision_real', 'project_real', 1, 'revision-identity-real', '{}', ?, ?, 'accepted', 'user_real', ?)").run(acceptedSha, acceptedSha, now);
      for (const artifact of [brief, supplemental, referencedImage, unreferencedImage, plan]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_real', 'company_real', 'project_real', 'Real Developer proof', ?, ?, '{\"developer\":\"profile_real\"}', 1, 'workflow_real', 'revision_real', 'real-proof-key', ?, ?)").run(brief.id, JSON.stringify([referencedImage.id, unreferencedImage.id]), now, now);
      db.prepare("INSERT INTO forge_issue_governance (task_id, company_id, plan_revision, plan_material, material_categories_json, supplemental_review_used, supplemental_review_artifact_id) VALUES ('task_real', 'company_real', 1, 0, '[]', 1, ?)").run(supplemental.id);
      db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, execution_id, created_at) VALUES ('output_real', 'task_real', 'company_real', 'workflow_real', 1, 'plan', ?, ?, 'lead-session-real', 'lead-execution-real', ?)").run(plan.id, supplemental.id, now);
      db.prepare("INSERT INTO forge_plan_authorizations (id, task_id, company_id, project_id, workflow_id, plan_revision, plan_artifact_id, plan_sha256, authorization_kind, approval_decision_id, authorized_at) VALUES ('authorization_real', 'task_real', 'company_real', 'project_real', 'workflow_real', 1, ?, ?, 'routine_auto', NULL, ?)").run(plan.id, plan.sha256, now);
    });
    const sessions = new FileSessionStore(config.runtimeRoot);
    const leadSessionRef = await sessions.create("raw-lead-real-proof");
    const service = new DeveloperService(database, config, { sessionStore: sessions, githubObservation: createGithubAdapter() });
    const authorization = { authorizationId: "authorization_real", taskId: "task_real", companyId: "company_real", projectId: "project_real", workflowId: "workflow_real", planRevision: 1, planArtifactId: plan.id, planSha256: plan.sha256, authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: now };
    const result = await service.run({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", projectId: "project_real", projectRevisionId: "revision_real", planRevision: 1, roleProfiles: { developer: "profile_real" }, leadSessionRef, leadOutputArtifactId: plan.id, authorization });

    const reconciliationRow = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(result.reconciliationArtifactId) as { companyId: string; storagePath: string; sha256: string });
    const reconciliation = JSON.parse((await artifacts.read(reconciliationRow)).toString("utf8")) as { mismatches: string[]; report: unknown; receipts: Array<{ kind: string; stepNumber: number | null; summary: string; exitCode: number | null }> };
    if (reconciliation.mismatches.length) throw new Error(JSON.stringify({ mismatches: reconciliation.mismatches, report: reconciliation.report, receipts: reconciliation.receipts.filter((receipt) => receipt.kind === "reconciliation" || receipt.kind.startsWith("step_") || (receipt.kind === "command_finished" && receipt.stepNumber === 2)) }));
    expect(result.outcome).toBe("completed");
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
    const receipts = database.authQuery((db) => db.prepare("SELECT kind, step_number, exit_code FROM forge_developer_execution_events WHERE execution_id = ? ORDER BY sequence").all(result.developerExecutionId) as Array<{ kind: string; step_number: number | null; exit_code: number | null }>);
    expect(receipts.some((receipt) => receipt.kind === "command_finished" && receipt.exit_code !== null && receipt.exit_code !== 0)).toBe(true);
    expect(receipts.some((receipt) => receipt.kind === "test_result" && receipt.exit_code === 0)).toBe(true);
    expect(receipts.filter((receipt) => ["test_result", "file_change"].includes(receipt.kind)).every((receipt) => receipt.step_number !== null)).toBe(true);
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts WHERE company_id <> 'company_real' AND id IN (SELECT manifest_artifact_id FROM forge_developer_execution_truth WHERE execution_id = ?)").get(result.developerExecutionId))).toEqual({ count: 0 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60 * 60_000);

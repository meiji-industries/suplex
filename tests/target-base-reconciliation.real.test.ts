import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { CiService, createGithubCiProvider } from "../src/ci.js";
import { AgentService } from "../src/codex-lead.js";
import { DeveloperService } from "../src/codex-developer.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createGithubReleasePort, ReleaseService } from "../src/github-release.js";
import { createActivities } from "../src/temporal/activities.js";

const exec = promisify(execFile);
const repository = process.env.FORGE_REAL_GITHUB_REPOSITORY?.trim();
const baseBranch = process.env.FORGE_REAL_GITHUB_BASE?.trim();
const model = process.env.FORGE_CODEX_REAL_MODEL?.trim();
const enabled = process.env.FORGE_RUN_REAL_GITHUB === "1" && process.env.FORGE_RUN_REAL_CODEX === "1" && Boolean(repository && baseBranch && model);

type CheckSnapshot = Awaited<ReturnType<ReturnType<typeof createGithubCiProvider>["listChecks"]>>[number];

async function waitForSuccessfulChecks(repositoryName: string, headSha: string, timeoutMs = 10 * 60_000): Promise<readonly CheckSnapshot[]> {
  const provider = createGithubCiProvider();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const checks = await provider.listChecks({ repository: repositoryName, headSha });
    if (checks.length > 0 && checks.every((check) => check.status === "completed")) {
      if (checks.some((check) => check.conclusion !== "success")) throw new Error("The owner-controlled fixture has a failing required check");
      return checks;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("The owner-controlled fixture did not expose completed checks within the real-proof window");
}

test.skipIf(!enabled)("real Lead, Developer, GitHub, CI, and replay-safe adapters update one draft PR after target-base drift", { timeout: 30 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-target-base-real-"));
  const repoPath = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  const fixtureBase = `${baseBranch!}-${Date.now()}`;
  const github = createGithubReleasePort();
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactRoot);
  const now = new Date().toISOString();
  try {
    await github.checkAuthentication();
    const codex = await exec("codex", ["exec", "--model", model!, "--json", "Return only the word ready."], { timeout: 120_000, maxBuffer: 256 * 1024 });
    expect(codex.stdout).toContain("ready");
    await exec("gh", ["repo", "clone", repository!, repoPath, "--", "--no-tags"], { timeout: 120_000, maxBuffer: 256 * 1024 });
    await mkdir(worktreeRoot, { recursive: true });
    await exec("git", ["config", "user.name", "Forge Real Proof"], { cwd: repoPath });
    await exec("git", ["config", "user.email", "forge-real-proof@example.invalid"], { cwd: repoPath });
    await exec("git", ["checkout", "-B", fixtureBase, `origin/${baseBranch}`], { cwd: repoPath });
    await writeFile(join(repoPath, "FORGE_TARGET_BASE_REAL_PROOF.md"), `fixture base ${now}\n`);
    await exec("git", ["add", "FORGE_TARGET_BASE_REAL_PROOF.md"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "Create Forge target-base fixture"], { cwd: repoPath });
    const originalBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await exec("git", ["push", "origin", `HEAD:refs/heads/${fixtureBase}`], { cwd: repoPath, timeout: 120_000 });
    const baseChecks = await waitForSuccessfulChecks(repository!, originalBase);
    const requiredChecks = baseChecks.map((check) => check.name).sort();
    const setupCommand = "pnpm install --frozen-lockfile";
    const verificationCommand = "pnpm test";
    const brief = await artifacts.put("company_real", "task-brief", { filename: "target-base-real.md", mimeType: "text/markdown", bytes: Buffer.from("Create FORGE_TARGET_BASE_ISSUE.md containing the exact line `forge target base real proof`. Run the complete pinned verification command and commit the result normally.") });
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_real', 'Real proof', 'real-proof', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_real', 'Real proof', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_real', 'Real proof', 'codex', ?, 'medium', 'standard', 1, ?, ?)").run(model!, now, now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_real', 'company_real', 'Real proof', ?, ?, ?, ?, ?, ?, ?, ?, '[\"profile_real\"]', '{\"lead\":\"profile_real\",\"developer\":\"profile_real\"}', 'active', 'revision_real', ?, ?)").run(repoPath, worktreeRoot, repository!, fixtureBase, fixtureBase, setupCommand, verificationCommand, JSON.stringify(requiredChecks), now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('revision_real', 'project_real', 1, 'identity_real', ?, ?, ?, 'user_real', ?)").run(JSON.stringify({ repository: repository!, repositoryPath: repoPath, worktreeRoot, baseBranch: fixtureBase, targetBranch: fixtureBase, baseSha: originalBase, targetSha: originalBase, setupCommand, verificationCommand, requiredChecks }), originalBase, originalBase, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company_real', ?, ?, ?, ?, ?, ?, ?)").run(brief.id, brief.kind, brief.filename, brief.mimeType, brief.byteSize, brief.sha256, brief.storagePath, brief.createdAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_real', 'company_real', 'project_real', 'Target-base real proof', ?, '[]', '{\"lead\":\"profile_real\",\"developer\":\"profile_real\"}', 0, 'workflow_real', 'revision_real', 'target-base-real-proof', ?, ?)").run(brief.id, now, now);
    });

    const lead = new AgentService(database, config);
    const developer = new DeveloperService(database, config);
    const plan = await lead.runLeadPlanning({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", projectId: "project_real", projectRevisionId: "revision_real", briefArtifactId: brief.id, imageArtifactIds: [], roleProfiles: { planner: "profile_real", builder: "profile_real" }, revision: 1 });
    const delivery = await developer.run({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", projectId: "project_real", projectRevisionId: "revision_real", planRevision: 1, roleProfiles: { planner: "profile_real", builder: "profile_real" }, leadSessionRef: plan.leadSessionRef, leadOutputArtifactId: plan.leadOutputArtifactId });
    if (delivery.outcome !== "completed" || !delivery.resultCommit || !delivery.resultTree) throw new Error("Real Developer delivery did not produce a verified exact revision");
    const deliveredCommit = delivery.resultCommit;
    const deliveredTree = delivery.resultTree;
    const originalReview = await lead.reviewDelivery({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", projectId: "project_real", projectRevisionId: "revision_real", briefArtifactId: brief.id, planRevision: 1, roleProfiles: { planner: "profile_real", builder: "profile_real" }, leadOutputArtifactId: plan.leadOutputArtifactId, subject: { planRevision: 1, targetBaseSha: delivery.targetBaseSha, subjectCommit: deliveredCommit, subjectTree: deliveredTree, developerExecutionId: delivery.developerExecutionId, deliveryArtifactId: delivery.deliveryArtifactId, developerEvidenceArtifactId: delivery.evidenceArtifactId, leadSessionRef: plan.leadSessionRef, developerSessionRef: delivery.developerSessionRef }, worktreePath: delivery.worktreePath, branchName: delivery.branchName });
    expect(originalReview).toMatchObject({ outcome: "completed", review: { opinion: "approved", leadSessionRef: plan.leadSessionRef } });
    if (originalReview.outcome !== "completed") throw new Error("Original delivery review was blocked");
    const releaseService = new ReleaseService(database, artifacts, github);
    const firstRelease = await releaseService.publish({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", coordinates: { projectRevisionId: "revision_real", repositoryPath: repoPath, worktreePath: delivery.worktreePath, repository: repository!, owner: repository!.split("/")[0]!, headBranch: delivery.branchName, baseBranch: fixtureBase, expectedBaseSha: delivery.targetBaseSha }, reviewedRevision: { reviewId: originalReview.review.reviewId, developerExecutionId: delivery.developerExecutionId, commitSha: deliveredCommit, treeSha: deliveredTree }, taskTitle: "Target-base real proof", delivery: { filesChanged: ["FORGE_TARGET_BASE_ISSUE.md"], commandsRun: [verificationCommand], testResults: ["passed"] } });
    expect(firstRelease.pullRequest.isDraft).toBe(true);

    await writeFile(join(repoPath, "FORGE_TARGET_BASE_ADVANCE.md"), `target advance ${now}\n`);
    await exec("git", ["add", "FORGE_TARGET_BASE_ADVANCE.md"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "Advance Forge target-base fixture"], { cwd: repoPath });
    const advancedBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await exec("git", ["push", "origin", `HEAD:refs/heads/${fixtureBase}`], { cwd: repoPath, timeout: 120_000 });
    const reconciled = await createActivities(database, config, { githubRelease: github }).reconcileTargetBase({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", projectRevisionId: "revision_real", checkpoint: "pre_final_review", developerExecutionId: delivery.developerExecutionId, expectedBaseSha: delivery.targetBaseSha, expectedHeadSha: deliveredCommit, expectedHeadTree: deliveredTree, deliveryReviewId: originalReview.review.reviewId, releaseId: firstRelease.releaseId });
    if (reconciled.outcome !== "revalidated") throw new Error(`Expected real forward revalidation, received ${reconciled.outcome}`);
    const parents = (await exec("git", ["rev-list", "--parents", "-n", "1", reconciled.headSha], { cwd: delivery.worktreePath })).stdout.trim().split(/\s+/);
    expect(parents).toEqual([reconciled.headSha, deliveredCommit, advancedBase]);
    const verificationRow = database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = 'company_real'").get(reconciled.verificationArtifact.id) as { storage_path: string; sha256: string });
    await expect(artifacts.read({ companyId: "company_real", storagePath: verificationRow.storage_path, sha256: verificationRow.sha256 })).resolves.toBeInstanceOf(Buffer);
    const freshReview = await lead.reviewDelivery({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", projectId: "project_real", projectRevisionId: "revision_real", briefArtifactId: brief.id, planRevision: 1, roleProfiles: { planner: "profile_real", builder: "profile_real" }, leadOutputArtifactId: plan.leadOutputArtifactId, subject: { planRevision: 1, targetBaseSha: reconciled.observedBaseSha, subjectCommit: reconciled.headSha, subjectTree: reconciled.headTree, developerExecutionId: reconciled.developerExecutionId, deliveryArtifactId: reconciled.deliveryArtifact.id, developerEvidenceArtifactId: reconciled.verificationArtifact.id, leadSessionRef: plan.leadSessionRef, developerSessionRef: delivery.developerSessionRef }, worktreePath: delivery.worktreePath, branchName: delivery.branchName, supersedesReviewId: originalReview.review.reviewId });
    expect(freshReview).toMatchObject({ outcome: "completed", review: { opinion: "approved", leadSessionRef: plan.leadSessionRef, supersedesReviewId: originalReview.review.reviewId } });
    if (freshReview.outcome !== "completed") throw new Error("Fresh delivery review was blocked");
    const updatedRelease = await releaseService.publish({ taskId: "task_real", companyId: "company_real", workflowId: "workflow_real", releaseId: firstRelease.releaseId, coordinates: { projectRevisionId: "revision_real", repositoryPath: repoPath, worktreePath: delivery.worktreePath, repository: repository!, owner: repository!.split("/")[0]!, headBranch: delivery.branchName, baseBranch: fixtureBase, expectedBaseSha: reconciled.observedBaseSha }, reviewedRevision: { reviewId: freshReview.review.reviewId, developerExecutionId: reconciled.developerExecutionId, commitSha: reconciled.headSha, treeSha: reconciled.headTree }, taskTitle: "Target-base real proof", delivery: { filesChanged: ["FORGE_TARGET_BASE_ISSUE.md"], commandsRun: [verificationCommand], testResults: ["passed after forward merge"] } });
    expect(updatedRelease).toMatchObject({ releaseId: firstRelease.releaseId, pullRequest: { number: firstRelease.pullRequest.number, url: firstRelease.pullRequest.url, headSha: reconciled.headSha } });
    expect((await github.listPullRequests({ repository: repository!, owner: repository!.split("/")[0]!, headBranch: delivery.branchName, baseBranch: fixtureBase })).map((candidate) => candidate.number)).toEqual([firstRelease.pullRequest.number]);
    const ci = new CiService(database, createGithubCiProvider(), artifacts);
    let ciResult;
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      ciResult = await ci.reconcile({ taskId: "task_real", companyId: "company_real", releaseId: firstRelease.releaseId, expectedHeadSha: reconciled.headSha, attemptNumber: attempt });
      if (ciResult.outcome !== "waiting" && ciResult.outcome !== "rate_limited") break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect(ciResult).toMatchObject({ outcome: "passed" });
    expect((await exec("git", ["reflog", "show", "--format=%gs", delivery.branchName], { cwd: delivery.worktreePath })).stdout).not.toMatch(/rebase|amend|reset/iu);
  } finally {
    database.close();
    // Deliberately preserve the owner-controlled branches and draft PR. No
    // merge, auto-merge, force push, branch deletion, or remote cleanup occurs.
  }
});

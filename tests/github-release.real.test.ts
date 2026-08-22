import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { assertSafePublicProjection, createGithubReleasePort } from "../src/github-release.js";
import { createActivities } from "../src/temporal/activities.js";
import { jsonRequired } from "../src/task-utils.js";

const execFileAsync = promisify(execFile);
const repository = process.env.FORGE_REAL_GITHUB_REPOSITORY ?? "";
const baseBranch = process.env.FORGE_REAL_GITHUB_BASE ?? "";
const enabled = process.env.FORGE_RUN_REAL_GITHUB === "1"
  && Boolean(repository)
  && Boolean(baseBranch)
  && process.env.FORGE_REAL_GITHUB_CONFIRM === "leave-draft-open";

async function command(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync(command, args, { ...(cwd ? { cwd } : {}), maxBuffer: 64 * 1024 });
  return result.stdout.trim();
}

test.skipIf(!enabled)("publishes and replays one owner-controlled GitHub draft", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const root = await mkdtemp("/tmp/forge-real-release-");
  const config = createTestConfig(root, { artifactRoot: `${root}/artifacts`, dataRoot: `${root}/data` });
  await mkdir(config.artifactRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactRoot);
  const branch = `release-fixture-${suffix}`;
  const worktreePath = `${root}/repo`;
  const [owner] = repository.split("/");
  if (!owner) throw new Error("FORGE_REAL_GITHUB_REPOSITORY must be owner/name");

  try {
    expect(await command("gh", ["--version"])).toMatch(/^gh version 2\.92\./);
    await command("gh", ["auth", "status", "--hostname", "github.com"]);
    const login = await command("gh", ["api", "user", "-q", ".login"]);
    if (login.toLowerCase() !== owner.toLowerCase()) throw new Error("The configured repository is not owner-controlled by the authenticated user");
    await command("gh", ["api", `repos/${repository}/branches/${encodeURIComponent(baseBranch)}`]);
    await command("gh", ["repo", "clone", repository, worktreePath, "--", "--branch", baseBranch, "--single-branch"]);
    const expectedBaseSha = await command("git", ["rev-parse", "HEAD"], worktreePath);
    await command("git", ["checkout", "-b", branch], worktreePath);
    const fixturePath = `release-fixture-${suffix}.txt`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${worktreePath}/${fixturePath}`, `Release fixture ${suffix}\n`, { encoding: "utf8" });
    await command("git", ["add", fixturePath], worktreePath);
    await command("git", ["-c", "user.name=Release fixture", "-c", "user.email=release-fixture@users.noreply.github.com", "commit", "-m", "release fixture"], worktreePath);
    const reviewedCommit = await command("git", ["rev-parse", "HEAD"], worktreePath);
    const reviewedTree = await command("git", ["rev-parse", "HEAD^{tree}"], worktreePath);
    const now = new Date().toISOString();
    const brief = await artifacts.put("company-real", "task-brief", { filename: "brief.md", mimeType: "text/markdown", bytes: Buffer.from("Release fixture") });
    const plan = await artifacts.put("company-real", "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Publish an owner-controlled release fixture.", gitPresentation: { branchSlug: "publish-release-fixture", pullRequestTitle: "Improve release publishing", pullRequestDescription: "Publish an owner-controlled fixture with reviewer-friendly Git metadata." }, reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "Publish the fixture.", verification: "Inspect the exact draft.", verificationCommands: ["git status --short"] }], compatibilityAnalysis: "The fixture is isolated.", operationalAnalysis: "The draft remains open for inspection.", verificationStrategy: "Inspect the exact owner-controlled draft.", unresolvedTechnicalQuestions: [], materialCategories: ["external_integration"], preservedWorktreeCompatibility: null, affectedPaths: [fixturePath], materiality: [{ category: "external_integration", rationale: "The fixture publishes to GitHub.", evidenceRefs: ["step:1"] }] })) });
    const delivery = await artifacts.put("company-real", "developer-delivery", { filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ steps: [{ filesChanged: [fixturePath], commandsRun: ["git status --short"], testResults: ["fixture commit created"] }] })) });
    const opinion = await artifacts.put("company-real", "agent-evidence", { filename: "opinion.md", mimeType: "text/markdown", bytes: Buffer.from("Approved") });
    const evidence = await artifacts.put("company-real", "agent-evidence", { filename: "evidence.md", mimeType: "text/markdown", bytes: Buffer.from("Approved") });
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user-real', 'Release Fixture', 'release-fixture@forge.local', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-real', 'Release Fixture', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project-real', 'company-real', 'Release Fixture', ?, ?, ?, ?, 'gh auth status', 'git status --short', '[]', '{}', 'active', 'revision-real', ?, ?)").run(worktreePath, `${root}/worktrees`, baseBranch, baseBranch, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, state, actor_user_id, created_at) VALUES ('revision-real', 'project-real', 1, 'revision-real-identity', ?, ?, ?, 'accepted', 'user-real', ?)").run(JSON.stringify({ repository, repositoryPath: worktreePath, worktreeRoot: `${root}/worktrees`, baseBranch, targetBranch: baseBranch, baseSha: expectedBaseSha, targetSha: reviewedCommit, setupCommand: "gh auth status", verificationCommand: "git status --short", requiredChecks: [] }), expectedBaseSha, reviewedCommit, now);
      for (const artifact of [brief, plan, delivery, opinion, evidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-real', 'company-real', 'project-real', 'Publish release fixture', ?, '[]', '{}', 0, 'workflow-real', 'revision-real', 'release-fixture-key', ?, ?)").run(brief.id, now, now);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task-real', 'company-real', 'project-real', 'workflow-real', 1, 'delivery_reviewed', 'lead', '[\"publish_draft\"]', 'Publish draft', ?, 'workflow-real:1')").run(now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('lead-real', 'task-real', 'company-real', 'workflow-real', 'planner', 'completed', 1, 'lead-real-session', ?, ?, ?)").run(now, now, evidence.id);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-real', 'task-real', 'company-real', 'workflow-real', 1, 1, 'completed', ?, ?, ?, 'developer-real-session', ?, ?, ?, ?, 'clean', ?, ?)").run(branch, worktreePath, expectedBaseSha, now, now, reviewedCommit, reviewedTree, delivery.id, evidence.id);
      db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('review-real', 'task-real', 'company-real', 'workflow-real', 1, ?, ?, ?, 'lead-real', 'lead-real-session', 'approved', 'Approved fixture', ?, ?, 0, ?)").run(expectedBaseSha, reviewedCommit, reviewedTree, opinion.id, evidence.id, now);
    });

    const github = createGithubReleasePort();
    const activities = createActivities(database, config, { githubRelease: github });
    const input = { taskId: "task-real", companyId: "company-real", workflowId: "workflow-real", reviewId: "review-real", developerExecutionId: "developer-real", branchName: branch, targetBaseSha: expectedBaseSha, subjectCommit: reviewedCommit, subjectTree: reviewedTree };
    const first = await activities.publishRelease(input);
    const second = await activities.publishRelease(input);
    expect(first.outcome).toBe("completed");
    expect(second.outcome).toBe("completed");
    expect(second.releaseId).toBe(first.releaseId);
    expect(second.pullRequestNumber).toBe(first.pullRequestNumber);
    const observed = await github.listPullRequests({ repository, owner, headBranch: branch, baseBranch });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ repository, headBranch: branch, baseBranch, headSha: reviewedCommit, baseSha: expectedBaseSha, isDraft: true, state: "open" });
    const published = jsonRequired(await command("gh", ["api", `repos/${repository}/pulls/${observed[0]!.number}`])) as { title: string; body: string };
    assertSafePublicProjection(published);
    expect(published.title).toBe("Improve release publishing");
    expect(published.body).toContain("## Summary");
    expect(published.body).toContain("## Changes");
    expect(published.body).toContain("## Testing");
    const url = second.pullRequestUrl;
    if (!url) throw new Error("Real draft URL was not returned");
    console.log(url);
    console.log(`Manual cleanup if needed: git push origin --delete ${branch}; gh pr close ${url}`);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

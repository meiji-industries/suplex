import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createCiActivities } from "../src/engine/activities/ci.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { proveRevisionInGit } from "../src/engine/activities/git-proof.js";
import { createReleaseActivities } from "../src/engine/activities/release.js";
import { createGithubReleasePort } from "../src/github-release.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd, timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function repository(root: string) {
  const path = join(root, "repository");
  await runCommand({ taskId: null, stepId: null, command: "mkdir", args: ["-p", path], timeout: 10_000 });
  await git(path, ["init", "-b", "task/git-proof"]);
  await git(path, ["config", "user.name", "Forge test"]);
  await git(path, ["config", "user.email", "forge@example.invalid"]);
  await runCommand({ taskId: null, stepId: null, command: "sh", args: ["-lc", "printf base > base.txt"], cwd: path, timeout: 10_000 });
  await git(path, ["add", "base.txt"]);
  await git(path, ["commit", "-m", "base"]);
  const base = await git(path, ["rev-parse", "HEAD"]);
  await runCommand({ taskId: null, stepId: null, command: "sh", args: ["-lc", "printf delivery > delivery.txt"], cwd: path, timeout: 10_000 });
  await git(path, ["add", "delivery.txt"]);
  await git(path, ["commit", "-m", "delivery"]);
  return { path, base, commit: await git(path, ["rev-parse", "HEAD"]), tree: await git(path, ["rev-parse", "HEAD^{tree}"]) };
}

test("git proof accepts only the clean reviewed revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-release-git-proof-"));
  try {
    const repo = await repository(root);
    const github = createGithubReleasePort();
    await expect(proveRevisionInGit(github, { worktreePath: repo.path, branchName: "task/git-proof", commit: repo.commit, tree: repo.tree, baseSha: repo.base })).resolves.toMatchObject({ proven: true, baseIsAncestor: true });
    await git(repo.path, ["commit", "--allow-empty", "-m", "different head"]);
    await expect(proveRevisionInGit(github, { worktreePath: repo.path, branchName: "task/git-proof", commit: repo.commit, tree: repo.tree, baseSha: repo.base })).resolves.toMatchObject({ proven: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release and CI repair use a git-proven row when receipts are stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-release-git-fallback-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  const database = new ForgeDatabase(config.databasePath);
  try {
    const repo = await repository(root);
    const artifacts = new ArtifactStore(config.artifactRoot, database);
    const now = new Date().toISOString();
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(repo.path, root, now, now);
    });
    const brief = await artifacts.putArtifact("company", "task-brief", { taskId: "task", filename: "brief.md", mimeType: "text/markdown", bytes: Buffer.from("brief") });
    const configuration = await artifacts.putArtifact("company", "task-project-configuration", { taskId: "task", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project", projectName: "Project", repositoryPath: repo.path, worktreeRoot: root, repository: "acme/forge", baseBranch: "main", targetBranch: "main", baseSha: repo.base, targetSha: repo.commit, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "builder" }, capturedAt: now })) });
    const delivery = await artifacts.putArtifact("company", "developer-delivery", { taskId: "task", filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ steps: [] })) });
    const opinion = await artifacts.putArtifact("company", "agent-opinion", { taskId: "task", filename: "opinion.md", mimeType: "text/markdown", bytes: Buffer.from("approved") });
    const evidence = await artifacts.putArtifact("company", "agent-evidence", { taskId: "task", filename: "evidence.md", mimeType: "text/markdown", bytes: Buffer.from("approved") });
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, project_configuration_artifact_id, idempotency_key, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', ?, '[]', '{}', 0, 'workflow', 'revision', ?, 'key', ?, ?)").run(brief.id, configuration.id, now, now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at) VALUES ('lead', 'task', 'company', 'workflow', 'reviewer', 'completed', 1, 'lead-session', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id) VALUES ('actual-execution', 'task', 'company', 'workflow', 1, 1, 'failed', 'task/git-proof', ?, ?, 'session', ?, ?, ?, ?, 'clean', ?)").run(repo.path, "f".repeat(40), now, now, "f".repeat(40), repo.tree, delivery.id);
      db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, result_head, result_tree, developer_execution_id, delivery_artifact_id, updated_at) VALUES ('forward-merge', 'task', 'company', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow', ?, ?, 'actual-execution', ?, ?)").run(repo.base, repo.base, repo.base, repo.commit, repo.tree, now, repo.commit, repo.tree, delivery.id, now);
      db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('review', 'task', 'company', 'workflow', 1, ?, ?, ?, 'lead', 'lead-session', 'approved', 'Approved', ?, ?, 0, ?)").run(repo.base, repo.commit, repo.tree, opinion.id, evidence.id, now);
    });
    const context = createActivityContext(database, config, { githubRelease: createGithubReleasePort() });
    context.release = { publish: async () => ({ releaseId: "release", repository: "acme/forge", branchName: "task/git-proof", baseBranch: "main", headSha: repo.commit, headTree: repo.tree, pullRequest: { number: 1, url: "https://example.test/1", isDraft: true }, reused: false, attempt: 1 }) } as never;
    const publish = await createReleaseActivities(context).publishRelease({ taskId: "task", companyId: "company", workflowId: "workflow", reviewId: "review", developerExecutionId: "phantom-execution", branchName: "task/git-proof", targetBaseSha: repo.base, subjectCommit: repo.commit, subjectTree: repo.tree });
    expect(publish).toMatchObject({ outcome: "completed", headSha: repo.commit });
    await expect(createCiActivities(context).findCiRepairPriorDelivery({ taskId: "task", companyId: "company", workflowId: "workflow", resultCommit: repo.commit })).resolves.toEqual({ developerExecutionId: "actual-execution", developerSessionRef: "session", worktreePath: repo.path });
    await expect(createCiActivities(context).findCiRepairPriorDelivery({ taskId: "task", companyId: "company", workflowId: "workflow", resultCommit: "e".repeat(40) })).resolves.toBeNull();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

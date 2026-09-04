import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivities } from "../src/engine/activities.js";

async function git(root: string, args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test("target-base reconciliation reads the latest completed delivery when state points to a missing execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-target-base-owner-read-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  const database = new ForgeDatabase(config.databasePath);
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Forge Test"]);
    await git(root, ["config", "user.email", "forge@example.test"]);
    await git(root, ["config", "commit.gpgSign", "false"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["remote", "add", "origin", root]);
    await git(root, ["checkout", "-b", "issue/task-1"]);
    await writeFile(join(root, "delivery.txt"), "delivery\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "delivery"]);
    const deliveryHead = await git(root, ["rev-parse", "HEAD"]);
    const deliveryTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
    await git(root, ["checkout", "main"]);
    await writeFile(join(root, "advanced.txt"), "advanced\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "advance base"]);
    const advancedBase = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "issue/task-1"]);

    const now = new Date().toISOString();
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'company-1/brief-1', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'task-key', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state) VALUES ('completed-delivery', 'task-1', 'company-1', 'workflow-1', 1, 1, 'completed', 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean')").run(root, advancedBase, now, now, deliveryHead, deliveryTree);
    });
    const artifacts = new ArtifactStore(config.artifactRoot, database);
    const configuration = await artifacts.putArtifact("company-1", "task-project-configuration", { taskId: "task-1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project-1", projectName: "Project", repositoryPath: root, worktreeRoot: root, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha: advancedBase, targetSha: advancedBase, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "builder" }, capturedAt: now })) });
    database.authQuery((db) => db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-1'").run(configuration.id, now));

    const result = await createActivities(database, config, { githubRelease: { getRemoteRepository: async () => "acme/project", getBranchHead: async () => advancedBase } as never }).reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: configuration.id, checkpoint: "pre_release", developerExecutionId: "phantom-execution", expectedBaseSha: advancedBase, expectedHeadSha: deliveryHead, expectedHeadTree: deliveryTree });

    expect(result).toMatchObject({ outcome: "blocked", code: "merge_state_ownership_mismatch", summary: "The local merge state does not match the recorded reconciliation" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

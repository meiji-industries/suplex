import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { DeveloperEvidenceBuilder, DeveloperEvidenceFailure } from "../src/developer-evidence.js";

const run = promisify(execFile);

test("Developer evidence admits only the exact supplemental review that was available to the final-plan Lead", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-evidence-build-"));
  const repositoryPath = join(root, "repositories", "project_1");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await run("git", ["init", "-b", "main"], { cwd: repositoryPath });
  await run("git", ["config", "user.name", "Forge Test"], { cwd: repositoryPath });
  await run("git", ["config", "user.email", "forge@example.test"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "AGENTS.md"), "Developer instructions\n", "utf8");
  await run("git", ["add", "AGENTS.md"], { cwd: repositoryPath });
  await run("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], { cwd: repositoryPath });
  const config = createTestConfig(root, { repositoryRoot: join(root, "repositories"), worktreeRoot });
  const database = new ForgeDatabase(config.databasePath);
  try {
    const artifacts = new ArtifactStore(config.artifactRoot);
    const brief = await artifacts.put("company_1", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from("Task brief") });
    const supplemental = await artifacts.put("company_1", "supplemental-review", { filename: "review.json", mimeType: "application/json", bytes: Buffer.from('{"summary":"Exact review used by Lead"}') });
    const planValue = { steps: [{ number: 1, verificationCommands: ["pnpm test"] }], developerContext: { includeTaskBrief: false, evidenceArtifactIds: [supplemental.id], imageArtifactIds: [], repositoryInstructionPaths: ["AGENTS.md"], artifactStepNumbers: { [supplemental.id]: [1] } } };
    const plan = await artifacts.put("company_1", "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(planValue)) });
    const now = "2026-08-12T00:00:00.000Z";
    const commitSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'Forge Test', 'forge-test', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company One', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project One', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', 'revision_1', ?, ?)").run(repositoryPath, worktreeRoot, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, state, actor_user_id, created_at) VALUES ('revision_1', 'project_1', 1, 'identity_1', '{}', ?, ?, 'accepted', 'user_1', ?)").run(commitSha, commitSha, now);
      for (const artifact of [brief, supplemental, plan]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', ?, '[]', '{}', 1, 'workflow_1', 'revision_1', 'task-key', ?, ?)").run(brief.id, now, now);
      db.prepare("INSERT INTO forge_issue_governance (task_id, company_id, plan_revision, plan_material, material_categories_json, supplemental_review_used, supplemental_review_artifact_id) VALUES ('task_1', 'company_1', 1, 0, '[]', 1, ?)").run(supplemental.id);
      db.prepare("INSERT INTO forge_plan_authorizations (id, task_id, company_id, project_id, workflow_id, plan_revision, plan_artifact_id, plan_sha256, authorization_kind, approval_decision_id, authorized_at) VALUES ('authorization_1', 'task_1', 'company_1', 'project_1', 'workflow_1', 1, ?, ?, 'routine_auto', NULL, ?)").run(plan.id, plan.sha256, now);
    });
    const subject = { authorizationId: "authorization_1", taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", planRevision: 1, planArtifactId: plan.id, planSha256: plan.sha256, authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: now };
    const builder = new DeveloperEvidenceBuilder(database, config);
    const result = await builder.build({ subject, executionId: "execution_1" });
    const retry = await builder.build({ subject, executionId: "execution_1" });
    expect(retry.manifest).toEqual(result.manifest);
    expect(result.manifest.entries).toContainEqual(expect.objectContaining({ kind: "evidence", artifactId: supplemental.id, planStepNumbers: [1] }));
    expect(result.manifest.entries).toContainEqual(expect.objectContaining({ kind: "repository_instruction", repositoryPath: "AGENTS.md", planStepNumbers: [1] }));
    expect(result.gitPresentation).toEqual({ branchSlug: "task", pullRequestTitle: "Task", pullRequestDescription: "Task." });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("staged Developer evidence is immutable and rejects a mismatched retry directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-evidence-"));
  try {
    await run("git", ["init", "-b", "main"], { cwd: root });
    await run("git", ["config", "user.name", "Forge Test"], { cwd: root });
    await run("git", ["config", "user.email", "forge@example.test"], { cwd: root });
    await (await import("node:fs/promises")).writeFile(join(root, "AGENTS.md"), "verification instructions\n", "utf8");
    await run("git", ["add", "AGENTS.md"], { cwd: root });
    await run("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], { cwd: root });
    const targetSha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const bytes = await readFile(join(root, "AGENTS.md"));
    const manifest = {
      version: 1 as const,
      authorizedPlan: { authorizationId: "authorization_1", taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", planRevision: 1, planArtifactId: "plan_1", planSha256: "a".repeat(64), authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: "2026-08-11T00:00:00.000Z" },
      projectRevision: { projectRevisionId: "revision_1", projectId: "project_1", companyId: "company_1", repositoryIdentity: "acme/forge", repositoryPath: root, worktreeRoot: join(root, "worktrees"), baseBranch: "main", targetBranch: "main", baseSha: targetSha, targetSha, setupVerificationPolicySha256: "b".repeat(64) },
      entries: [{ kind: "repository_instruction" as const, artifactId: null, repositoryPath: "AGENTS.md", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, stagedFilename: "instructions.txt", planStepNumbers: [1] }],
      contradictionRule: "stop_before_unrelated_edits" as const,
      verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }],
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const builder = new DeveloperEvidenceBuilder({} as never, { repositoryRoot: root, worktreeRoot: join(root, "worktrees") } as never);
    const first = await builder.stage(manifest, root, "execution_1");
    expect(await readFile(join(first.directory, "instructions.txt"), "utf8")).toBe("verification instructions\n");
    expect((await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root })).stdout).toBe("");
    await expect(builder.stage(manifest, root, "execution_1")).resolves.toMatchObject({ directory: first.directory });
    await expect(builder.stage({ ...manifest, createdAt: "2026-08-11T00:01:00.000Z" }, root, "execution_1")).rejects.toMatchObject({ code: "evidence-manifest-invalid" } satisfies Partial<DeveloperEvidenceFailure>);
    await builder.cleanup(root, "execution_1");
    await expect(readFile(join(root, ".forge-context", ".gitignore"), "utf8")).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

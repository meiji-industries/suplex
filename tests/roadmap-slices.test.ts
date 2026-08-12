import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { AcceptanceService } from "../src/acceptance.js";
import { AttentionService } from "../src/attention.js";
import { AuthService } from "../src/auth.js";
import { BackupService, checkBackupHealth, reconcileRestoredState } from "../src/backup.js";
import { CapacityManager } from "../src/capacity.js";
import { CiService, type CheckSnapshot } from "../src/ci.js";
import { createHash, randomBytes } from "node:crypto";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ForwardMergeService } from "../src/forward-merge.js";
import { ReleaseService, type GithubPullRequest, type GithubReleasePort } from "../src/github-release.js";
import { ArtifactStore } from "../src/artifacts.js";
import { createActivities } from "../src/temporal/activities.js";

const exec = promisify(execFile);
const now = "2026-08-11T00:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const treeSha = "c".repeat(40);

async function fixture(): Promise<{ root: string; database: ForgeDatabase; config: ReturnType<typeof createTestConfig> }> {
  const root = await mkdtemp(join(tmpdir(), "forge-roadmap-slices-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts"), dataRoot: join(root, "data") });
  await mkdir(config.artifactRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-b', 'Company B', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '[]', '{}', 'active', 'revision-a', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('revision-a', 'project-a', 1, 'identity-a', ?, ?, ?, 'admin', ?)").run(JSON.stringify({ repository: "acme/forge", repositoryPath: join(root, "repo"), worktreeRoot: join(root, "worktrees"), baseBranch: "main", targetBranch: "main", baseSha, targetSha: headSha, requiredChecks: [] }), baseSha, headSha, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'company-a/brief-a', ?)").run("d".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-a', 'company-a', 'project-a', 'Task A', 'brief-a', '[]', '{}', 0, 'workflow-a', 'revision-a', 'task-a-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task-a', 'company-a', 'project-a', 'workflow-a', 1, 'delivery_blocked', 'human', '[\"record_delivery_decision\"]', 'Decision required', ?, 'workflow-a:1')").run(now);
  });
  return { root, database, config };
}

async function rewriteArchive(source: string, destination: string, mutate: (root: string) => Promise<void>): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "forge-backup-mutate-"));
  try {
    await exec("tar", ["-xzf", source, "-C", staging]);
    await mutate(join(staging, "forge-backup"));
    await exec("tar", ["-czf", destination, "-C", staging, "forge-backup"]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function addReleaseFixtures(database: ForgeDatabase, status = "draft"): void {
  database.authTransaction((db) => {
    for (const [id, kind] of [["opinion-a", "agent-opinion"], ["evidence-a", "agent-evidence"]] as const) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company-a', ?, ?, 'text/markdown', 1, ?, ?, ?)").run(id, kind, `${id}.md`, "e".repeat(64), `company-a/${id}`, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('lead-a', 'task-a', 'company-a', 'workflow-a', 'lead', 'completed', 1, 'lead-session', ?)").run(now);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('review-a', 'task-a', 'company-a', 'workflow-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Approved exact delivery', 'opinion-a', 'evidence-a', 0, ?)").run(baseSha, headSha, treeSha, now);
    db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-a', 'task-a', 'company-a', 'workflow-a', 'workflow-a:main:bbbb', 'acme/forge', 'issue/task-a', 'main', ?, ?, ?, ?, 12, 'https://github.com/acme/forge/pull/12', 'Forge task', ?, ?)").run(baseSha, headSha, treeSha, status, now, now);
  });
}

const pullRequest = (overrides: Partial<GithubPullRequest> = {}): GithubPullRequest => ({ number: 12, url: "https://github.com/acme/forge/pull/12", repository: "acme/forge", headBranch: "issue/task-a", baseBranch: "main", headSha, baseSha, isDraft: true, state: "open", mergedAt: null, ...overrides });

function fakeGithub(checks: CheckSnapshot[] = []): GithubReleasePort & { pushed: number; ready: number } {
  return {
    pushed: 0,
    ready: 0,
    async checkAuthentication() {},
    async getRemoteRepository() { return "acme/forge"; },
    async pushNormal() { this.pushed += 1; },
    async listPullRequests() { return []; },
    async createDraftPullRequest() { return pullRequest(); },
    async markReadyForReview() { this.ready += 1; },
    async getPullRequest() { return pullRequest(); },
    async listChecks() { return checks; },
  } as GithubReleasePort & { pushed: number; ready: number };
}

test("capacity is durable, FIFO, bounded, and restart-reconcilable", async () => {
  const value = await fixture();
  try {
    const capacity = new CapacityManager(value.database, { externalTurnCapacity: 1 });
    const first = capacity.request({ companyId: "company-a", taskId: "task-a", workflowId: "workflow-a", turnKind: "lead", requestedAt: "2026-08-11T00:00:00.001Z" });
    const second = capacity.request({ companyId: "company-a", taskId: "task-a", workflowId: "workflow-a", turnKind: "developer", requestedAt: "2026-08-11T00:00:00.002Z" });
    expect(capacity.tryAcquire(first.id).acquired).toBe(true);
    expect(capacity.tryAcquire(second.id).acquired).toBe(false);
    expect(capacity.position(second.id)).toBe(1);
    expect(capacity.release(first.id, "done")).toBe(true);
    expect(capacity.tryAcquire(second.id).acquired).toBe(true);
    expect(capacity.reconcile(new Set(), "worker-restart")).toBe(1);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_capacity_requests WHERE id = ?").get(second.id))).toEqual({ status: "stale" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("attention rebuild is deterministic, scoped, and quiet for ordinary work", async () => {
  const value = await fixture();
  try {
    const auth = new AuthService(value.database, value.config);
    const attention = new AttentionService(value.database, auth);
    const first = attention.list("admin");
    expect(first[0]).toMatchObject({ companyId: "company-a", attentionCount: 1, attention: [expect.objectContaining({ category: "member_decision", taskId: "task-a" })] });
    value.database.authQuery((db) => db.prepare("UPDATE forge_issue_projections SET phase = 'development', allowed_commands_json = '[]' WHERE task_id = 'task-a'").run());
    const rebuilt = attention.list("admin");
    expect(rebuilt.find((company) => company.companyId === "company-a")?.attention).toEqual([]);
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_attention_items WHERE company_id = 'company-a' AND active = 1").get())).toEqual({ count: 0 });
    expect(() => attention.get("admin", "missing-task")).not.toThrow();
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("release publishes one exact reviewed draft and CI accepts only the exact head", async () => {
  const value = await fixture();
  try {
    addReleaseFixtures(value.database);
    const github = fakeGithub();
    const service = new ReleaseService(value.database, new ArtifactStore(value.config.artifactRoot), github);
    const release = await service.publish({ taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", repositoryPath: value.root, repository: "acme/forge", branchName: "issue/task-a", baseBranch: "main", targetBaseSha: baseSha, subjectCommit: headSha, subjectTree: treeSha, reviewId: "review-a", planSummary: "Authorized plan", deliverySummary: "Exact delivery", verificationSummary: "Local checks passed" });
    expect(release.pullRequest.isDraft).toBe(true);
    expect(github.pushed).toBe(1);
    const checks = [{ name: "Tests / unit", headSha, status: "completed" as const, conclusion: "success" as const, summary: "passed" }];
    const ci = new CiService(value.database, { async listChecks() { return checks; } });
    expect((await ci.reconcile({ taskId: "task-a", companyId: "company-a", releaseId: release.releaseId, repository: "acme/forge", expectedHeadSha: headSha, requiredChecks: ["Tests / unit"] })).outcome).toBe("passed");
    expect((await ci.reconcile({ taskId: "task-a", companyId: "company-a", releaseId: release.releaseId, repository: "acme/forge", expectedHeadSha: headSha, requiredChecks: ["Tests / unit", "Browser"] })).outcome).toBe("missing_required");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("acceptance records a decision, changes draft visibility only, and reconciles manual merge truth", async () => {
  const value = await fixture();
  try {
    addReleaseFixtures(value.database);
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_ci_runs (id, task_id, company_id, release_id, expected_head_sha, status, attempt, summary, created_at, updated_at) VALUES ('ci-a', 'task-a', 'company-a', 'release-a', ?, 'passed', 1, 'passed', ?, ?)").run(headSha, now, now));
    const github = fakeGithub();
    const acceptance = new AcceptanceService(value.database, github);
    const result = await acceptance.accept({ taskId: "task-a", companyId: "company-a", releaseId: "release-a", reviewId: "review-a", ciRunId: "ci-a", repository: "acme/forge", baseBranch: "main", headSha, headTree: treeSha, actorUserId: "admin" });
    expect(result.status).toBe("accepted");
    expect(github.ready).toBe(1);
    expect((await acceptance.reconcile({ taskId: "task-a", companyId: "company-a", releaseId: "release-a", repository: "acme/forge", number: 12, expectedHeadSha: headSha, expectedBaseBranch: "main" })).outcome).toBe("open");
    const mergedGithub = { ...github, async getPullRequest() { return pullRequest({ isDraft: false, state: "merged", mergedAt: now }); } };
    expect((await new AcceptanceService(value.database, mergedGithub).reconcile({ taskId: "task-a", companyId: "company-a", releaseId: "release-a", repository: "acme/forge", number: 12, expectedHeadSha: headSha, expectedBaseBranch: "main" })).outcome).toBe("merged");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("backup archive verifies hashes and restores only into a separate clean location", async () => {
  const value = await fixture();
  const restored = join(value.root, "restored");
  const archive = join(value.root, "backup.tar.gz");
  try {
    await mkdir(join(value.config.artifactRoot, "company-a"), { recursive: true });
    await writeFile(join(value.config.artifactRoot, "company-a", "brief-a"), "body");
    value.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET byte_size = 4, sha256 = ? WHERE id = 'brief-a'").run(createHash("sha256").update("body").digest("hex")));
    const service = new BackupService(value.config);
    const created = await service.create({ destination: archive });
    expect(created.manifest.secretsExcluded).toContain("provider tokens");
    expect(created.archiveBytes).toBeGreaterThan(0);
    const verification = await service.verify(archive);
    expect(verification).toMatchObject({ valid: true, errors: [] });
    expect((await checkBackupHealth(value.config)).status).toBe("healthy");
    const restoredResult = await service.restore(archive, restored);
    expect(restoredResult.restoreDurationMs).toBeGreaterThanOrEqual(0);
    expect(await readFile(join(restored, "forge-backup", "config", "config.json"), "utf8")).toContain("requiresReauthentication");
    await expect(service.restore(archive, restored)).rejects.toMatchObject({ code: "exists" });
    await writeFile(join(value.root, "truncated.tar.gz"), "not-an-archive");
    expect((await service.verify(join(value.root, "truncated.tar.gz"))).valid).toBe(false);

    const tampered = join(value.root, "tampered.tar.gz");
    await rewriteArchive(archive, tampered, async (root) => writeFile(join(root, "app", "artifacts", "company-a", "brief-a"), "changed"));
    expect((await service.verify(tampered)).errors).toContain("hash mismatch: app/artifacts/company-a/brief-a");

    const missingComponent = join(value.root, "missing-component.tar.gz");
    await rewriteArchive(archive, missingComponent, async (root) => rm(join(root, "app", "artifacts", "company-a", "brief-a")));
    expect((await service.verify(missingComponent)).errors).toContain("missing entry: app/artifacts/company-a/brief-a");

    const wrongVersion = join(value.root, "wrong-version.tar.gz");
    await rewriteArchive(archive, wrongVersion, async (root) => {
      const manifestPath = join(root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: number };
      manifest.version = 999;
      await writeFile(manifestPath, JSON.stringify(manifest));
    });
    expect((await service.verify(wrongVersion)).errors).toContain("unsupported backup version");

    expect((await service.verify(archive)).valid).toBe(true);
    expect((await checkBackupHealth(value.config)).status).toBe("healthy");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("restore drill preserves users, completed work, artifacts, and draft releases while interrupting in-flight work", async () => {
  const value = await fixture();
  const archive = join(value.root, "restore-drill.tar.gz");
  const restored = join(value.root, "restore-drill");
  try {
    await mkdir(join(value.config.artifactRoot, "company-a"), { recursive: true });
    await writeFile(join(value.config.artifactRoot, "company-a", "brief-a"), "brief body");

    const additionalArtifacts = [
      ["completed-delivery", "developer-delivery", "completed.json", "completed delivery"],
      ["completed-evidence", "agent-evidence", "completed.md", "completed evidence"],
      ["draft-body", "agent-evidence", "draft.md", "draft pull request"],
    ] as const;
    for (const [id, , , content] of additionalArtifacts) {
      await writeFile(join(value.config.artifactRoot, "company-a", id), content);
    }
    value.database.authTransaction((db) => {
      db.prepare("UPDATE forge_artifacts SET byte_size = ?, sha256 = ? WHERE id = 'brief-a'").run(10, createHash("sha256").update("brief body").digest("hex"));
      for (const [id, kind, filename, content] of additionalArtifacts) {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company-a', ?, ?, 'text/plain', ?, ?, ?, ?)").run(id, kind, filename, content.length, createHash("sha256").update(content).digest("hex"), `company-a/${id}`, now);
      }
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('member-a', 'Member A', 'member-a@forge.local', 'member', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('member-a', 'company-a', ?)").run(now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-completed', 'company-a', 'project-a', 'Completed task', 'brief-a', '[]', '{}', 0, 'workflow-completed', 'revision-a', 'task-completed-key', ?, ?)").run(now, now);
      db.prepare("UPDATE forge_issue_projections SET phase = 'development', owner = 'human', allowed_commands_json = '[\"cancel_development\"]', pending_action = 'Developer execution' WHERE task_id = 'task-a'").run();
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task-completed', 'company-a', 'project-a', 'workflow-completed', 4, 'done', 'system', '[]', NULL, ?, 'workflow-completed:4')").run(now);
      for (const [taskId, workflowId, revision, phase, owner, commands, pendingAction] of [
        ["task-a", "workflow-a", 5, "development", "human", ["cancel_development"], "Developer execution"],
        ["task-completed", "workflow-completed", 4, "done", "system", [], null],
      ] as const) {
        db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, 'company-a', ?, ?, ?, ?)").run(taskId, workflowId, revision, JSON.stringify({ taskId, companyId: "company-a", projectId: "project-a", workflowId, revision, phase, owner, allowedCommands: commands, pendingAction, lastEventId: `${workflowId}:${revision}` }), now);
      }
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-completed', 'task-completed', 'company-a', 'workflow-completed', 1, 1, 'completed', 'issue/task-completed', '/worktrees/task-completed', ?, 'completed-session', ?, ?, ?, ?, 'clean', 'completed-delivery', 'completed-evidence')").run(baseSha, now, now, headSha, treeSha);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, heartbeat_at) VALUES ('developer-in-flight', 'task-a', 'company-a', 'workflow-a', 1, 1, 'running', 'issue/task-a', '/worktrees/task-a', ?, 'in-flight-session', ?, ?)").run(baseSha, now, now);
      db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, body_artifact_id, created_at, updated_at) VALUES ('release-drill', 'task-a', 'company-a', 'workflow-a', 'workflow-a:release-drill', 'acme/forge', 'issue/task-a', 'main', ?, ?, ?, 'draft', 42, 'https://github.com/acme/forge/pull/42', 'Restore drill draft', 'draft-body', ?, ?)").run(baseSha, headSha, treeSha, now, now);
      db.prepare("INSERT INTO forge_invitations (id, token_hash, kind, display_name, user_id, expires_at, created_at) VALUES ('invite-a', 'invitation-hash', 'user', 'Member A', 'member-a', '2099-01-01T00:00:00.000Z', ?)").run(now);
      db.prepare("INSERT INTO forge_challenges (id, challenge, kind, invitation_id, user_id, expires_at, created_at) VALUES ('challenge-a', 'challenge', 'user', 'invite-a', 'member-a', '2099-01-01T00:00:00.000Z', ?)").run(now);
      db.prepare("INSERT INTO forge_credentials (id, user_id, credential_id, public_key, counter, transports, created_at) VALUES ('credential-a', 'member-a', 'credential-id', ?, 0, '[]', ?)").run(Buffer.from("public-key"), now);
      db.prepare("INSERT INTO forge_sessions (id, token_hash, user_id, expires_at, created_at) VALUES ('session-a', 'session-hash', 'member-a', '2099-01-01T00:00:00.000Z', ?)").run(now);
    });

    const service = new BackupService(value.config);
    const created = await service.create({ destination: archive });
    expect(created.archiveBytes).toBe((await stat(archive)).size);
    expect(created.durationMs).toBeGreaterThanOrEqual(0);
    const restoredResult = await service.restore(archive, restored);
    expect(restoredResult.restoreDurationMs).toBeGreaterThanOrEqual(0);

    const restoredDatabase = new ForgeDatabase(join(restored, "forge-backup", "app", "forge.sqlite"));
    try {
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_users").get())).toEqual({ count: 2 });
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_projects").get())).toEqual({ count: 1 });
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks").get())).toEqual({ count: 2 });
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_credentials WHERE revoked_at IS NULL").get())).toEqual({ count: 0 });
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_sessions WHERE revoked_at IS NULL").get())).toEqual({ count: 0 });
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_invitations").get())).toEqual({ count: 0 });

      restoredDatabase.authTransaction((db) => {
        db.prepare("DELETE FROM forge_issue_projections").run();
        db.prepare("DELETE FROM forge_attention_items").run();
      });
      expect(restoredDatabase.rebuildIssueProjections()).toBe(2);
      expect(new AttentionService(restoredDatabase, new AuthService(restoredDatabase, value.config)).rebuildAll()).toBe(2);
      new CapacityManager(restoredDatabase, value.config).reconcileFromLedgers();

      let providerReads = 0;
      let providerMutations = 0;
      const reconciliation = await reconcileRestoredState(restoredDatabase, {
        async checkAuthentication() { providerMutations += 1; },
        async getRemoteRepository() { return "acme/forge"; },
        async getBranchHead() { providerReads += 1; return headSha; },
        async pushNormal() { providerMutations += 1; },
        async listPullRequests() { providerMutations += 1; return []; },
        async createDraftPullRequest() { providerMutations += 1; return pullRequest({ number: 42, headSha, baseSha }); },
        async getPullRequest() { providerReads += 1; return pullRequest({ number: 42, headSha, baseSha }); },
      });
      expect(reconciliation.developerExecutions).toEqual([{ executionId: "developer-in-flight", status: "interrupted", reason: "restore-invalidated-process-ownership" }]);
      expect(reconciliation.providers).toEqual([expect.objectContaining({ releaseId: "release-drill", status: "matched", pullRequestNumber: 42 })]);
      expect(providerReads).toBe(2);
      expect(providerMutations).toBe(0);
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_developer_executions WHERE id = 'developer-in-flight'").get())).toEqual({ status: "interrupted", failure_code: "restore-process-invalidated" });
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT task_id, phase FROM forge_issue_projections ORDER BY task_id").all())).toEqual([{ task_id: "task-a", phase: "development" }, { task_id: "task-completed", phase: "done" }]);
    } finally {
      restoredDatabase.close();
    }
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("restored provider reconciliation observes existing pull requests without mutating them", async () => {
  const value = await fixture();
  try {
    addReleaseFixtures(value.database);
    const report = await reconcileRestoredState(value.database, fakeGithub());
    expect(report.providers).toEqual([expect.objectContaining({ releaseId: "release-a", status: "matched", pullRequestNumber: 12 })]);
    expect(value.database.authQuery((db) => db.prepare("SELECT kind, status FROM forge_provider_operations WHERE task_id = 'task-a' AND kind = 'restore-reconcile'").get())).toEqual({ kind: "restore-reconcile", status: "matched" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("forward merge updates an issue branch only through a normal non-rewriting merge", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-forward-merge-"));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "forge@example.test"], { cwd: root });
    await exec("git", ["config", "user.name", "Forge Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "base"], { cwd: root });
    const oldBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "-b", "issue/task-a"], { cwd: root });
    await writeFile(join(root, "issue.txt"), "issue\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "issue"], { cwd: root });
    const issueHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "main"], { cwd: root }); await writeFile(join(root, "base.txt"), "base updated\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "base-update"], { cwd: root });
    const newBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "issue/task-a"], { cwd: root });
    const result = await new ForwardMergeService().reconcile({ worktreePath: root, expectedBaseSha: oldBase, currentBaseSha: newBase, branchName: "issue/task-a", repositoryPath: root });
    expect(result.status).toBe("merged");
    expect(result.priorHead).toBe(issueHead);
    expect(result.mergeCommit).not.toBe(issueHead);
    expect((await exec("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forward merge leaves a guarded conflict for Lead planning instead of rewriting the issue branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-forward-merge-conflict-"));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "forge@example.test"], { cwd: root });
    await exec("git", ["config", "user.name", "Forge Test"], { cwd: root });
    await writeFile(join(root, "shared.txt"), "base\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "base"], { cwd: root });
    const oldBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "-b", "issue/task-conflict"], { cwd: root });
    await writeFile(join(root, "shared.txt"), "issue side\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "issue"], { cwd: root });
    const priorHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "main"], { cwd: root }); await writeFile(join(root, "shared.txt"), "base side\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "base-update"], { cwd: root });
    const targetBaseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "issue/task-conflict"], { cwd: root });
    const result = await new ForwardMergeService().reconcile({ worktreePath: root, expectedBaseSha: oldBase, currentBaseSha: targetBaseSha, branchName: "issue/task-conflict", repositoryPath: root });
    expect(result).toMatchObject({ status: "conflict", priorHead, targetBaseSha, conflictFiles: ["shared.txt"] });
    expect(result.conflictDiff).toContain("shared.txt");
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(priorHead);
    expect((await exec("git", ["status", "--porcelain"], { cwd: root })).stdout).toContain("UU shared.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("merge-conflict evidence stays in a verified company artifact before Lead planning", async () => {
  const value = await fixture();
  try {
    const priorHead = "1".repeat(40);
    const targetBaseSha = "2".repeat(40);
    const combinedDiff = `diff --git a/shared.txt b/shared.txt\n${"x".repeat(80 * 1024)}`;
    const artifacts = new ArtifactStore(value.config.artifactRoot);
    const stored = await artifacts.put("company-a", "merge-conflict-evidence", {
      filename: "conflict.json",
      mimeType: "application/json",
      bytes: Buffer.from(JSON.stringify({ version: 1, priorHead, targetBaseSha, conflictFiles: ["shared.txt"], combinedDiff })),
    });
    value.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(stored.id, stored.companyId, stored.kind, stored.filename, stored.mimeType, stored.byteSize, stored.sha256, stored.storagePath, stored.createdAt);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state) VALUES ('developer-conflict', 'task-a', 'company-a', 'workflow-a', 1, 1, 'completed', 'issue/task-a', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean')").run(value.root, targetBaseSha, now, now, priorHead, treeSha);
    });
    const reference = { artifactId: stored.id, companyId: stored.companyId, kind: "merge-conflict-evidence" as const, sha256: stored.sha256, byteSize: stored.byteSize, mimeType: stored.mimeType };
    let receivedDiff = "";
    let planningCalls = 0;
    const activities = createActivities(value.database, value.config, { agent: { async planMergeConflict(input) {
      planningCalls += 1;
      receivedDiff = input.conflictDiff;
      return { planId: "plan-conflict", planArtifactId: "plan-artifact", evidenceArtifactId: "plan-evidence", leadExecutionId: "lead-execution", leadSessionRef: input.leadSessionRef, summary: "Verified conflict plan" };
    } } });
    const input = { taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", projectId: "project-a", projectRevisionId: "revision-a", briefArtifactId: "brief-a", planRevision: 1, leadSessionRef: "lead-session", leadOutputArtifactId: "lead-plan", conflictEvidence: reference, branchName: "issue/task-a", priorHead, targetBaseSha };
    await expect(activities.planMergeConflict(input)).resolves.toMatchObject({ planId: "plan-conflict" });
    expect(receivedDiff).toBe(combinedDiff);
    expect(planningCalls).toBe(1);
    for (const invalid of [
      { ...reference, companyId: "company-b" },
      { ...reference, kind: "delivery-review" as const },
      { ...reference, sha256: "f".repeat(64) },
      { ...reference, byteSize: reference.byteSize + 1 },
      { ...reference, mimeType: "text/plain" },
      { ...reference, artifactId: "missing-artifact" },
    ]) {
      await expect(activities.planMergeConflict({ ...input, conflictEvidence: invalid })).rejects.toThrow(/artifact/i);
    }
    expect(planningCalls).toBe(1);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("forward merge reports no drift without mutating the issue branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-forward-merge-no-drift-"));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "forge@example.test"], { cwd: root });
    await exec("git", ["config", "user.name", "Forge Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "base"], { cwd: root });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "-b", "issue/task-a"], { cwd: root });
    await writeFile(join(root, "issue.txt"), "issue\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "issue"], { cwd: root });
    const issueHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const service = new ForwardMergeService();
    const first = await service.reconcile({ worktreePath: root, expectedBaseSha: base, currentBaseSha: base, branchName: "issue/task-a", repositoryPath: root });
    expect(first).toMatchObject({ status: "no_drift", priorHead: issueHead, targetBaseSha: base, mergeCommit: null, tree: null, conflictFiles: [] });
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(issueHead);
    expect((await exec("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe("");
    const second = await service.reconcile({ worktreePath: root, expectedBaseSha: base, currentBaseSha: base, branchName: "issue/task-a", repositoryPath: root });
    expect(second).toMatchObject({ status: "no_drift", priorHead: issueHead, targetBaseSha: base });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forward merge rejects a non-descendant target base instead of rewriting history", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-forward-merge-orphan-"));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "forge@example.test"], { cwd: root });
    await exec("git", ["config", "user.name", "Forge Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "base"], { cwd: root });
    const oldBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "-b", "issue/task-a"], { cwd: root });
    await writeFile(join(root, "issue.txt"), "issue\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "issue"], { cwd: root });
    const issueHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "--orphan", "replaced-main"], { cwd: root });
    await writeFile(join(root, "base.txt"), "replaced\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "replaced base"], { cwd: root });
    const alienBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "issue/task-a"], { cwd: root });
    await expect(new ForwardMergeService().reconcile({ worktreePath: root, expectedBaseSha: oldBase, currentBaseSha: alienBase, branchName: "issue/task-a", repositoryPath: root })).rejects.toMatchObject({ code: "not-ancestor" });
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(issueHead);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forward merge records the merge evidence in the database", async () => {
  const value = await fixture();
  const repoPath = join(value.root, "repo");
  await mkdir(repoPath, { recursive: true });
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repoPath });
    await exec("git", ["config", "user.email", "forge@example.test"], { cwd: repoPath });
    await exec("git", ["config", "user.name", "Forge Test"], { cwd: repoPath });
    await writeFile(join(repoPath, "base.txt"), "base\n"); await exec("git", ["add", "."], { cwd: repoPath }); await exec("git", ["commit", "-m", "base"], { cwd: repoPath });
    const oldBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await exec("git", ["checkout", "-b", "issue/task-a"], { cwd: repoPath });
    await writeFile(join(repoPath, "issue.txt"), "issue\n"); await exec("git", ["add", "."], { cwd: repoPath }); await exec("git", ["commit", "-m", "issue"], { cwd: repoPath });
    const priorHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await exec("git", ["checkout", "main"], { cwd: repoPath }); await writeFile(join(repoPath, "base.txt"), "base updated\n"); await exec("git", ["add", "."], { cwd: repoPath }); await exec("git", ["commit", "-m", "base-update"], { cwd: repoPath });
    const newBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await exec("git", ["checkout", "issue/task-a"], { cwd: repoPath });
    const service = new ForwardMergeService(value.database);
    const result = await service.reconcile({ worktreePath: repoPath, expectedBaseSha: oldBase, currentBaseSha: newBase, branchName: "issue/task-a", repositoryPath: repoPath, taskId: "task-a", companyId: "company-a" });
    expect(result.status).toBe("merged");
    const row = value.database.authQuery((db) => db.prepare("SELECT expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json FROM forge_forward_merges WHERE task_id = 'task-a'").get()) as { expected_base_sha: string; current_base_sha: string; prior_head: string; merge_commit: string; tree: string; status: string; conflict_files_json: string };
    expect(row).toMatchObject({ expected_base_sha: oldBase, current_base_sha: newBase, prior_head: priorHead, merge_commit: result.mergeCommit, tree: result.tree, status: "merged", conflict_files_json: "[]" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("forward merge no-drift ledger is idempotent across repeated checks", async () => {
  const value = await fixture();
  const repoPath = join(value.root, "repo");
  await mkdir(repoPath, { recursive: true });
  try {
    await exec("git", ["init", "-b", "main"], { cwd: repoPath });
    await exec("git", ["config", "user.email", "forge@example.test"], { cwd: repoPath });
    await exec("git", ["config", "user.name", "Forge Test"], { cwd: repoPath });
    await writeFile(join(repoPath, "base.txt"), "base\n"); await exec("git", ["add", "."], { cwd: repoPath }); await exec("git", ["commit", "-m", "base"], { cwd: repoPath });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    const service = new ForwardMergeService(value.database);
    const first = await service.reconcile({ worktreePath: repoPath, expectedBaseSha: base, currentBaseSha: base, branchName: "main", repositoryPath: repoPath, taskId: "task-a", companyId: "company-a" });
    const second = await service.reconcile({ worktreePath: repoPath, expectedBaseSha: base, currentBaseSha: base, branchName: "main", repositoryPath: repoPath, taskId: "task-a", companyId: "company-a" });
    expect(first.status).toBe("no_drift");
    expect(second.status).toBe("no_drift");
    expect(first.forwardMergeId).toBe(second.forwardMergeId);
    const count = value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_forward_merges WHERE task_id = 'task-a' AND status = 'no_drift'").get()) as { count: number };
    expect(count.count).toBe(1);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("forward merge in one worktree does not disturb another active worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-forward-merge-isolation-"));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "forge@example.test"], { cwd: root });
    await exec("git", ["config", "user.name", "Forge Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "base"], { cwd: root });
    const oldBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const worktreeA = join(root, "worktrees", "a");
    const worktreeB = join(root, "worktrees", "b");
    await mkdir(worktreeA, { recursive: true });
    await mkdir(worktreeB, { recursive: true });
    await exec("git", ["worktree", "add", "-b", "issue/task-a", worktreeA, "main"], { cwd: root });
    await exec("git", ["worktree", "add", "-b", "issue/task-b", worktreeB, "main"], { cwd: root });
    await writeFile(join(worktreeA, "a.txt"), "a\n"); await exec("git", ["add", "a.txt"], { cwd: worktreeA }); await exec("git", ["-c", "user.name=Forge Test", "-c", "user.email=forge@example.test", "commit", "-m", "a"], { cwd: worktreeA });
    await writeFile(join(worktreeB, "b.txt"), "b\n"); await exec("git", ["add", "b.txt"], { cwd: worktreeB }); await exec("git", ["-c", "user.name=Forge Test", "-c", "user.email=forge@example.test", "commit", "-m", "b"], { cwd: worktreeB });
    const headA = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktreeA })).stdout.trim();
    const headB = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktreeB })).stdout.trim();
    await exec("git", ["checkout", "main"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base updated\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "base-update"], { cwd: root });
    const newBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await exec("git", ["checkout", "issue/task-a"], { cwd: worktreeA });
    const result = await new ForwardMergeService().reconcile({ worktreePath: worktreeA, expectedBaseSha: oldBase, currentBaseSha: newBase, branchName: "issue/task-a", repositoryPath: root });
    expect(result.status).toBe("merged");
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: worktreeB })).stdout.trim()).toBe(headB);
    expect((await exec("git", ["status", "--porcelain"], { cwd: worktreeB })).stdout).toBe("");
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: worktreeA })).stdout.trim()).not.toBe(headA);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRelease detects base drift, forward merges, and revalidates through a new draft", async () => {
  const value = await fixture();
  try {
  const repo = join(value.root, "repo");
  await mkdir(repo, { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "forge@example.test"], { cwd: repo });
  await exec("git", ["config", "user.name", "Forge Test"], { cwd: repo });
  await writeFile(join(repo, "shared.txt"), "base\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const oldBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await exec("git", ["checkout", "-b", "issue/task-a"], { cwd: repo });
  await writeFile(join(repo, "feature.txt"), "feature\n");
  await exec("git", ["add", "feature.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "feature"], { cwd: repo });
  const oldHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const oldTree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo })).stdout.trim();
  await exec("git", ["checkout", "main"], { cwd: repo });
  await writeFile(join(repo, "shared.txt"), "base updated\n");
  await exec("git", ["add", "shared.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "base-update"], { cwd: repo });
  const newBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await exec("git", ["checkout", "issue/task-a"], { cwd: repo });

  const artifactId = (kind: string) => `artifact_${randomBytes(8).toString("hex")}_${kind}`;
  const leadEvidenceId = artifactId("lead-evidence");
  const deliveryId = artifactId("delivery");
  const developerEvidenceId = artifactId("developer-evidence");
  const opinionId = artifactId("opinion");
  const reviewId = artifactId("review");

  value.database.authTransaction((db) => {
    for (const [id, kind, filename] of [[leadEvidenceId, "agent-evidence", "lead.md"], [deliveryId, "developer-delivery", "delivery.json"], [developerEvidenceId, "agent-evidence", "developer.md"], [opinionId, "agent-opinion", "opinion.md"]] as const) {
      db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company-a', ?, ?, 'text/markdown', 1, ?, ?, ?)").run(id, kind, filename, "e".repeat(64), `company-a/${id}`, now);
    }
    db.prepare("INSERT OR REPLACE INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('lead-a', 'task-a', 'company-a', 'workflow-a', 'lead', 'completed', 1, 'lead-session', ?, ?, ?)").run(now, now, leadEvidenceId);
    db.prepare("UPDATE forge_projects SET repository_identity = 'acme/forge' WHERE id = 'project-a'").run();
    db.prepare("INSERT OR REPLACE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, heartbeat_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-a', 'task-a', 'company-a', 'workflow-a', 1, 1, 'completed', 'issue/task-a', ?, ?, 'developer-session', ?, ?, ?, ?, ?, 'clean', ?, ?)").run(repo, oldBase, now, now, now, oldHead, oldTree, deliveryId, developerEvidenceId);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES (?, 'task-a', 'company-a', 'workflow-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Approved exact delivery', ?, ?, 0, ?)").run(reviewId, oldBase, oldHead, oldTree, opinionId, leadEvidenceId, now);
  });

  const github: GithubReleasePort & { pushed: number; created: GithubPullRequest[]; nextHead: string; nextBase: string } = {
    pushed: 0,
    created: [],
    nextHead: oldHead,
    nextBase: oldBase,
    async checkAuthentication() {},
    async getRemoteRepository() { return "acme/forge"; },
    async getBranchHead() { return this.nextBase; },
    async pushNormal() { this.pushed += 1; },
    async listPullRequests() { return this.created; },
    async createDraftPullRequest(input) { const pr: GithubPullRequest = { number: this.created.length + 1, url: `https://github.com/${input.repository}/pull/${this.created.length + 1}`, repository: input.repository, headBranch: input.headBranch, baseBranch: input.baseBranch, headSha: this.nextHead, baseSha: this.nextBase, isDraft: true, state: "open", mergedAt: null }; this.created.push(pr); return pr; },
    async markReadyForReview() {},
    async getPullRequest(input) { return this.created.find((pr) => pr.number === input.number) ?? this.created[0]!; },
  };

  const activities = createActivities(value.database, value.config, { githubRelease: github });
  github.nextBase = newBase;
  const drift = await activities.publishRelease({ taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", reviewId, developerExecutionId: "developer-a", branchName: "issue/task-a", targetBaseSha: oldBase, subjectCommit: oldHead, subjectTree: oldTree, planSummary: "Authorized plan", deliverySummary: "Exact delivery", verificationSummary: "Local checks passed" });
  expect(drift.baseDriftMerged).toBe(true);
  expect(drift.priorHead).toBe(oldHead);
  expect(drift.targetBaseSha).toBe(newBase);
  expect(drift.headSha).toBeTruthy();
  expect(drift.headTree).toBeTruthy();
  expect(drift.forwardMergeId).toBeTruthy();

  const mergeHead = drift.headSha!;
  const mergeTree = drift.headTree!;

  const mergeReviewId = artifactId("review");
  value.database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES (?, 'task-a', 'company-a', 'workflow-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Approved merged delivery', ?, ?, 0, ?)").run(mergeReviewId, newBase, mergeHead, mergeTree, opinionId, leadEvidenceId, now);
  });

  github.nextHead = mergeHead;
  github.nextBase = newBase;
  const release = await activities.publishRelease({ taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", reviewId: mergeReviewId, developerExecutionId: "developer-a", branchName: "issue/task-a", targetBaseSha: newBase, subjectCommit: mergeHead, subjectTree: mergeTree, planSummary: "Authorized plan", deliverySummary: "Exact delivery after revalidation", verificationSummary: "Local checks passed" });
  expect(release.pullRequestNumber).toBeGreaterThan(0);
  expect(release.isDraft).toBe(true);
  expect(github.pushed).toBe(1);
  expect(release.headSha).toBe(mergeHead);
  expect(release.headTree).toBe(mergeTree);
  expect(release.targetBaseSha).toBe(newBase);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

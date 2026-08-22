import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { AttentionService } from "../src/attention.js";
import { AuthService } from "../src/auth.js";
import { BackupService, checkBackupHealth, reconcileRestoredState } from "../src/backup.js";
import { CapacityManager } from "../src/capacity.js";
import { createHash } from "node:crypto";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ForwardMergeService } from "../src/forward-merge.js";
import { GithubReleaseFailure, ReleaseService, type GithubAcceptancePort, type GithubPullRequest, type GithubReleasePort } from "../src/github-release.js";
import { ArtifactStore } from "../src/artifacts.js";
import { jsonRequired } from "../src/task-utils.js";

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
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'company-a/brief-a', ?)").run("d".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-a', 'company-a', 'project-a', 'Task A', 'brief-a', '[]', '{}', 0, 'workflow-a', 'revision-a', 'task-a-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task-a', 'company-a', 'project-a', 'workflow-a', 1, 'delivery_blocked', 'human', '[\"record_delivery_decision\"]', 'Decision required', ?, 'workflow-a:1')").run(now);
  });
  const configuration = await new ArtifactStore(config.artifactRoot, database).putArtifact("company-a", "task-project-configuration", {
    filename: "project-configuration-task-a.json", mimeType: "application/json", taskId: "task-a",
    bytes: Buffer.from(JSON.stringify({
      projectId: "project-a", projectName: "Project A", repositoryPath: join(root, "repo"), worktreeRoot: join(root, "worktrees"),
      repository: "acme/forge", baseBranch: "main", targetBranch: "main", baseSha, targetSha: headSha,
      setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: [],
      roleAgents: { builder: "builder-a" }, roleProfiles: { builder: "builder-a" }, capturedAt: now,
    }), "utf8"),
  });
  database.authQuery((db) => db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-a'").run(configuration.id, now));
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
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('lead-a', 'task-a', 'company-a', 'workflow-a', 'planner', 'completed', 1, 'lead-session', ?)").run(now);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('review-a', 'task-a', 'company-a', 'workflow-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Approved exact delivery', 'opinion-a', 'evidence-a', 0, ?)").run(baseSha, headSha, treeSha, now);
    db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-a', 'task-a', 'company-a', 'workflow-a', 'workflow-a:main:bbbb', 'acme/forge', 'issue/task-a', 'main', ?, ?, ?, ?, 12, 'https://github.com/acme/forge/pull/12', 'Forge task', ?, ?)").run(baseSha, headSha, treeSha, status, now, now);
  });
}

const pullRequest = (overrides: Partial<GithubPullRequest> = {}): GithubPullRequest => ({ number: 12, url: "https://github.com/acme/forge/pull/12", repository: "acme/forge", headBranch: "issue/task-a", baseBranch: "main", headSha, baseSha, isDraft: true, state: "open", mergedAt: null, ...overrides });

function fakeGithub(): GithubReleasePort & GithubAcceptancePort & { authenticated: number; pushed: number; ready: number; updated: number; createdInput: { title: string; body: string } | null } {
  return {
    authenticated: 0,
    pushed: 0,
    ready: 0,
    updated: 0,
    createdInput: null,
    async checkAuthentication() { this.authenticated += 1; },
    async getRemoteRepository() { return "acme/forge"; },
    async getBranchHead(input) { return input.branch === "main" ? baseSha : this.pushed ? headSha : null; },
    async inspectLocalRevision() { return { branch: "issue/task-a", headSha, treeSha, clean: true }; },
    async pushNormal() { this.pushed += 1; },
    async listPullRequests() { return []; },
    async createDraftPullRequest(input) { this.createdInput = { title: input.title, body: input.body }; return pullRequest(); },
    async updateDraftPullRequest() { this.updated += 1; return pullRequest(); },
    async markReadyForReview() { this.ready += 1; },
    async getPullRequest() { return this.ready ? pullRequest({ isDraft: false }) : pullRequest(); },
    async listChecks() { return []; },
  } as GithubReleasePort & GithubAcceptancePort & { authenticated: number; pushed: number; ready: number; updated: number; createdInput: { title: string; body: string } | null };
}


test("attention is quiet for ordinary projected work", async () => {
  const value = await fixture();
  try {
    const attention = new AttentionService(value.database, new AuthService(value.database, value.config));
    expect(attention.list("admin")[0]).toMatchObject({ companyId: "company-a", attentionCount: 1, attention: [expect.objectContaining({ taskId: "task-a" })] });
    value.database.authQuery((db) => db.prepare("UPDATE forge_issue_projections SET phase = 'development', owner = 'lead', allowed_commands_json = '[]' WHERE task_id = 'task-a'").run());
    expect(attention.list("admin").find((company) => company.companyId === "company-a")?.attention).toEqual([]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("release adopts an existing open pull request for the branch identity", async () => {
  const value = await fixture();
  try {
    addReleaseFixtures(value.database);
    const github = fakeGithub();
    github.listPullRequests = async () => [pullRequest(), pullRequest({ number: 13, url: "https://github.com/acme/forge/pull/13", isDraft: false })];
    const service = new ReleaseService(value.database, new ArtifactStore(value.config.artifactRoot), github);
    const release = await service.publish({ taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", coordinates: { projectRevisionId: "revision-a", repositoryPath: value.root, worktreePath: value.root, repository: "acme/forge", owner: "acme", headBranch: "issue/task-a", baseBranch: "main", expectedBaseSha: baseSha }, reviewedRevision: { reviewId: "review-a", developerExecutionId: "developer-a", commitSha: headSha, treeSha }, taskTitle: "Task A", delivery: {} });
    expect(release).toMatchObject({ reused: true, pullRequest: { number: 12, isDraft: true } });
    expect(github.createdInput).toBeNull();
    expect(github.updated).toBe(0);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("release publishes a verification body containing a commit SHA and local path", async () => {
  const value = await fixture();
  try {
    addReleaseFixtures(value.database);
    const github = fakeGithub();
    const service = new ReleaseService(value.database, new ArtifactStore(value.config.artifactRoot), github);
    const release = await service.publish({
      taskId: "task-a", companyId: "company-a", workflowId: "workflow-a",
      coordinates: { projectRevisionId: "revision-a", repositoryPath: value.root, worktreePath: value.root, repository: "acme/forge", owner: "acme", headBranch: "issue/task-a", baseBranch: "main", expectedBaseSha: baseSha },
      reviewedRevision: { reviewId: "review-a", developerExecutionId: "developer-a", commitSha: headSha, treeSha },
      taskTitle: "Task A",
      delivery: { commandsRun: [`git show ${headSha} /Users/dev/code/forge/src/github-release.ts`] },
    });
    expect(release.pullRequest.number).toBe(12);
    expect(github.createdInput?.body).toContain(headSha);
    expect(github.createdInput?.body).toContain("/Users/dev/code/forge/src/github-release.ts");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("release reconciles push and create timeouts after success without duplicate mutations", async () => {
  const value = await fixture();
  try {
    addReleaseFixtures(value.database);
    let remoteHead: string | null = null;
    let created: GithubPullRequest | undefined;
    let pushes = 0;
    let creates = 0;
    let updates = 0;
    const github: GithubReleasePort = {
      async checkAuthentication() {},
      async getRemoteRepository() { return "acme/forge"; },
      async getBranchHead(input) { return input.branch === "main" ? baseSha : remoteHead; },
      async inspectLocalRevision() { return { branch: "issue/task-a", headSha, treeSha, clean: true }; },
      async pushNormal() { pushes += 1; remoteHead = headSha; throw new GithubReleaseFailure("provider-unavailable", "push response lost"); },
      async listPullRequests() { return created ? [created] : []; },
      async createDraftPullRequest() { creates += 1; created = pullRequest(); throw new GithubReleaseFailure("provider-unavailable", "create response lost"); },
      async updateDraftPullRequest() { updates += 1; return created!; },
      async getPullRequest() { return created!; },
    };
    const service = new ReleaseService(value.database, new ArtifactStore(value.config.artifactRoot), github);
    const input = { taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", coordinates: { projectRevisionId: "revision-a", repositoryPath: value.root, worktreePath: value.root, repository: "acme/forge", owner: "acme", headBranch: "issue/task-a", baseBranch: "main", expectedBaseSha: baseSha }, reviewedRevision: { reviewId: "review-a", developerExecutionId: "developer-a", commitSha: headSha, treeSha }, taskTitle: "Task A", delivery: {} };
    const first = await service.publish(input);
    const second = await service.publish(input);
    expect(second).toMatchObject({ releaseId: first.releaseId, reused: true, attempt: 1, pullRequest: { number: first.pullRequest.number } });
    expect({ pushes, creates, updates }).toEqual({ pushes: 1, creates: 1, updates: 0 });
    expect(value.database.authQuery((db) => db.prepare("SELECT kind, status, attempt FROM forge_provider_operations WHERE release_key = (SELECT release_key FROM forge_releases WHERE id = ?) ORDER BY kind").all(first.releaseId))).toEqual([{ kind: "create-draft-pr", status: "completed", attempt: 1 }, { kind: "push", status: "completed", attempt: 1 }]);
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
      const manifest = jsonRequired(await readFile(manifestPath, "utf8")) as { version: number };
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
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-completed', 'company-a', 'project-a', 'Completed task', 'brief-a', '[]', '{}', 0, 'workflow-completed', 'revision-a', 'task-completed-key', ?, ?)").run(now, now);
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
      db.prepare("INSERT INTO forge_agents (id, kind, name, avatar_seed, created_at, updated_at) VALUES ('external-agent-a', 'hermes', 'Hermes A', 'hermes-a', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_external_agents (id, company_id, hermes_profile_id, status, paired_at, created_at, updated_at) VALUES ('external-agent-a', 'company-a', 'profile-a', 'paired', ?, ?, ?)").run(now, now, now);
      db.prepare("INSERT INTO forge_hermes_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES ('pairing-a', 'external-agent-a', 'pairing-hash', 'rotation', '2099-01-01T00:00:00.000Z', ?)").run(now);
      db.prepare("INSERT INTO forge_external_agent_credentials (id, agent_id, credential_hash, created_at) VALUES ('external-credential-a', 'external-agent-a', 'external-credential-hash', ?)").run(now);
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
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_hermes_pairing_codes").get())).toEqual({ count: 0 });
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_external_agent_credentials").get())).toEqual({ count: 0 });

      new CapacityManager(restoredDatabase, value.config).reconcileFromLedgers();

      let providerReads = 0;
      let providerMutations = 0;
      const reconciliation = await reconcileRestoredState(restoredDatabase, {
        async checkAuthentication() { providerMutations += 1; },
        async getRemoteRepository() { return "acme/forge"; },
        async getBranchHead() { providerReads += 1; return headSha; },
        async inspectLocalRevision() { return { branch: "issue/task-a", headSha, treeSha, clean: true }; },
        async pushNormal() { providerMutations += 1; },
        async listPullRequests() { providerMutations += 1; return []; },
        async createDraftPullRequest() { providerMutations += 1; return pullRequest({ number: 42, headSha, baseSha }); },
        async updateDraftPullRequest() { providerMutations += 1; return pullRequest({ number: 42, headSha, baseSha }); },
        async getPullRequest() { providerReads += 1; return pullRequest({ number: 42, headSha, baseSha }); },
      });
      expect(reconciliation.developerExecutions).toEqual([{ executionId: "developer-in-flight", status: "failed", reason: "process-missing" }]);
      expect(reconciliation.providers).toEqual([expect.objectContaining({ releaseId: "release-drill", status: "matched", pullRequestNumber: 42 })]);
      expect(providerReads).toBe(2);
      expect(providerMutations).toBe(0);
      expect(restoredDatabase.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_developer_executions WHERE id = 'developer-in-flight'").get())).toEqual({ status: "failed", failure_code: "developer-process-missing" });
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

test("verification-only retry revalidates the recorded merge without another merge", async () => {
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
    const targetBaseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await exec("git", ["checkout", "issue/task-a"], { cwd: repoPath });
    const service = new ForwardMergeService(value.database);
    const merged = await service.reconcile({ worktreePath: repoPath, expectedBaseSha: oldBase, expectedHeadSha: priorHead, branchName: "issue/task-a", repositoryPath: repoPath, currentBaseSha: targetBaseSha, taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", projectRevisionId: "revision-a", checkpoint: "pre_release", developerExecutionId: "developer-a" });
    const retry = await service.revalidateMergedOperation({ forwardMergeId: merged.forwardMergeId!, worktreePath: repoPath, repositoryPath: repoPath, branchName: "issue/task-a", expectedBaseSha: oldBase, expectedHeadSha: merged.mergeCommit!, expectedHeadTree: merged.tree!, taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", projectRevisionId: "revision-a", checkpoint: "pre_release", developerExecutionId: "developer-a" });
    expect(retry).toMatchObject({ status: "merged", forwardMergeId: merged.forwardMergeId, priorHead, targetBaseSha, mergeCommit: merged.mergeCommit, tree: merged.tree });
    await expect(service.revalidateMergedOperation({ forwardMergeId: merged.forwardMergeId!, worktreePath: repoPath, repositoryPath: repoPath, branchName: "issue/task-a", expectedBaseSha: oldBase, expectedHeadSha: merged.mergeCommit!, expectedHeadTree: merged.tree!, taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", projectRevisionId: "revision-a", checkpoint: "pre_final_review", developerExecutionId: "developer-a" })).rejects.toMatchObject({ code: "merge-state-ownership-mismatch" });
    await expect(service.revalidateMergedOperation({ forwardMergeId: merged.forwardMergeId!, worktreePath: repoPath, repositoryPath: repoPath, branchName: "issue/task-a", expectedBaseSha: oldBase, expectedHeadSha: merged.mergeCommit!, expectedHeadTree: merged.tree!, taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", projectRevisionId: "revision-other", checkpoint: "pre_release", developerExecutionId: "developer-a" })).rejects.toMatchObject({ code: "merge-state-ownership-mismatch" });
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim()).toBe(merged.mergeCommit);
    expect((value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_forward_merges WHERE task_id = 'task-a'").get()) as { count: number }).count).toBe(1);
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

/* Stale delivery and target-base checks were removed from release publishing. */
/*
test("publishRelease rejects stale delivery before release mutation", async () => {
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
    db.prepare("INSERT OR REPLACE INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('lead-a', 'task-a', 'company-a', 'workflow-a', 'planner', 'completed', 1, 'lead-session', ?, ?, ?)").run(now, now, leadEvidenceId);
    db.prepare("UPDATE forge_projects SET repository_identity = 'acme/forge' WHERE id = 'project-a'").run();
    db.prepare("INSERT OR REPLACE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, heartbeat_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-a', 'task-a', 'company-a', 'workflow-a', 1, 1, 'completed', 'issue/task-a', ?, ?, 'developer-session', ?, ?, ?, ?, ?, 'clean', ?, ?)").run(repo, oldBase, now, now, now, oldHead, oldTree, deliveryId, developerEvidenceId);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES (?, 'task-a', 'company-a', 'workflow-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Approved exact delivery', ?, ?, 0, ?)").run(reviewId, oldBase, oldHead, oldTree, opinionId, leadEvidenceId, now);
    db.prepare("UPDATE forge_project_revisions SET normalized_json = ? WHERE id = 'revision-a'").run(JSON.stringify({ repository: "acme/forge", repositoryPath: repo, worktreeRoot: join(value.root, "worktrees"), baseBranch: "main", targetBranch: "main", baseSha: oldBase, targetSha: oldHead, setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: [] }));
  });

  const github: GithubReleasePort & GithubAcceptancePort & { pushed: number; created: GithubPullRequest[]; nextHead: string; nextTree: string; nextBase: string } = {
    pushed: 0,
    created: [],
    nextHead: oldHead,
    nextTree: oldTree,
    nextBase: oldBase,
    async checkAuthentication() {},
    async getRemoteRepository() { return "acme/forge"; },
    async getBranchHead(input) { return input.branch === "main" ? this.nextBase : this.nextHead; },
    async inspectLocalRevision() { return { branch: "issue/task-a", headSha: this.nextHead, treeSha: this.nextTree, clean: true }; },
    async pushNormal() { this.pushed += 1; },
    async listPullRequests() { return this.created; },
    async createDraftPullRequest(input) { const pr: GithubPullRequest = { number: this.created.length + 1, url: `https://github.com/${input.repository}/pull/${this.created.length + 1}`, repository: input.repository, headBranch: input.headBranch, baseBranch: input.baseBranch, headSha: this.nextHead, baseSha: this.nextBase, isDraft: true, state: "open", mergedAt: null }; this.created.push(pr); return pr; },
    async updateDraftPullRequest(input) { return this.created.find((pr) => pr.number === input.number) ?? this.created[0]!; },
    async markReadyForReview() {},
    async getPullRequest(input) { return this.created.find((pr) => pr.number === input.number) ?? this.created[0]!; },
  };

  const activities = createActivities(value.database, value.config, { githubRelease: github });
  github.nextBase = newBase;
  await mkdir(join(value.config.artifactRoot, "company-a"), { recursive: true });
  await writeFile(join(value.config.artifactRoot, "company-a", deliveryId), JSON.stringify({ steps: [] }));
  value.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET byte_size = ?, sha256 = ? WHERE id = ?").run(JSON.stringify({ steps: [] }).length, createHash("sha256").update(JSON.stringify({ steps: [] })).digest("hex"), deliveryId));
  await expect(activities.publishRelease({ taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", reviewId, developerExecutionId: "developer-a", branchName: "issue/task-a", targetBaseSha: oldBase, subjectCommit: oldHead, subjectTree: oldTree })).resolves.toMatchObject({ outcome: "blocked", code: "target-base-drift" });
  expect(github.pushed).toBe(0);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

*/

test("existing PR retry observes remote state before repeating a push", async () => {
  const value = await fixture();
  try {
    addReleaseFixtures(value.database);
    const nextHead = "c".repeat(40);
    const nextTree = "d".repeat(40);
    value.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('review-new', 'task-a', 'company-a', 'workflow-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Approved new delivery', 'opinion-a', 'evidence-a', 0, ?)").run(baseSha, nextHead, nextTree, now);
    });
    let remoteHead: string | null = null;
    let pullRequestHead = headSha;
    let pushes = 0;
    let hidePushedHeadOnce = false;
    const github: GithubReleasePort = {
      async checkAuthentication() {},
      async getRemoteRepository() { return "acme/forge"; },
      async getBranchHead({ branch }) { if (branch === "main") return baseSha; if (hidePushedHeadOnce) { hidePushedHeadOnce = false; throw new Error("temporary provider outage"); } return remoteHead; },
      async inspectLocalRevision() { return { branch: "issue/task-a", headSha: nextHead, treeSha: nextTree, clean: true }; },
      async pushNormal() { pushes += 1; remoteHead = nextHead; pullRequestHead = nextHead; hidePushedHeadOnce = true; throw new Error("timeout after push"); },
      async listPullRequests() { return [{ number: 12, url: "https://github.com/acme/forge/pull/12", repository: "acme/forge", headBranch: "issue/task-a", baseBranch: "main", headSha: pullRequestHead, baseSha, isDraft: true, state: "open", mergedAt: null }]; },
      async createDraftPullRequest() { throw new Error("must not create a second PR"); },
      async updateDraftPullRequest() { return { number: 12, url: "https://github.com/acme/forge/pull/12", repository: "acme/forge", headBranch: "issue/task-a", baseBranch: "main", headSha: pullRequestHead, baseSha, isDraft: true, state: "open", mergedAt: null }; },
      async getPullRequest() { return { number: 12, url: "https://github.com/acme/forge/pull/12", repository: "acme/forge", headBranch: "issue/task-a", baseBranch: "main", headSha: pullRequestHead, baseSha, isDraft: true, state: "open", mergedAt: null }; },
    };
    const release = new ReleaseService(value.database, new ArtifactStore(value.config.artifactRoot), github);
    const input = {
      taskId: "task-a",
      companyId: "company-a",
      workflowId: "workflow-a",
      releaseId: "release-a",
      coordinates: { projectRevisionId: "revision-a", repositoryPath: join(value.root, "repo"), worktreePath: join(value.root, "repo"), repository: "acme/forge", owner: "acme", headBranch: "issue/task-a", baseBranch: "main", expectedBaseSha: baseSha },
      reviewedRevision: { reviewId: "review-new", developerExecutionId: "developer-a", commitSha: nextHead, treeSha: nextTree },
      taskTitle: "Task A",
      delivery: { filesChanged: ["feature.ts"], commandsRun: ["pnpm test"], testResults: ["passed"] },
    };
    await expect(release.publish(input)).rejects.toBeTruthy();
    const recovered = await release.publish(input);
    expect(recovered.releaseId).toBe("release-a");
    expect(recovered.pullRequest.number).toBe(12);
    expect(recovered.pullRequest.url).toBe("https://github.com/acme/forge/pull/12");
    expect(pushes).toBe(1);
    expect(value.database.authQuery((db) => db.prepare("SELECT head_sha FROM forge_releases WHERE id = 'release-a'").get())).toEqual({ head_sha: nextHead });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_releases WHERE task_id = 'task-a'").get())).toEqual({ count: 1 });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

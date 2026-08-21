import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, test, vi } from "vitest";

import { ArtifactStore, type StoredArtifact } from "../src/artifacts.js";
import { DeveloperService } from "../src/codex-developer.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { reconcileBlockedDeveloperDeliveries } from "../src/developer-reconciliation-recovery.js";
import { DeveloperReconciliationArtifactSchema, isLegacyReceiptOnlyRecovery } from "../src/developer-reconciliation.js";
import type { GithubAdapter, GithubMutationSurface } from "../src/github.js";
import { StructuredLogger } from "../src/logging.js";
import { WorktreeManager } from "../src/worktrees.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function register(database: ForgeDatabase, ...artifacts: StoredArtifact[]): void {
  database.authTransaction((db) => {
    for (const artifact of artifacts) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
  });
}

function verificationPolicyHash(revision: { setupCommand: string; verificationCommand: string; requiredChecks: string[] }): string {
  return createHash("sha256").update(JSON.stringify(revision, ["requiredChecks", "setupCommand", "verificationCommand"])).digest("hex");
}

interface RecoveryFixture {
  root: string;
  database: ForgeDatabase;
  artifacts: ArtifactStore;
  service: DeveloperService;
  input: { taskId: string; companyId: string; workflowId: string; developerExecutionId: string };
  baseSha: string;
  head: string;
  tree: string;
  providerSha: string;
  legacyArtifact: StoredArtifact;
  rawArtifact: StoredArtifact;
  counters: { provider: number; process: number };
  verifierCounterPath: string;
  setProviderEffect(effect: (() => void | Promise<void>) | undefined): void;
}

async function recoveryFixture(options: { verificationFails?: boolean } = {}): Promise<RecoveryFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "forge-developer-reconciliation-service-")));
  roots.push(root);
  const repositoryRoot = join(root, "repositories");
  const repositoryPath = join(repositoryRoot, "repo");
  const worktreeRoot = join(root, "worktrees");
  const worktreePath = join(worktreeRoot, "task_1");
  const verifierCounterPath = join(root, "verifier-count.txt");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const testScript = options.verificationFails
    ? "node -e \"process.exit(1)\""
    : `node -e \"require('fs').appendFileSync('${verifierCounterPath}', '1')\"`;
  await writeFile(join(repositoryPath, "README.md"), "base\n");
  await writeFile(join(repositoryPath, ".gitignore"), "node_modules/\n");
  await writeFile(join(repositoryPath, "package.json"), JSON.stringify({ name: "recovery-proof", version: "1.0.0", scripts: { test: testScript } }));
  await execFileAsync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: repositoryPath });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "forge-test@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Forge Test"], { cwd: repositoryPath });
  await execFileAsync("git", ["add", "."], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repositoryPath });
  const baseSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
  const startingTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();
  await execFileAsync("git", ["worktree", "add", "-b", "work/task_1", worktreePath, baseSha], { cwd: repositoryPath });
  await writeFile(join(worktreePath, "DELIVERED.md"), "delivered\n");
  await execFileAsync("git", ["add", "DELIVERED.md"], { cwd: worktreePath });
  await execFileAsync("git", ["commit", "-m", "delivery"], { cwd: worktreePath });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
  const tree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: worktreePath })).stdout.trim();

  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactRoot);
  const now = "2026-08-16T12:00:00.000Z";
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'User', 'user', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
  });
  const planBytes = Buffer.from("{\"kind\":\"plan\"}");
  const planArtifact = await artifacts.put("company_1", "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: planBytes });
  const briefArtifact = await artifacts.put("company_1", "task-brief", { filename: "brief.md", mimeType: "text/markdown", bytes: Buffer.from("brief") });
  const evidenceArtifact = await artifacts.put("company_1", "agent-evidence", { filename: "developer.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") });
  register(database, planArtifact, briefArtifact, evidenceArtifact);

  const authorization = { authorizationId: "authorization_1", taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", planRevision: 1, planArtifactId: planArtifact.id, planSha256: planArtifact.sha256, authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: now };
  const revision = { repository: "acme/forge", repositoryPath, worktreeRoot, baseBranch: "main", targetBranch: "main", baseSha, targetSha: baseSha, setupCommand: "npm ci", verificationCommand: "npm test", requiredChecks: [] as string[] };
  const manifest = {
    version: 1 as const,
    authorizedPlan: authorization,
    projectRevision: { projectRevisionId: "revision_1", projectId: "project_1", companyId: "company_1", repositoryIdentity: revision.repository, repositoryPath, worktreeRoot, baseBranch: revision.baseBranch, targetBranch: revision.targetBranch, baseSha, targetSha: baseSha, setupVerificationPolicySha256: verificationPolicyHash(revision) },
    entries: [{ kind: "final_plan" as const, artifactId: planArtifact.id, repositoryPath: null, sha256: planArtifact.sha256, byteSize: planArtifact.byteSize, stagedFilename: "plan.json", planStepNumbers: [1] }],
    contradictionRule: "stop_before_unrelated_edits" as const,
    verificationCommands: [{ stepNumber: 1, commands: ["npm test"] }],
    createdAt: now,
  };
  const manifestArtifact = await artifacts.put("company_1", "developer-evidence-manifest", { filename: "manifest.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(manifest)) });
  const providerSha = "a".repeat(64);
  const beforeArtifact = await artifacts.put("company_1", "developer-provider-observation", { filename: "developer_1-before.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ sha256: providerSha })) });
  const rawReport = { kind: "delivery", summary: "Delivered", steps: [{ number: 1, status: "completed", filesChanged: ["DELIVERED.md"], notes: "done" }], authorizedStepsNotCompleted: [], resultCommit: head, resultTree: tree, dirtyState: "clean", blocker: null };
  const rawArtifact = await artifacts.put("company_1", "developer-delivery-raw", { filename: "developer_1.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(rawReport)) });
  const receipt = { eventId: "receipt_1", executionId: "developer_1", attempt: 1, sequence: 1, kind: "step_blocked", stepNumber: 1, sourceItemId: null, occurredAt: now, summary: "legacy receipt", exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: "receipt_1" };
  const legacy = { kind: "developer-reconciliation", executionId: "developer_1", companyId: "company_1", outcome: "blocked", failureCode: "delivery-reconciliation-failed", mismatches: ["receipt-outside-step"], report: rawReport, authorization, manifest, receipts: [receipt], receiptCount: 1, git: { branch: "work/task_1", head, tree, status: "", parents: [baseSha], commitCount: 1, isDescendant: true, changedPaths: ["DELIVERED.md"] }, provider: { beforeSha256: providerSha, afterSha256: providerSha, matching: true }, observations: { startingSha: baseSha, neutralBranch: "work/task_1", processExitCode: 0, developerSessionId: "developer-session", leadSessionId: "lead-session" }, sha256: "b".repeat(64) };
  const legacyArtifact = await artifacts.put("company_1", "developer-reconciliation", { filename: "developer_1.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(legacy)) });
  register(database, manifestArtifact, beforeArtifact, rawArtifact, legacyArtifact);

  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', 'npm ci', 'npm test', '[]', '{}', 'active', 'revision_1', ?, ?)").run(repositoryPath, worktreeRoot, now, now);
    db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, state, created_at) VALUES ('revision_1', 'project_1', 1, 'identity_1', ?, ?, ?, 'user_1', 'accepted', ?)").run(JSON.stringify(revision), baseSha, baseSha, now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', ?, '[]', '{}', 0, 'workflow_1', 'revision_1', 'task-key', ?, ?)").run(briefArtifact.id, now, now);
    db.prepare("INSERT INTO forge_plan_authorizations (id, task_id, company_id, project_id, workflow_id, plan_revision, plan_artifact_id, plan_sha256, authorization_kind, approval_decision_id, authorized_at) VALUES ('authorization_1', 'task_1', 'company_1', 'project_1', 'workflow_1', 1, ?, ?, 'routine_auto', NULL, ?)").run(planArtifact.id, planArtifact.sha256, now);
    db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, legacy, status, reserved_at, activated_at) VALUES ('worktree_1', 'task_1', 'company_1', 'project_1', 'workflow_1', ?, ?, ?, 'work/task_1', ?, ?, 0, 'active', ?, ?)").run(repositoryPath, worktreeRoot, worktreePath, baseSha, "c".repeat(64), now, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id, failure_code, failure_summary) VALUES ('developer_1', 'task_1', 'company_1', 'workflow_1', 1, 1, 'blocked', 'work/task_1', ?, ?, 'developer-session-ref', ?, ?, ?, 'clean', ?, ?, 'delivery-reconciliation-failed', 'legacy receipt policy')").run(worktreePath, baseSha, now, head, tree, legacyArtifact.id, evidenceArtifact.id);
    db.prepare("INSERT INTO forge_developer_execution_truth (execution_id, authorization_id, worktree_lease_id, manifest_artifact_id, manifest_sha256, boundary_mode, before_provider_artifact_id, before_provider_sha256, raw_report_artifact_id, raw_report_sha256, reconciliation_artifact_id, reconciliation_sha256, starting_commit, starting_tree, final_commit, final_tree) VALUES ('developer_1', 'authorization_1', 'worktree_1', ?, ?, 'owner_controlled_observed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(manifestArtifact.id, manifestArtifact.sha256, beforeArtifact.id, providerSha, rawArtifact.id, rawArtifact.sha256, legacyArtifact.id, legacyArtifact.sha256, baseSha, startingTree, head, tree);
  });

  const counters = { provider: 0, process: 0 };
  let providerEffect: (() => void | Promise<void>) | undefined;
  const observation: GithubMutationSurface = { repository: "acme/forge", observedAt: now, branches: [], pullRequests: [], sha256: providerSha };
  const githubObservation: GithubAdapter = {
    async checkAuthentication() {},
    async getRepository() { return { nameWithOwner: "acme/forge", url: "https://example.invalid/acme/forge" }; },
    async observeMutationSurface() { counters.provider += 1; await providerEffect?.(); return observation; },
  };
  const service = new DeveloperService(database, config, {
    githubObservation,
    processRunner: async () => { counters.process += 1; throw new Error("stored recovery must not start a Developer turn"); },
    sessionStore: { async create(value: string) { return value; }, async read(value: string) { return value; } },
  });
  return { root, database, artifacts, service, input: { taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", developerExecutionId: "developer_1" }, baseSha, head, tree, providerSha, legacyArtifact, rawArtifact, counters, verifierCounterPath, setProviderEffect(effect) { providerEffect = effect; } };
}

function truth(database: ForgeDatabase) {
  return database.authQuery((db) => db.prepare("SELECT e.status, e.failure_code AS failureCode, e.result_commit AS resultCommit, e.result_tree AS resultTree, e.delivery_artifact_id AS deliveryArtifactId, t.reconciliation_artifact_id AS reconciliationArtifactId, t.reconciliation_sha256 AS reconciliationSha256, t.after_provider_artifact_id AS afterProviderArtifactId, t.final_commit AS finalCommit, t.final_tree AS finalTree FROM forge_developer_executions e JOIN forge_developer_execution_truth t ON t.execution_id = e.id WHERE e.id = 'developer_1'").get() as Record<string, string | null>);
}

function artifactCount(database: ForgeDatabase): number {
  return database.authQuery((db) => Number((db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts").get() as { count: number }).count));
}

test("recovers a legacy receipt-only delivery and repeats without external work", async () => {
  const value = await recoveryFixture();
  const legacyRow = value.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(value.legacyArtifact.id) as { storagePath: string; sha256: string });
  expect(isLegacyReceiptOnlyRecovery(JSON.parse((await value.artifacts.read({ companyId: "company_1", ...legacyRow })).toString("utf8")))).toBe(true);
  const owned = value.database.authQuery((db) => db.prepare("SELECT id AS leaseId, lease_token_hash AS leaseTokenHash, task_id AS taskId, company_id AS companyId, project_id AS projectId, workflow_id AS workflowId, repository_path AS repositoryRoot, worktree_root AS worktreeRoot, worktree_path AS worktreePath, branch_name AS branchName, starting_sha AS startingSha, legacy, status FROM forge_issue_worktrees WHERE id = 'worktree_1'").get() as Record<string, unknown> & { legacy: number });
  expect(await new WorktreeManager().inspectOwned({ ...owned, legacy: owned.legacy === 1 } as never, owned.repositoryRoot as string)).toMatchObject({ repositoryRegistered: true, pathExists: true, pathIsSymlink: false, branch: "work/task_1" });
  const originalCount = artifactCount(value.database);
  const first = await value.service.reconcileStoredDelivery(value.input);
  const recovered = truth(value.database);

  expect(first, JSON.stringify({ counters: value.counters, verifier: await readFile(value.verifierCounterPath, "utf8").catch(() => "missing"), recovered })).toMatchObject({ outcome: "completed", developerExecutionId: "developer_1", resultCommit: value.head, resultTree: value.tree });
  expect(value.counters).toEqual({ provider: 1, process: 0 });
  expect((await readFile(value.verifierCounterPath, "utf8")).length).toBe(1);
  expect(recovered).toMatchObject({ status: "completed", failureCode: null, resultCommit: value.head, resultTree: value.tree, finalCommit: value.head, finalTree: value.tree });
  expect(recovered.reconciliationArtifactId).not.toBe(value.legacyArtifact.id);
  expect(recovered.deliveryArtifactId).toBe(recovered.reconciliationArtifactId);
  expect(recovered.afterProviderArtifactId).toBeTruthy();
  expect(value.database.authQuery((db) => db.prepare("SELECT 1 FROM forge_artifacts WHERE id = ?").get(value.legacyArtifact.id))).toBeTruthy();

  const firstCount = artifactCount(value.database);
  const second = await value.service.reconcileStoredDelivery(value.input);
  expect(second).toEqual(first);
  expect(value.counters).toEqual({ provider: 1, process: 0 });
  expect((await readFile(value.verifierCounterPath, "utf8")).length).toBe(1);
  expect(artifactCount(value.database)).toBe(firstCount);
  expect(firstCount).toBe(originalCount + 2);

  const artifactRow = value.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(recovered.reconciliationArtifactId) as { storagePath: string; sha256: string });
  const artifact = DeveloperReconciliationArtifactSchema.parse(JSON.parse((await value.artifacts.read({ companyId: "company_1", ...artifactRow })).toString("utf8")));
  expect(artifact).toMatchObject({ policyVersion: 2, outcome: "completed", executionId: "developer_1", companyId: "company_1", authorization: { authorizationId: "authorization_1", taskId: "task_1", workflowId: "workflow_1" }, git: { head: value.head, tree: value.tree }, independentVerification: { outcome: "passed" } });
  value.database.close();
});

test("keeps the original authority when fresh verification fails", async () => {
  const value = await recoveryFixture({ verificationFails: true });
  expect(await value.service.reconcileStoredDelivery(value.input)).toBeNull();
  expect(value.counters).toEqual({ provider: 1, process: 0 });
  expect(truth(value.database)).toMatchObject({ status: "blocked", failureCode: "delivery-reconciliation-failed", reconciliationArtifactId: value.legacyArtifact.id });
  value.database.close();
});

test("rejects provider unavailability without mutating truth", async () => {
  const value = await recoveryFixture();
  const adapter = (value.service as unknown as { githubObservation: GithubAdapter }).githubObservation;
  vi.spyOn(adapter, "observeMutationSurface").mockImplementation(async () => {
    value.counters.provider += 1;
    throw new Error("provider unavailable");
  });
  expect(await value.service.reconcileStoredDelivery(value.input)).toBeNull();
  expect(truth(value.database)).toMatchObject({ status: "blocked", reconciliationArtifactId: value.legacyArtifact.id });
  value.database.close();
});

test("recovers when unrelated provider state drifts", async () => {
  const value = await recoveryFixture();
  const adapter = (value.service as unknown as { githubObservation: GithubAdapter }).githubObservation;
  vi.spyOn(adapter, "observeMutationSurface").mockImplementation(async () => {
    value.counters.provider += 1;
    return { repository: "acme/forge", observedAt: new Date().toISOString(), branches: [], pullRequests: [], sha256: "d".repeat(64) };
  });
  expect(await value.service.reconcileStoredDelivery(value.input)).toMatchObject({ outcome: "completed" });
  expect(truth(value.database)).toMatchObject({ status: "completed" });
  value.database.close();
});

test("cancellation, supersession, and truth-pointer races cannot complete recovery", async () => {
  for (const race of ["cancel", "supersede-running", "supersede-blocked", "truth"] as const) {
    const value = await recoveryFixture();
    value.setProviderEffect(() => value.database.authTransaction((db) => {
      if (race === "cancel") db.prepare("UPDATE forge_developer_executions SET status = 'cancelled' WHERE id = 'developer_1'").run();
      if (race.startsWith("supersede")) db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, supersedes_execution_id, started_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, 2, ?, 'work/task_1-next', ?, ?, 'developer_1', ?)").run(`developer_2_${race}`, race === "supersede-running" ? "running" : "blocked", join(value.root, `next-${race}`), value.baseSha, new Date().toISOString());
      if (race === "truth") db.prepare("UPDATE forge_developer_execution_truth SET reconciliation_artifact_id = ?, reconciliation_sha256 = ? WHERE execution_id = 'developer_1'").run(value.rawArtifact.id, value.rawArtifact.sha256);
    }));
    expect(await value.service.reconcileStoredDelivery(value.input)).toBeNull();
    const after = truth(value.database);
    expect(after.status).toBe(race === "cancel" ? "cancelled" : "blocked");
    expect(after.reconciliationArtifactId).toBe(race === "truth" ? value.rawArtifact.id : value.legacyArtifact.id);
    value.database.close();
  }
});

test("completed replay rejects mismatched authority, Git, provenance, and supersession", async () => {
  const value = await recoveryFixture();
  expect(await value.service.reconcileStoredDelivery(value.input)).not.toBeNull();
  const saved = truth(value.database);
  const noExternalWork = async () => {
    const before = { ...value.counters };
    expect(await value.service.reconcileStoredDelivery(value.input)).toBeNull();
    expect(value.counters).toEqual(before);
  };

  const recoveredRow = value.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(saved.reconciliationArtifactId) as { storagePath: string; sha256: string });
  const recoveredArtifact = DeveloperReconciliationArtifactSchema.parse(JSON.parse((await value.artifacts.read({ companyId: "company_1", ...recoveredRow })).toString("utf8")));
  const alteredArtifacts = [
    { ...recoveredArtifact, executionId: "developer_other" },
    { ...recoveredArtifact, companyId: "company_other" },
    { ...recoveredArtifact, authorization: { ...recoveredArtifact.authorization, authorizationId: "authorization_other" }, manifest: { ...recoveredArtifact.manifest, authorizedPlan: { ...recoveredArtifact.manifest.authorizedPlan, authorizationId: "authorization_other" } } },
    { ...recoveredArtifact, authorization: { ...recoveredArtifact.authorization, taskId: "task_other" }, manifest: { ...recoveredArtifact.manifest, authorizedPlan: { ...recoveredArtifact.manifest.authorizedPlan, taskId: "task_other" } } },
    { ...recoveredArtifact, authorization: { ...recoveredArtifact.authorization, workflowId: "workflow_other" }, manifest: { ...recoveredArtifact.manifest, authorizedPlan: { ...recoveredArtifact.manifest.authorizedPlan, workflowId: "workflow_other" } } },
    { ...recoveredArtifact, manifest: { ...recoveredArtifact.manifest, authorizedPlan: { ...recoveredArtifact.manifest.authorizedPlan, planRevision: 2 } } },
    { ...recoveredArtifact, manifest: { ...recoveredArtifact.manifest, projectRevision: { ...recoveredArtifact.manifest.projectRevision, projectRevisionId: "revision_other" } } },
    { ...recoveredArtifact, git: { ...recoveredArtifact.git, head: "f".repeat(40) } },
    { ...recoveredArtifact, policyVersion: undefined },
    { ...recoveredArtifact, outcome: "blocked" },
  ];
  for (const altered of alteredArtifacts) {
    const artifact = await value.artifacts.put("company_1", "developer-reconciliation", { filename: "developer_1-recovery.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(altered)) });
    register(value.database, artifact);
    value.database.authQuery((db) => {
      db.prepare("UPDATE forge_developer_execution_truth SET reconciliation_artifact_id = ?, reconciliation_sha256 = ? WHERE execution_id = 'developer_1'").run(artifact.id, artifact.sha256);
      db.prepare("UPDATE forge_developer_executions SET delivery_artifact_id = ? WHERE id = 'developer_1'").run(artifact.id);
    });
    await noExternalWork();
    value.database.authQuery((db) => {
      db.prepare("UPDATE forge_developer_execution_truth SET reconciliation_artifact_id = ?, reconciliation_sha256 = ? WHERE execution_id = 'developer_1'").run(saved.reconciliationArtifactId, saved.reconciliationSha256);
      db.prepare("UPDATE forge_developer_executions SET delivery_artifact_id = ? WHERE id = 'developer_1'").run(saved.deliveryArtifactId);
    });
  }

  value.database.authQuery((db) => db.prepare("UPDATE forge_developer_execution_truth SET final_tree = ? WHERE execution_id = 'developer_1'").run("e".repeat(40)));
  await noExternalWork();
  value.database.authQuery((db) => db.prepare("UPDATE forge_developer_execution_truth SET final_tree = ? WHERE execution_id = 'developer_1'").run(saved.finalTree));

  value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET delivery_artifact_id = ? WHERE id = 'developer_1'").run(value.legacyArtifact.id));
  await noExternalWork();
  value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET delivery_artifact_id = ? WHERE id = 'developer_1'").run(saved.deliveryArtifactId));

  value.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET filename = 'normal-delivery.json' WHERE id = ?").run(saved.reconciliationArtifactId));
  await noExternalWork();
  value.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET filename = 'developer_1-recovery.json' WHERE id = ?").run(saved.reconciliationArtifactId));

  value.database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, supersedes_execution_id, started_at) VALUES ('developer_2', 'task_1', 'company_1', 'workflow_1', 1, 2, 'blocked', 'work/task_1-next', ?, ?, 'developer_1', ?)").run(join(value.root, "next"), value.baseSha, new Date().toISOString()));
  await noExternalWork();
  value.database.close();
});

test("unexpected query faults are redacted locally", async () => {
  const value = await recoveryFixture();
  const logs = vi.spyOn(StructuredLogger.prototype, "error").mockImplementation(() => undefined);
  const original = value.database.authQuery.bind(value.database);
  vi.spyOn(value.database, "authQuery").mockImplementationOnce(() => { throw new Error("token=super-secret-value"); });
  expect(await value.service.reconcileStoredDelivery(value.input)).toBeNull();
  expect(logs).toHaveBeenCalledTimes(1);
  expect(logs.mock.calls[0]).toEqual(expect.arrayContaining(["Developer stored-delivery recovery fault", expect.anything(), expect.objectContaining({ phase: "eligibility-query", error: expect.stringContaining("[REDACTED]") })]));
  expect(JSON.stringify(logs.mock.calls[0])).not.toContain("super-secret-value");
  vi.mocked(value.database.authQuery).mockImplementation(original);
  value.database.close();
});

test("background recovery redacts one failure and continues to the next candidate", async () => {
  const rows = [{ workflowId: "workflow_1", revision: 1, executionId: "developer_1" }, { workflowId: "workflow_2", revision: 2, executionId: "developer_2" }];
  const database = { authQuery: (query: (db: { prepare: () => { all: () => typeof rows } }) => unknown) => query({ prepare: () => ({ all: () => rows }) }) } as unknown as ForgeDatabase;
  const logs = vi.spyOn(StructuredLogger.prototype, "error").mockImplementation(() => undefined);
  const attempted: string[] = [];
  const recovered = await reconcileBlockedDeveloperDeliveries(database, {} as never, async (_config, workflowId) => {
    attempted.push(workflowId);
    if (workflowId === "workflow_1") throw new Error("password=hunter2");
    return { phase: "delivery_ready" } as never;
  });
  expect(recovered).toBe(1);
  expect(attempted).toEqual(["workflow_1", "workflow_2"]);
  expect(JSON.stringify(logs.mock.calls)).toContain("[REDACTED]");
  expect(JSON.stringify(logs.mock.calls)).not.toContain("hunter2");
});

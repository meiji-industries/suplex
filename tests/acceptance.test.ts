import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { AcceptanceService } from "../src/acceptance.js";
import { ArtifactStore } from "../src/artifacts.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { type GithubAcceptancePort, type GithubPullRequest } from "../src/github-release.js";

const now = "2026-08-11T00:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const treeSha = "c".repeat(40);

function pullRequest(overrides: Partial<GithubPullRequest> = {}): GithubPullRequest {
  return { number: 12, url: "https://github.com/acme/forge/pull/12", repository: "acme/forge", headBranch: "issue/task-a", baseBranch: "main", headSha, baseSha, isDraft: true, state: "open", mergedAt: null, ...overrides };
}

async function fixture(): Promise<{ root: string; database: ForgeDatabase; artifacts: ArtifactStore }> {
  const root = await mkdtemp(join(tmpdir(), "forge-acceptance-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts"), dataRoot: join(root, "data") });
  await mkdir(config.artifactRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', '', '', '[]', '{}', 'active', 'revision-a', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, state, created_at) VALUES ('revision-a', 'project-a', 1, 'identity-a', ?, ?, ?, 'admin', 'accepted', ?)").run(JSON.stringify({ repository: "acme/forge", repositoryPath: join(root, "repo"), worktreeRoot: join(root, "worktrees"), baseBranch: "main", targetBranch: "main", baseSha, targetSha: headSha, requiredChecks: [] }), baseSha, headSha, now);
    for (const [id, kind] of [["brief-a", "task-brief"], ["opinion-a", "agent-opinion"], ["evidence-a", "agent-evidence"], ["developer-delivery", "developer-delivery"], ["developer-evidence", "agent-evidence"], ["output-a", "agent-output"], ["output-evidence", "agent-evidence"]] as const) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company-a', ?, ?, 'text/plain', 1, ?, ?, ?)").run(id, kind, `${id}.txt`, "d".repeat(64), `company-a/${id}`, now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-a', 'company-a', 'project-a', 'Task A', 'brief-a', '[]', '{}', 0, 'workflow-a', 'revision-a', 'task-a-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('lead-a', 'task-a', 'company-a', 'workflow-a', 'analyst', 'completed', 1, 'lead-session', ?)").run(now);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('delivery-a', 'task-a', 'company-a', 'workflow-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Approved exact delivery', 'opinion-a', 'evidence-a', 0, ?)").run(baseSha, headSha, treeSha, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-a', 'task-a', 'company-a', 'workflow-a', 1, 1, 'completed', 'issue/task-a', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', 'developer-delivery', 'developer-evidence')").run(join(root, "worktrees/task-a"), baseSha, now, now, headSha, treeSha);
    db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-a', 'task-a', 'company-a', 'workflow-a', 'release-a-key', 'acme/forge', 'issue/task-a', 'main', ?, ?, ?, 'draft', 12, 'https://github.com/acme/forge/pull/12', 'Task A', ?, ?)").run(baseSha, headSha, treeSha, now, now);
    db.prepare("INSERT INTO forge_ci_runs (id, task_id, company_id, release_id, expected_head_sha, status, attempt, summary, created_at, updated_at) VALUES ('ci-a', 'task-a', 'company-a', 'release-a', ?, 'passed', 1, 'All required checks passed', ?, ?)").run(headSha, now, now);
    db.prepare("INSERT INTO forge_final_reviews (id, task_id, company_id, workflow_id, release_id, ci_run_id, delivery_review_id, developer_execution_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, created_at) VALUES ('final-a', 'task-a', 'company-a', 'workflow-a', 'release-a', 'ci-a', 'delivery-a', 'developer-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Final review approved', 'opinion-a', 'evidence-a', ?)").run(baseSha, headSha, treeSha, now);
    db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output-a', 'task-a', 'company-a', 'workflow-a', 'lead-a', 1, 'plan', 'output-a', 'output-evidence', 'lead-session', 'Approved plan', ?)").run(now);
  });
  return { root, database, artifacts: new ArtifactStore(config.artifactRoot) };
}

function github(initial: GithubPullRequest = pullRequest()): GithubAcceptancePort & { readyCalls: number; current: GithubPullRequest } {
  const port = {
    readyCalls: 0,
    current: initial,
    async checkAuthentication() {},
    async getRemoteRepository() { return "acme/forge"; },
    async getBranchHead() { return baseSha; },
    async pushNormal() {},
    async listPullRequests() { return []; },
    async createDraftPullRequest() { return this.current; },
    async markReadyForReview() { this.readyCalls += 1; this.current = { ...this.current, isDraft: false }; },
    async getPullRequest() { return this.current; },
  };
  return port;
}

const input = { taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", projectRevisionId: "revision-a", releaseId: "release-a", deliveryReviewId: "delivery-a", finalReviewId: "final-a", ciRunId: "ci-a", pullRequestNumber: 12, repository: "acme/forge", baseBranch: "main", baseSha, headSha, headTree: treeSha, leadSessionRef: "lead-session", actorUserId: "admin" } as const;

test("acceptance requires exact final-review evidence and records ready reconciliation", async () => {
  const value = await fixture();
  try {
    const provider = github();
    const service = new AcceptanceService(value.database, provider, { artifacts: value.artifacts });
    await expect(service.accept({ ...input, finalReviewId: "missing-final" })).rejects.toMatchObject({ code: "not-ready" });
    const result = await service.accept(input);
    expect(result).toMatchObject({ status: "accepted", outcome: "ready" });
    expect(provider.readyCalls).toBe(1);
    const repeated = await service.accept(input);
    expect(repeated).toMatchObject({ acceptanceId: result.acceptanceId, status: "accepted" });
    expect(provider.readyCalls).toBe(1);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, ready_at FROM forge_acceptances WHERE id = ?").get(result.acceptanceId))).toMatchObject({ status: "accepted" });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_acceptance_attempts WHERE acceptance_id = ?").get(result.acceptanceId))).toEqual({ count: 2 });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("ready reconciliation records typed timeout, changed, and closed outcomes", async () => {
  const value = await fixture();
  try {
    const provider = github();
    provider.markReadyForReview = async () => { throw new Error("provider timeout"); };
    const service = new AcceptanceService(value.database, provider, { artifacts: value.artifacts });
    const pending = await service.accept(input);
    expect(pending).toMatchObject({ status: "pending_ready", outcome: "provider_unavailable" });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_acceptance_attempts WHERE acceptance_id = ?").get(pending.acceptanceId))).toEqual({ count: 2 });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }

  const changed = await fixture();
  try {
    const provider = github({ ...pullRequest(), headSha: "d".repeat(40) });
    const service = new AcceptanceService(changed.database, provider, { artifacts: changed.artifacts });
    await expect(service.accept(input)).resolves.toMatchObject({ status: "blocked", outcome: "changed" });
  } finally { changed.database.close(); await rm(changed.root, { recursive: true, force: true }); }

  const closed = await fixture();
  try {
    const provider = github({ ...pullRequest(), state: "closed" });
    const service = new AcceptanceService(closed.database, provider, { artifacts: closed.artifacts });
    await expect(service.accept(input)).resolves.toMatchObject({ status: "blocked", outcome: "closed" });
  } finally { closed.database.close(); await rm(closed.root, { recursive: true, force: true }); }
});

test("an already-ready exact PR is accepted without a second provider mutation", async () => {
  const value = await fixture();
  try {
    const provider = github({ ...pullRequest(), isDraft: false });
    const service = new AcceptanceService(value.database, provider, { artifacts: value.artifacts });
    const result = await service.accept(input);
    expect(result).toMatchObject({ status: "accepted", outcome: "ready" });
    expect(provider.readyCalls).toBe(0);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("concurrent acceptance requests claim the ready mutation exactly once", async () => {
  const value = await fixture();
  try {
    const provider = github();
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    provider.markReadyForReview = async () => {
      provider.readyCalls += 1;
      await mutationGate;
      provider.current = { ...provider.current, isDraft: false };
    };
    const service = new AcceptanceService(value.database, provider, { artifacts: value.artifacts });
    const resultsPromise = Promise.all([service.accept(input), service.accept(input)]);
    await vi.waitFor(() => expect(provider.readyCalls).toBeGreaterThan(0));
    releaseMutation();
    const results = await resultsPromise;
    expect(provider.readyCalls).toBe(1);
    expect(results.some((result) => result.status === "accepted")).toBe(true);
    await expect(service.reconcileReady({ acceptanceId: results[0]!.acceptanceId!, taskId: input.taskId, companyId: input.companyId })).resolves.toMatchObject({ status: "accepted" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("provider outage before acceptance returns a typed blocker without an intent", async () => {
  const value = await fixture();
  try {
    const provider = github();
    provider.getPullRequest = async () => { throw new Error("GitHub unavailable"); };
    const service = new AcceptanceService(value.database, provider, { artifacts: value.artifacts });
    const result = await service.accept(input);
    expect(result).toMatchObject({ status: "blocked", outcome: "provider_unavailable", blocker: { code: "provider_unavailable" } });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_acceptances").get())).toEqual({ count: 0 });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("cancellation records an attributed reason without touching the provider", async () => {
  const value = await fixture();
  try {
    const provider = github();
    const service = new AcceptanceService(value.database, provider, { artifacts: value.artifacts });
    const accepted = await service.accept(input);
    const cancelled = await service.accept({ ...input, decision: "cancel", reason: "Stop this delivery" });
    expect(cancelled).toMatchObject({ status: "cancelled", reasonArtifactId: expect.any(String) });
    expect(cancelled.acceptanceId).not.toBe(accepted.acceptanceId);
    expect(provider.readyCalls).toBe(1);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_acceptances WHERE id = ?").get(accepted.acceptanceId))).toEqual({ status: "accepted" });
    expect(value.database.authQuery((db) => db.prepare("SELECT decision, status FROM forge_acceptances WHERE id = ?").get(cancelled.acceptanceId))).toEqual({ decision: "cancel", status: "cancelled" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("request changes is accepted as a new immutable decision for a blocking final review", async () => {
  const value = await fixture();
  try {
    value.database.authTransaction((db) => db.prepare("UPDATE forge_final_reviews SET outcome = 'blocking' WHERE id = 'final-a'").run());
    const provider = github();
    const service = new AcceptanceService(value.database, provider, { artifacts: value.artifacts });
    const result = await service.accept({ ...input, decision: "request_changes", reason: "The blocking finding must be repaired." });
    expect(result).toMatchObject({ status: "requested_changes" });
    expect(value.database.authQuery((db) => db.prepare("SELECT decision, status FROM forge_acceptances ORDER BY created_at, id").all())).toEqual([{ decision: "request_changes", status: "requested_changes" }]);
    expect(provider.readyCalls).toBe(0);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("acceptance rejects a mismatched CI coordinate", async () => {
  const value = await fixture();
  try {
    value.database.authTransaction((db) => db.prepare("UPDATE forge_ci_runs SET expected_head_sha = ? WHERE id = 'ci-a'").run("e".repeat(40)));
    const service = new AcceptanceService(value.database, github(), { artifacts: value.artifacts });
    await expect(service.accept(input)).rejects.toMatchObject({ code: "not-ready" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("merge reconciliation is observation-backed and idempotent", async () => {
  const value = await fixture();
  try {
    const provider = github();
    const service = new AcceptanceService(value.database, provider, { artifacts: value.artifacts });
    const accepted = await service.accept(input);
    provider.current = { ...provider.current, state: "merged", isDraft: false, baseSha: "d".repeat(40), mergedAt: now };
    const first = await service.reconcileMerge({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, acceptanceId: accepted.acceptanceId! });
    const second = await service.reconcileMerge({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, acceptanceId: accepted.acceptanceId! });
    expect(first).toMatchObject({ outcome: "merged" });
    expect(second).toMatchObject({ outcome: "merged", observationId: first.observationId, completionReceiptId: first.completionReceiptId });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_completion_receipts WHERE acceptance_id = ?").get(accepted.acceptanceId))).toEqual({ count: 1 });
    expect(value.database.authQuery((db) => db.prepare("SELECT accepted_base_sha, receipt_artifact_id FROM forge_completion_receipts WHERE acceptance_id = ?").get(accepted.acceptanceId))).toEqual({ accepted_base_sha: baseSha, receipt_artifact_id: expect.any(String) });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import type { ArtifactStore } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import { redact } from "./logging.js";

const execFileAsync = promisify(execFile);

export interface GithubPullRequest {
  number: number;
  url: string;
  repository: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  isDraft: boolean;
  state: "open" | "closed" | "merged";
  mergedAt: string | null;
}

export interface GithubReleasePort {
  checkAuthentication(): Promise<void>;
  getRemoteRepository(input: { cwd: string }): Promise<string>;
  pushNormal(input: { cwd: string; branch: string }): Promise<void>;
  listPullRequests(input: { repository: string; headBranch: string; baseBranch: string }): Promise<GithubPullRequest[]>;
  createDraftPullRequest(input: { repository: string; headBranch: string; baseBranch: string; title: string; body: string }): Promise<GithubPullRequest>;
  markReadyForReview?(input: { repository: string; number: number }): Promise<void>;
  getPullRequest?(input: { repository: string; number: number }): Promise<GithubPullRequest>;
}

export class GithubReleaseFailure extends Error {
  constructor(readonly code: "authentication" | "wrong-remote" | "stale-revision" | "ambiguous" | "provider" | "not-ready" | "scope") {
    super(`GitHub release ${code}`);
    this.name = "GithubReleaseFailure";
  }
}

function sanitize(value: string): string {
  return String(redact(value)).replace(/(?:\/private)?\/(?:Users|home|var|tmp)\/[^\s)]+/g, "[path-redacted]").replace(/(?:prompt|reasoning|credential|token)[:=][^\n]*/gi, "[redacted]").trim();
}

function newReleaseId(): string {
  return `release_${randomBytes(12).toString("hex")}`;
}

export function createGithubReleasePort(command = process.env.FORGE_GH_COMMAND ?? "gh"): GithubReleasePort {
  const run = async (args: string[], cwd?: string, timeout = 20_000): Promise<{ stdout: string; stderr: string }> => {
    try { return await execFileAsync(command, args, { cwd, timeout, maxBuffer: 256 * 1024 }); } catch (error) {
      const message = error instanceof Error ? sanitize(error.message) : "provider command failed";
      throw new GithubReleaseFailure(/auth|login|token/i.test(message) ? "authentication" : "provider");
    }
  };
  const parsePullRequest = (value: unknown): GithubPullRequest => {
    const row = value as Record<string, unknown>;
    const head = (row.headRefName ?? row.headBranch) as unknown;
    const base = (row.baseRefName ?? row.baseBranch) as unknown;
    const headSha = (row.headRefOid ?? row.headSha) as unknown;
    const baseSha = (row.baseRefOid ?? row.baseSha) as unknown;
    if (typeof row.number !== "number" || typeof row.url !== "string" || typeof row.nameWithOwner !== "string" && typeof row.repository !== "string" || typeof head !== "string" || typeof base !== "string" || typeof headSha !== "string" || typeof baseSha !== "string") throw new GithubReleaseFailure("provider");
    const state = row.state === "MERGED" || row.mergedAt ? "merged" : row.state === "CLOSED" ? "closed" : "open";
    return { number: row.number, url: row.url, repository: String(row.nameWithOwner ?? row.repository), headBranch: head, baseBranch: base, headSha, baseSha, isDraft: row.isDraft === true, state, mergedAt: typeof row.mergedAt === "string" ? row.mergedAt : null };
  };
  return {
    async checkAuthentication() { await run(["auth", "status", "--hostname", "github.com"], undefined, 10_000); },
    async getRemoteRepository(input) {
      const result = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: input.cwd, timeout: 8_000, maxBuffer: 16 * 1024 }).catch(() => { throw new GithubReleaseFailure("wrong-remote"); });
      const remote = result.stdout.trim().replace(/\.git$/, "");
      const ssh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(remote);
      const https = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(remote);
      if (!ssh && !https) throw new GithubReleaseFailure("wrong-remote");
      return (ssh?.[1] ?? https?.[1] ?? "").toLowerCase();
    },
    async pushNormal(input) { await execFileAsync("git", ["push", "origin", `HEAD:refs/heads/${input.branch}`], { cwd: input.cwd, timeout: 60_000, maxBuffer: 64 * 1024 }).catch(() => { throw new GithubReleaseFailure("provider"); }); },
    async listPullRequests(input) {
      const result = await run(["pr", "list", "--repo", input.repository, "--head", input.headBranch, "--base", input.baseBranch, "--state", "all", "--json", "number,url,nameWithOwner,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,state,mergedAt"]);
      try { const rows = JSON.parse(result.stdout) as unknown; return Array.isArray(rows) ? rows.map(parsePullRequest) : []; } catch { throw new GithubReleaseFailure("provider"); }
    },
    async createDraftPullRequest(input) {
      const result = await run(["pr", "create", "--repo", input.repository, "--base", input.baseBranch, "--head", input.headBranch, "--draft", "--title", input.title, "--body", input.body, "--json", "number,url,nameWithOwner,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,state,mergedAt"]);
      try { return parsePullRequest(JSON.parse(result.stdout)); } catch { throw new GithubReleaseFailure("provider"); }
    },
    async markReadyForReview(input) { await run(["pr", "ready", String(input.number), "--repo", input.repository]); },
    async getPullRequest(input) {
      const result = await run(["pr", "view", String(input.number), "--repo", input.repository, "--json", "number,url,nameWithOwner,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,state,mergedAt"]);
      try { return parsePullRequest(JSON.parse(result.stdout)); } catch { throw new GithubReleaseFailure("provider"); }
    },
  };
}

export interface PublishReleaseInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  repositoryPath: string;
  repository: string;
  branchName: string;
  baseBranch: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
  reviewId: string;
  planSummary: string;
  deliverySummary: string;
  verificationSummary: string;
}

export interface PublishReleaseResult {
  releaseId: string;
  repository: string;
  branchName: string;
  headSha: string;
  headTree: string;
  pullRequest: GithubPullRequest;
  reused: boolean;
}

export class ReleaseService {
  constructor(private readonly database: ForgeDatabase, private readonly artifacts: ArtifactStore, private readonly github: GithubReleasePort) {}

  async publish(input: PublishReleaseInput): Promise<PublishReleaseResult> {
    await this.github.checkAuthentication();
    const remote = await this.github.getRemoteRepository({ cwd: input.repositoryPath });
    if (remote !== input.repository.toLowerCase()) throw new GithubReleaseFailure("wrong-remote");
    const review = this.database.authQuery((db) => db.prepare("SELECT outcome, base_sha, subject_commit, subject_tree FROM forge_delivery_reviews WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.reviewId, input.taskId, input.companyId, input.workflowId) as { outcome: string; base_sha: string; subject_commit: string; subject_tree: string } | undefined);
    if (!review || review.outcome !== "approved" || review.base_sha !== input.targetBaseSha || review.subject_commit !== input.subjectCommit || review.subject_tree !== input.subjectTree) throw new GithubReleaseFailure("stale-revision");
    const releaseKey = `${input.workflowId}:${input.baseBranch}:${input.subjectCommit}`;
    const existingRelease = this.database.authQuery((db) => db.prepare("SELECT id, pr_number, pr_url FROM forge_releases WHERE release_key = ?").get(releaseKey) as { id: string; pr_number: number | null; pr_url: string | null } | undefined);
    const title = sanitize(`Forge: ${input.taskId} ${input.planSummary}`).slice(0, 160);
    const body = sanitize([`Authorized plan: ${input.planSummary}`, `Reviewed revision: ${input.subjectCommit}`, `Reviewed tree: ${input.subjectTree}`, `Target base: ${input.targetBaseSha}`, `Delivery: ${input.deliverySummary}`, `Verification: ${input.verificationSummary}`].join("\n\n")).slice(0, 20_000);
    const bodyArtifact = await this.artifacts.put(input.companyId, "agent-evidence", { filename: `${input.taskId}-draft-pr.md`, mimeType: "text/markdown", bytes: Buffer.from(body, "utf8") });
    const insertArtifact = (): void => {
      this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(bodyArtifact.id, bodyArtifact.companyId, bodyArtifact.kind, bodyArtifact.filename, bodyArtifact.mimeType, bodyArtifact.byteSize, bodyArtifact.sha256, bodyArtifact.storagePath, bodyArtifact.createdAt));
    };
    insertArtifact();
    if (!existingRelease) await this.github.pushNormal({ cwd: input.repositoryPath, branch: input.branchName });
    const candidates = await this.github.listPullRequests({ repository: input.repository, headBranch: input.branchName, baseBranch: input.baseBranch });
    if (candidates.length > 1 || candidates.some((pr) => pr.repository.toLowerCase() !== input.repository.toLowerCase() || pr.headBranch !== input.branchName || pr.baseBranch !== input.baseBranch || !pr.isDraft)) throw new GithubReleaseFailure("ambiguous");
    let pullRequest = candidates[0];
    let reused = true;
    if (!pullRequest) { pullRequest = await this.github.createDraftPullRequest({ repository: input.repository, headBranch: input.branchName, baseBranch: input.baseBranch, title, body }); reused = false; }
    if (pullRequest.headSha.toLowerCase() !== input.subjectCommit.toLowerCase() || pullRequest.baseBranch !== input.baseBranch) throw new GithubReleaseFailure("stale-revision");
    const releaseRecordId = existingRelease?.id ?? newReleaseId();
    const now = new Date().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, body_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?) ON CONFLICT(release_key) DO UPDATE SET status = 'draft', pr_number = excluded.pr_number, pr_url = excluded.pr_url, head_sha = excluded.head_sha, head_tree = excluded.head_tree, body_artifact_id = excluded.body_artifact_id, updated_at = excluded.updated_at").run(releaseRecordId, input.taskId, input.companyId, input.workflowId, releaseKey, input.repository, input.branchName, input.baseBranch, input.targetBaseSha, input.subjectCommit, input.subjectTree, pullRequest.number, pullRequest.url, title, bodyArtifact.id, now, now));
    return { releaseId: releaseRecordId, repository: input.repository, branchName: input.branchName, headSha: input.subjectCommit, headTree: input.subjectTree, pullRequest, reused };
  }
}

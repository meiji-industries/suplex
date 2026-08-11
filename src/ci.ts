import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ForgeDatabase } from "./database.js";
import { ArtifactStore } from "./artifacts.js";
import { redact } from "./logging.js";

const execFileAsync = promisify(execFile);

export type CiOutcome = "waiting" | "passed" | "failed" | "cancelled" | "missing_required" | "provider_unavailable" | "rate_limited" | "stale_head" | "timed_out";

export interface CheckSnapshot {
  name: string;
  headSha: string;
  status: "queued" | "running" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | "neutral" | null;
  detailsUrl?: string;
  summary: string;
}

export interface CiProvider {
  listChecks(input: { repository: string; headSha: string }): Promise<CheckSnapshot[]>;
}

export function createGithubCiProvider(command = process.env.FORGE_GH_COMMAND ?? "gh"): CiProvider {
  return {
    async listChecks(input) {
      try {
        const result = await execFileAsync(command, ["api", `repos/${input.repository}/commits/${input.headSha}/check-runs`, "--paginate", "--slurp"], { timeout: 30_000, maxBuffer: 512 * 1024 });
        const parsed = JSON.parse(result.stdout) as unknown;
        const pages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ check_runs?: Array<Record<string, unknown>> }>;
        return pages.flatMap((payload) => payload.check_runs ?? []).flatMap((check): CheckSnapshot[] => {
          const name = typeof check.name === "string" ? check.name : "";
          const headSha = typeof check.head_sha === "string" ? check.head_sha : input.headSha;
          const status = check.status === "completed" ? "completed" : check.status === "in_progress" ? "running" : "queued";
          const rawConclusion = typeof check.conclusion === "string" ? check.conclusion : null;
          const conclusion = rawConclusion === "success" ? "success" : rawConclusion === "failure" ? "failure" : rawConclusion === "cancelled" ? "cancelled" : rawConclusion === "timed_out" ? "timed_out" : rawConclusion === "neutral" ? "neutral" : null;
          if (!name) return [];
          return [{ name, headSha, status, conclusion, ...(typeof check.html_url === "string" ? { detailsUrl: check.html_url } : {}), summary: `${status}${conclusion ? ` · ${conclusion}` : ""}` }];
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new CiFailure(/rate.?limit|secondary limit/i.test(message) ? "rate-limit" : "provider");
      }
    },
  };
}

export class CiFailure extends Error {
  constructor(readonly code: "provider" | "rate-limit") {
    super(`CI provider ${code}`);
    this.name = "CiFailure";
  }
}

export interface CiReconcileInput {
  taskId: string;
  companyId: string;
  releaseId: string;
  repository: string;
  expectedHeadSha: string;
  requiredChecks: string[];
  attempt?: number;
  now?: string;
  pollAfterMs?: number;
}

export interface CiReconcileResult {
  runId: string;
  outcome: CiOutcome;
  summary: string;
  nextPollAt: string | null;
  checks: CheckSnapshot[];
}

function id(): string { return `ci_${randomBytes(12).toString("hex")}`; }

export class CiService {
  constructor(private readonly database: ForgeDatabase, private readonly provider: CiProvider, private readonly artifacts?: ArtifactStore) {}

  async reconcile(input: CiReconcileInput): Promise<CiReconcileResult> {
    const now = input.now ?? new Date().toISOString();
    const release = this.database.authQuery((db) => db.prepare("SELECT id, task_id, company_id, repository, head_sha, base_branch FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ?").get(input.releaseId, input.taskId, input.companyId) as { id: string; task_id: string; company_id: string; repository: string; head_sha: string; base_branch: string } | undefined);
    if (!release || release.repository !== input.repository || release.head_sha.toLowerCase() !== input.expectedHeadSha.toLowerCase()) throw new CiFailure("provider");
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, attempt, status, next_poll_at, summary FROM forge_ci_runs WHERE release_id = ? AND expected_head_sha = ? ORDER BY attempt DESC LIMIT 1").get(input.releaseId, input.expectedHeadSha) as { id: string; attempt: number; status: CiOutcome; next_poll_at: string | null; summary: string } | undefined);
    const runId = existing?.id ?? id();
    const attempt = existing?.attempt ?? input.attempt ?? 1;
    if (existing?.status === "passed" && existing.next_poll_at === null) {
      const recordedChecks = new Set(this.database.authQuery((db) => (db.prepare("SELECT name FROM forge_ci_checks WHERE run_id = ?").all(existing.id) as Array<{ name: string }>).map((check) => check.name)));
      if (input.requiredChecks.every((name) => recordedChecks.has(name))) return { runId, outcome: "passed", summary: existing.summary, nextPollAt: null, checks: [] };
    }
    if ((input.attempt ?? 1) >= 120) return await this.persist(input, runId, attempt, "timed_out", "Required checks did not complete within the bounded CI wait window", [], now, null);
    let checks: CheckSnapshot[];
    try { checks = await this.provider.listChecks({ repository: input.repository, headSha: input.expectedHeadSha }); } catch (error) {
      const outcome: CiOutcome = error instanceof CiFailure && error.code === "rate-limit" ? "rate_limited" : "provider_unavailable";
      return await this.persist(input, runId, attempt, outcome, outcome === "rate_limited" ? "GitHub rate limit; waiting for the recorded retry time" : "GitHub checks are unavailable", [], now, outcome === "rate_limited" ? new Date(Date.parse(now) + (input.pollAfterMs ?? 60_000)).toISOString() : null);
    }
    if (checks.some((check) => check.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase())) return await this.persist(input, runId, attempt, "stale_head", "A check result belongs to a different pull-request head", checks, now, null);
    const byName = new Map(checks.map((check) => [check.name, check]));
    const missing = input.requiredChecks.filter((name) => !byName.has(name));
    if (missing.length) return await this.persist(input, runId, attempt, "missing_required", `Required checks are missing: ${missing.join(", ")}`, checks, now, null);
    const active = input.requiredChecks.map((name) => byName.get(name)!).filter((check) => check.status !== "completed");
    if (active.length) return await this.persist(input, runId, attempt, "waiting", "Required checks are queued or running", checks, now, new Date(Date.parse(now) + (input.pollAfterMs ?? 15_000)).toISOString());
    const failed = input.requiredChecks.map((name) => byName.get(name)!).filter((check) => check.conclusion !== "success");
    if (failed.length) return await this.persist(input, runId, attempt, failed.some((check) => check.conclusion === "timed_out") ? "timed_out" : failed.some((check) => check.conclusion === "cancelled") ? "cancelled" : "failed", `Required checks failed: ${failed.map((check) => check.name).join(", ")}`, checks, now, null);
    return await this.persist(input, runId, attempt, "passed", "All required checks passed on the exact pull-request head", checks, now, null);
  }

  private async persist(input: CiReconcileInput, runId: string, attempt: number, outcome: CiOutcome, summary: string, checks: CheckSnapshot[], now: string, nextPollAt: string | null): Promise<CiReconcileResult> {
    const boundedSummary = String(redact(summary)).slice(0, 2_000);
    const evidence = JSON.stringify({ expectedHeadSha: input.expectedHeadSha, requiredChecks: input.requiredChecks, outcome, checks: checks.map((check) => ({ name: check.name, headSha: check.headSha, status: check.status, conclusion: check.conclusion, detailsUrl: check.detailsUrl, summary: String(redact(check.summary)).slice(0, 500) })) });
    let evidenceArtifactId: string | undefined;
    if (this.artifacts) {
      const artifact = await this.artifacts.put(input.companyId, "ci-evidence", { filename: `${runId}-${attempt}.json`, mimeType: "application/json", bytes: Buffer.from(evidence, "utf8") });
      evidenceArtifactId = artifact.id;
      this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt));
    }
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_ci_runs (id, task_id, company_id, release_id, expected_head_sha, status, next_poll_at, attempt, summary, evidence_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, next_poll_at = excluded.next_poll_at, summary = excluded.summary, evidence_artifact_id = excluded.evidence_artifact_id, updated_at = excluded.updated_at").run(runId, input.taskId, input.companyId, input.releaseId, input.expectedHeadSha, outcome, nextPollAt, attempt, boundedSummary, evidenceArtifactId ?? null, now, now);
      for (const check of checks) db.prepare("INSERT INTO forge_ci_checks (id, run_id, name, head_sha, status, conclusion, details_url, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, name) DO UPDATE SET head_sha = excluded.head_sha, status = excluded.status, conclusion = excluded.conclusion, details_url = excluded.details_url, summary = excluded.summary").run(`${runId}_${check.name.replace(/[^A-Za-z0-9]/g, "_").slice(0, 80)}`, runId, check.name, check.headSha, check.status, check.conclusion, check.detailsUrl ?? null, String(redact(check.summary)).slice(0, 2_000), now);
      db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, kind, status, result_json, retry_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'ci-reconcile', ?, ?, ?, ?, ?) ON CONFLICT(operation_key) DO UPDATE SET status = excluded.status, result_json = excluded.result_json, retry_at = excluded.retry_at, updated_at = excluded.updated_at").run(`provider_${randomBytes(12).toString("hex")}`, `${input.taskId}:ci:${input.releaseId}:${input.expectedHeadSha}`, input.taskId, input.companyId, outcome, JSON.stringify({ runId, outcome, summary: boundedSummary, evidence }), nextPollAt, now, now);
    });
    return { runId, outcome, summary: boundedSummary, nextPollAt, checks };
  }
}

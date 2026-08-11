import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ForgeDatabase } from "./database.js";

const execFileAsync = promisify(execFile);

export type CiOutcome = "waiting" | "passed" | "failed" | "missing_required" | "provider_unavailable" | "rate_limited" | "stale_head" | "timed_out";

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
  constructor(private readonly database: ForgeDatabase, private readonly provider: CiProvider) {}

  async reconcile(input: CiReconcileInput): Promise<CiReconcileResult> {
    const now = input.now ?? new Date().toISOString();
    const release = this.database.authQuery((db) => db.prepare("SELECT id, task_id, company_id, repository, head_sha FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ?").get(input.releaseId, input.taskId, input.companyId) as { id: string; task_id: string; company_id: string; repository: string; head_sha: string } | undefined);
    if (!release || release.repository !== input.repository || release.head_sha.toLowerCase() !== input.expectedHeadSha.toLowerCase()) throw new CiFailure("provider");
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, attempt FROM forge_ci_runs WHERE release_id = ? AND expected_head_sha = ? ORDER BY attempt DESC LIMIT 1").get(input.releaseId, input.expectedHeadSha) as { id: string; attempt: number } | undefined);
    const runId = existing?.id ?? id();
    const attempt = existing?.attempt ?? input.attempt ?? 1;
    let checks: CheckSnapshot[];
    try { checks = await this.provider.listChecks({ repository: input.repository, headSha: input.expectedHeadSha }); } catch (error) {
      const outcome: CiOutcome = error instanceof CiFailure && error.code === "rate-limit" ? "rate_limited" : "provider_unavailable";
      return this.persist(input, runId, attempt, outcome, outcome === "rate_limited" ? "GitHub rate limit; waiting for the recorded retry time" : "GitHub checks are unavailable", [], now, outcome === "rate_limited" ? new Date(Date.parse(now) + (input.pollAfterMs ?? 60_000)).toISOString() : null);
    }
    if (checks.some((check) => check.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase())) return this.persist(input, runId, attempt, "stale_head", "A check result belongs to a different pull-request head", checks, now, null);
    const byName = new Map(checks.map((check) => [check.name, check]));
    const missing = input.requiredChecks.filter((name) => !byName.has(name));
    if (missing.length) return this.persist(input, runId, attempt, "missing_required", `Required checks are missing: ${missing.join(", ")}`, checks, now, null);
    const active = input.requiredChecks.map((name) => byName.get(name)!).filter((check) => check.status !== "completed");
    if (active.length) return this.persist(input, runId, attempt, "waiting", "Required checks are queued or running", checks, now, new Date(Date.parse(now) + (input.pollAfterMs ?? 15_000)).toISOString());
    const failed = input.requiredChecks.map((name) => byName.get(name)!).filter((check) => check.conclusion !== "success");
    if (failed.length) return this.persist(input, runId, attempt, failed.some((check) => check.conclusion === "timed_out") ? "timed_out" : "failed", `Required checks failed: ${failed.map((check) => check.name).join(", ")}`, checks, now, null);
    return this.persist(input, runId, attempt, "passed", "All required checks passed on the exact pull-request head", checks, now, null);
  }

  private persist(input: CiReconcileInput, runId: string, attempt: number, outcome: CiOutcome, summary: string, checks: CheckSnapshot[], now: string, nextPollAt: string | null): CiReconcileResult {
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_ci_runs (id, task_id, company_id, release_id, expected_head_sha, status, next_poll_at, attempt, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, next_poll_at = excluded.next_poll_at, summary = excluded.summary, updated_at = excluded.updated_at").run(runId, input.taskId, input.companyId, input.releaseId, input.expectedHeadSha, outcome, nextPollAt, attempt, summary, now, now);
      for (const check of checks) db.prepare("INSERT INTO forge_ci_checks (id, run_id, name, head_sha, status, conclusion, details_url, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, name) DO UPDATE SET head_sha = excluded.head_sha, status = excluded.status, conclusion = excluded.conclusion, details_url = excluded.details_url, summary = excluded.summary").run(`${runId}_${check.name.replace(/[^A-Za-z0-9]/g, "_").slice(0, 80)}`, runId, check.name, check.headSha, check.status, check.conclusion, check.detailsUrl ?? null, check.summary.slice(0, 2_000), now);
    });
    return { runId, outcome, summary, nextPollAt, checks };
  }
}

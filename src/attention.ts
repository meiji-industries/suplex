import { createHash } from "node:crypto";

import { AuthService } from "./auth.js";
import type { ForgeDatabase } from "./database.js";

export type AttentionCategory =
  | "member_decision"
  | "agent_contradiction"
  | "unsafe_recovery"
  | "provider_ambiguity"
  | "provider_authentication"
  | "verification_blocked"
  | "target_drift"
  | "capacity_exhausted";

export interface AttentionItem {
  id: string;
  companyId: string;
  taskId: string;
  taskTitle: string;
  category: AttentionCategory;
  summary: string;
  action: string;
  evidenceRef?: string;
  updatedAt: string;
}

export interface RecentOutcome {
  taskId: string;
  taskTitle: string;
  phase: string;
  updatedAt: string;
}

export interface CompanyAttentionOverview {
  companyId: string;
  companyName: string;
  companyStatus: string;
  activeIssueCount: number;
  phases: Record<string, number>;
  attentionCount: number;
  attention: AttentionItem[];
  recentOutcomes: RecentOutcome[];
}

interface ProjectionRow {
  task_id: string;
  task_title: string;
  company_id: string;
  phase: string;
  allowed_commands_json: string;
  updated_at: string;
}

interface AttentionCandidate {
  taskId: string;
  category: AttentionCategory;
  summary: string;
  action: string;
  evidenceRef?: string;
}

function parseCommands(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function itemId(companyId: string, taskId: string, category: AttentionCategory): string {
  return `attention_${createHash("sha256").update(`${companyId}:${taskId}:${category}`).digest("hex").slice(0, 24)}`;
}

function candidateFor(database: ForgeDatabase, row: ProjectionRow): AttentionCandidate | undefined {
  const commands = parseCommands(row.allowed_commands_json);
  if (row.phase === "ready_reconciliation" && commands.includes("reconcile_acceptance")) {
    return { taskId: row.task_id, category: "provider_ambiguity", summary: "Forge is reconciling the accepted pull request's ready-for-review state.", action: "Inspect the exact pull request state and retry ready reconciliation when the provider is available." };
  }
  if (row.phase === "delivery_blocked" && commands.includes("record_delivery_decision")) {
    return { taskId: row.task_id, category: "member_decision", summary: "A member decision is required before this issue can continue.", action: "Review the exact delivery evidence and record a decision." };
  }

  const lease = database.authQuery((db) => db.prepare("SELECT status, failure_code, failure_summary FROM forge_developer_execution_leases WHERE task_id = ? ORDER BY attempt DESC, created_at DESC LIMIT 1").get(row.task_id) as { status: string; failure_code: string | null; failure_summary: string | null } | undefined);
  if (lease?.status === "ownership_ambiguous") {
    return { taskId: row.task_id, category: "unsafe_recovery", summary: "Forge cannot prove which process owns the Developer turn.", action: "Inspect the host process and worktree, then recheck ownership.", ...(lease.failure_code ? { evidenceRef: lease.failure_code } : {}) };
  }
  if (lease?.status === "interrupted" || lease?.status === "failed") {
    return { taskId: row.task_id, category: "unsafe_recovery", summary: lease.failure_summary ?? "The Developer turn needs deliberate recovery.", action: "Review the preserved evidence before retrying or cancelling.", ...(lease.failure_code ? { evidenceRef: lease.failure_code } : {}) };
  }

  const execution = database.authQuery((db) => db.prepare("SELECT status, failure_code, failure_summary FROM forge_developer_executions WHERE task_id = ? ORDER BY attempt DESC, started_at DESC LIMIT 1").get(row.task_id) as { status: string; failure_code: string | null; failure_summary: string | null } | undefined);
  if (execution?.status === "ownership_ambiguous" || execution?.status === "interrupted" || execution?.status === "failed") {
    return { taskId: row.task_id, category: "unsafe_recovery", summary: execution.failure_summary ?? "The Developer turn needs deliberate recovery.", action: "Review the preserved evidence before retrying or cancelling.", ...(execution.failure_code ? { evidenceRef: execution.failure_code } : {}) };
  }

  const review = database.authQuery((db) => db.prepare("SELECT outcome, repair_cycle FROM forge_delivery_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(row.task_id) as { outcome: string; repair_cycle: number } | undefined);
  if (row.phase === "repair_required" && review?.outcome === "blocking") {
    return { taskId: row.task_id, category: "agent_contradiction", summary: "The exact delivery review found blocking work that the agent has not resolved.", action: "Inspect the bounded findings and repair only the reviewed revision.", evidenceRef: `review-cycle-${review.repair_cycle}` };
  }

  if (row.phase === "merge_conflict_required") {
    return { taskId: row.task_id, category: "target_drift", summary: "Target-base drift produced a forward-merge conflict that requires the Lead plan and Developer resolution.", action: "Review the recorded conflict plan and resolve the merge in the owned issue worktree." };
  }

  const release = database.authQuery((db) => db.prepare("SELECT status FROM forge_releases WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1").get(row.task_id) as { status: string } | undefined);
  const releaseGuidance: Record<string, AttentionCandidate | undefined> = {
    "authentication-required": { taskId: row.task_id, category: "provider_authentication", summary: "GitHub authentication is unavailable for this release.", action: "Re-authenticate the host GitHub CLI, then retry publication." },
    "stale-reviewed-revision": { taskId: row.task_id, category: "agent_contradiction", summary: "The approved review no longer matches the exact Developer revision.", action: "Run a fresh delivery review before publishing." },
    "target-base-drift": { taskId: row.task_id, category: "target_drift", summary: "The pinned target base moved before publication.", action: "Reconcile the target base with the guarded forward-merge flow." },
    "wrong-remote": { taskId: row.task_id, category: "provider_ambiguity", summary: "The local origin does not match the pinned GitHub repository.", action: "Correct the repository configuration, then retry publication." },
    "pinned-configuration-incomplete": { taskId: row.task_id, category: "provider_ambiguity", summary: "The accepted project revision is missing release configuration.", action: "Create a complete accepted project revision before retrying publication." },
    "public-projection-unsafe": { taskId: row.task_id, category: "provider_ambiguity", summary: "The release preview contains content that cannot be published safely.", action: "Remove the unsafe public projection input and retry after review." },
    "remote-head-conflict": { taskId: row.task_id, category: "provider_ambiguity", summary: "The remote issue branch points to a different commit.", action: "Inspect the remote branch and reconcile it before retrying publication." },
    "ambiguous-provider-state": { taskId: row.task_id, category: "provider_ambiguity", summary: "GitHub returned contradictory draft pull-request state.", action: "Inspect the matching branch and pull requests before retrying publication." },
    "invalid-provider-response": { taskId: row.task_id, category: "provider_ambiguity", summary: "GitHub returned an invalid release observation.", action: "Verify GitHub availability and retry publication." },
    "provider-unavailable": { taskId: row.task_id, category: "provider_ambiguity", summary: "GitHub release state could not be confirmed.", action: "Inspect the remote branch and pull requests before retrying publication." },
  };
  if (release?.status === "provider-rate-limited") {
    // Durable Workflow retry state is truthful, but it is not a human attention item.
  } else if (release?.status && releaseGuidance[release.status]) {
    return releaseGuidance[release.status];
  } else if (release?.status === "ambiguous" || release?.status === "provider_unavailable") {
    return { taskId: row.task_id, category: "provider_ambiguity", summary: "GitHub release state needs operator reconciliation.", action: "Inspect the existing branch and pull requests before retrying provider mutation." };
  } else if (release?.status === "authentication") {
    return { taskId: row.task_id, category: "provider_authentication", summary: "GitHub authentication is unavailable for this release.", action: "Re-authenticate the host GitHub CLI, then retry the Workflow update." };
  }

  const ci = database.authQuery((db) => db.prepare("SELECT status, summary FROM forge_ci_runs WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1").get(row.task_id) as { status: string; summary: string } | undefined);
  if (ci && ["missing_required", "failed", "timed_out", "provider_unavailable"].includes(ci.status)) {
    return { taskId: row.task_id, category: "verification_blocked", summary: ci.summary || "Required verification is blocked.", action: "Inspect the exact-head checks and resolve the verification blocker." };
  }
  if (ci?.status === "stale_head") {
    return { taskId: row.task_id, category: "target_drift", summary: "Verification observed a different commit than the reviewed release.", action: "Reconcile the target branch by a guarded forward merge before rerunning verification." };
  }
  const queuedCapacity = database.authQuery((db) => db.prepare("SELECT requested_at FROM forge_capacity_requests WHERE task_id = ? AND status = 'queued' ORDER BY requested_at LIMIT 1").get(row.task_id) as { requested_at: string } | undefined);
  if (queuedCapacity && Date.now() - Date.parse(queuedCapacity.requested_at) > 5 * 60_000) {
    return { taskId: row.task_id, category: "capacity_exhausted", summary: "The issue has waited for an external turn longer than the operator threshold.", action: "Review active external turns and capacity before retrying." };
  }
  return undefined;
}

export class AttentionService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService) {}

  rebuildAll(): number {
    const companies = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_companies").all() as Array<{ id: string }>);
    for (const company of companies) this.rebuild(company.id);
    return companies.length;
  }

  rebuild(companyId: string): void {
    this.database.authTransaction((db) => {
      const rows = db.prepare(`SELECT ip.task_id, t.title AS task_title, ip.company_id, ip.phase, ip.allowed_commands_json, ip.updated_at
        FROM forge_issue_projections ip JOIN forge_tasks t ON t.id = ip.task_id
        WHERE ip.company_id = ? ORDER BY ip.updated_at, ip.task_id`).all(companyId) as ProjectionRow[];
      const activeIds = new Set<string>();
      for (const row of rows) {
        const candidate = candidateFor(this.database, row);
        if (!candidate) continue;
        const id = itemId(companyId, candidate.taskId, candidate.category);
        activeIds.add(id);
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO forge_attention_items (id, company_id, task_id, category, summary, action, evidence_ref, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, action = excluded.action, evidence_ref = excluded.evidence_ref, active = 1, updated_at = excluded.updated_at`).run(
          id, companyId, candidate.taskId, candidate.category, candidate.summary, candidate.action, candidate.evidenceRef ?? null, now, now,
        );
      }
      const existing = db.prepare("SELECT id FROM forge_attention_items WHERE company_id = ? AND active = 1").all(companyId) as Array<{ id: string }>;
      for (const item of existing) {
        if (!activeIds.has(item.id)) db.prepare("UPDATE forge_attention_items SET active = 0, updated_at = ? WHERE id = ? AND active = 1").run(new Date().toISOString(), item.id);
      }
    });
  }

  list(actorUserId: string): CompanyAttentionOverview[] {
    const companies = this.auth.listVisibleCompanies(actorUserId);
    return companies.map((company) => {
      this.rebuild(company.id);
      return this.database.authQuery((db) => {
        const rows = db.prepare(`SELECT ip.task_id, t.title AS task_title, ip.company_id, ip.phase, ip.allowed_commands_json, ip.updated_at
          FROM forge_issue_projections ip JOIN forge_tasks t ON t.id = ip.task_id WHERE ip.company_id = ? ORDER BY ip.updated_at, ip.task_id`).all(company.id) as ProjectionRow[];
        const activePhases = new Set(["backlog", "planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge"]);
        const phases: Record<string, number> = {};
        for (const row of rows) if (activePhases.has(row.phase)) phases[row.phase] = (phases[row.phase] ?? 0) + 1;
        const attentionRows = db.prepare(`SELECT ai.id, ai.company_id, ai.task_id, t.title AS task_title, ai.category, ai.summary, ai.action, ai.evidence_ref, ai.updated_at
          FROM forge_attention_items ai JOIN forge_tasks t ON t.id = ai.task_id WHERE ai.company_id = ? AND ai.active = 1
          ORDER BY CASE ai.category WHEN 'member_decision' THEN 0 WHEN 'agent_contradiction' THEN 1 WHEN 'unsafe_recovery' THEN 2 WHEN 'provider_authentication' THEN 3 WHEN 'provider_ambiguity' THEN 4 WHEN 'verification_blocked' THEN 5 WHEN 'target_drift' THEN 6 WHEN 'capacity_exhausted' THEN 7 ELSE 8 END, ai.updated_at DESC, ai.id`).all(company.id) as Array<{ id: string; company_id: string; task_id: string; task_title: string; category: AttentionCategory; summary: string; action: string; evidence_ref: string | null; updated_at: string }>;
        const terminalRows = db.prepare(`SELECT t.id AS task_id, t.title AS task_title, ip.phase, ip.updated_at FROM forge_tasks t JOIN forge_issue_projections ip ON ip.task_id = t.id
          WHERE t.company_id = ? AND ip.phase IN ('accepted', 'manual_merge', 'done', 'cancelled', 'failed', 'delivery_blocked') ORDER BY ip.updated_at DESC, t.id DESC LIMIT 5`).all(company.id) as RecentOutcome[];
        return {
          companyId: company.id,
          companyName: company.name,
          companyStatus: company.status,
          activeIssueCount: rows.filter((row) => activePhases.has(row.phase)).length,
          phases,
          attentionCount: attentionRows.length,
          attention: attentionRows.map((item) => ({ id: item.id, companyId: item.company_id, taskId: item.task_id, taskTitle: item.task_title, category: item.category, summary: item.summary, action: item.action, ...(item.evidence_ref ? { evidenceRef: item.evidence_ref } : {}), updatedAt: item.updated_at })),
          recentOutcomes: terminalRows,
        };
      });
    });
  }

  get(actorUserId: string, taskId: string): AttentionItem[] {
    const task = this.database.authQuery((db) => db.prepare("SELECT company_id FROM forge_tasks WHERE id = ?").get(taskId) as { company_id: string } | undefined);
    if (!task) return [];
    this.auth.requireCompanyAccess(actorUserId, task.company_id);
    this.rebuild(task.company_id);
    return this.database.authQuery((db) => db.prepare(`SELECT ai.id, ai.company_id, ai.task_id, t.title AS task_title, ai.category, ai.summary, ai.action, ai.evidence_ref, ai.updated_at
      FROM forge_attention_items ai JOIN forge_tasks t ON t.id = ai.task_id WHERE ai.task_id = ? AND ai.active = 1 ORDER BY ai.updated_at, ai.id`).all(taskId).map((item) => {
      const row = item as { id: string; company_id: string; task_id: string; task_title: string; category: AttentionCategory; summary: string; action: string; evidence_ref: string | null; updated_at: string };
      return { id: row.id, companyId: row.company_id, taskId: row.task_id, taskTitle: row.task_title, category: row.category, summary: row.summary, action: row.action, ...(row.evidence_ref ? { evidenceRef: row.evidence_ref } : {}), updatedAt: row.updated_at };
    }));
  }
}

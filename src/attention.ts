import { createHash } from "node:crypto";

import { AuthService } from "./auth.js";
import type { ForgeDatabase } from "./database.js";

export type AttentionCategory =
  | "member_decision"
  | "agent_contradiction"
  | "unsafe_recovery"
  | "provider_ambiguity"
  | "verification_blocked"
  | "target_drift";

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
  if (row.phase === "delivery_blocked" && commands.includes("record_delivery_decision")) {
    return { taskId: row.task_id, category: "member_decision", summary: "A member decision is required before this issue can continue.", action: "Review the exact delivery evidence and record a decision." };
  }

  const execution = database.authQuery((db) => db.prepare("SELECT status, failure_code, failure_summary FROM forge_developer_executions WHERE task_id = ? ORDER BY attempt DESC, started_at DESC LIMIT 1").get(row.task_id) as { status: string; failure_code: string | null; failure_summary: string | null } | undefined);
  if (execution?.status === "ownership_ambiguous") {
    return { taskId: row.task_id, category: "unsafe_recovery", summary: "Forge cannot prove which process owns the Developer turn.", action: "Verify the recorded process and worktree ownership before retrying or cancelling.", ...(execution.failure_code ? { evidenceRef: execution.failure_code } : {}) };
  }

  const review = database.authQuery((db) => db.prepare("SELECT outcome, repair_cycle FROM forge_delivery_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(row.task_id) as { outcome: string; repair_cycle: number } | undefined);
  if (row.phase === "repair_required" && review?.outcome === "blocking") {
    return { taskId: row.task_id, category: "agent_contradiction", summary: "The exact delivery review found blocking work that the agent has not resolved.", action: "Inspect the bounded findings and repair only the reviewed revision.", evidenceRef: `review-cycle-${review.repair_cycle}` };
  }

  const release = database.authQuery((db) => db.prepare("SELECT status FROM forge_releases WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1").get(row.task_id) as { status: string } | undefined);
  if (release?.status === "ambiguous" || release?.status === "provider_unavailable") {
    return { taskId: row.task_id, category: "provider_ambiguity", summary: "GitHub release state needs operator reconciliation.", action: "Inspect the existing branch and pull requests before retrying provider mutation." };
  }

  const ci = database.authQuery((db) => db.prepare("SELECT status, summary FROM forge_ci_runs WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1").get(row.task_id) as { status: string; summary: string } | undefined);
  if (ci && ["missing_required", "failed", "timed_out", "provider_unavailable"].includes(ci.status)) {
    return { taskId: row.task_id, category: "verification_blocked", summary: ci.summary || "Required verification is blocked.", action: "Inspect the exact-head checks and resolve the verification blocker." };
  }
  if (ci?.status === "stale_head") {
    return { taskId: row.task_id, category: "target_drift", summary: "Verification observed a different commit than the reviewed release.", action: "Reconcile the target branch by a guarded forward merge before rerunning verification." };
  }
  return undefined;
}

export class AttentionService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService) {}

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
        const activePhases = new Set(["backlog", "planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required"]);
        const phases: Record<string, number> = {};
        for (const row of rows) if (activePhases.has(row.phase)) phases[row.phase] = (phases[row.phase] ?? 0) + 1;
        const attentionRows = db.prepare(`SELECT ai.id, ai.company_id, ai.task_id, t.title AS task_title, ai.category, ai.summary, ai.action, ai.evidence_ref, ai.updated_at
          FROM forge_attention_items ai JOIN forge_tasks t ON t.id = ai.task_id WHERE ai.company_id = ? AND ai.active = 1
          ORDER BY ai.updated_at, ai.id`).all(company.id) as Array<{ id: string; company_id: string; task_id: string; task_title: string; category: AttentionCategory; summary: string; action: string; evidence_ref: string | null; updated_at: string }>;
        const terminalRows = db.prepare(`SELECT t.id AS task_id, t.title AS task_title, ip.phase, ip.updated_at FROM forge_tasks t JOIN forge_issue_projections ip ON ip.task_id = t.id
          WHERE t.company_id = ? AND ip.phase IN ('delivery_reviewed', 'delivery_blocked') ORDER BY ip.updated_at DESC, t.id DESC LIMIT 5`).all(company.id) as RecentOutcome[];
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

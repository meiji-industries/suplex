import { AuthService, AuthFailure } from "./auth.js";
import { ArtifactStore, SAFE_ARTIFACT_KINDS, SAFE_ARTIFACT_KINDS_SQL } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import { redact } from "./logging.js";
import { ATTENTION_CATEGORY_SEVERITY, attentionId } from "./attention-policy.js";
import { AttentionCategorySchema, IssueBlockerActionSchema, type AttentionCategory, type IssueCommand } from "./temporal/issue-contracts.js";
import { ATTENTION_ACTIVE_PHASES, type IssuePhase } from "./issue-phases.js";

export const RECENT_OUTCOME_LIMIT = 5;
export const RECENT_OUTCOME_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const ACTIVE_PHASES = ATTENTION_ACTIVE_PHASES;
const TERMINAL_PHASES = new Set(["done", "cancelled", "failed"]);
const REDACTED_EVIDENCE_KEYS = new Set(["prompt", "transcript", "rawlog", "stdout", "stderr", "repositorypath", "worktreepath", "sessionref", "authorization", "cookie", "token", "secret", "credential"]);

export interface AttentionAction {
  command: IssueCommand;
  label: string;
  expectedRevision: number;
  requiresNote: boolean;
  destructive: boolean;
}

export interface AttentionEvidenceDescriptor {
  artifactId: string;
  sha256: string;
  kind: string;
  mimeType: string;
  byteSize: number;
  href: string;
}

export interface ProjectionHealth {
  projectedRevision: number;
  sourceRevision: number;
  projectedAt: string;
  stateChangedAt: string | null;
  reconciledAt: string | null;
  status: "current" | "stale" | "unknown";
  lagMs: number;
}

export interface AttentionItem {
  id: string;
  companyId: string;
  taskId: string;
  issueKey: string | null;
  taskTitle: string;
  category: AttentionCategory;
  summary: string;
  sourceRevision: number;
  activatedAt: string;
  actions: AttentionAction[];
  evidence: AttentionEvidenceDescriptor;
}

export interface RecentOutcome {
  taskId: string;
  issueKey: string | null;
  taskTitle: string;
  phase: IssuePhase;
  updatedAt: string;
  sourceRevision?: number;
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
  projectionHealth: ProjectionHealth;
}

interface ProjectionRow {
  task_id: string;
  task_title: string;
  company_id: string;
  phase: string;
  revision: number;
  authoritative_revision: number;
  allowed_commands_json: string;
  pending_action: string | null;
  updated_at: string;
  projected_at: string;
  state_changed_at: string | null;
  projection_status: string;
  reconciled_at: string | null;
}

interface AttentionRow {
  id: string;
  company_id: string;
  task_id: string;
  issue_key: string | null;
  task_title: string;
  category: string;
  summary: string;
  source_revision: number;
  activated_at: string | null;
  actions_json: string;
  evidence_artifact_id: string | null;
  evidence_sha256: string | null;
  mime_type: string;
  byte_size: number;
  kind: string;
}

interface RecentOutcomeRow {
  task_id: string;
  issue_key: string | null;
  task_title: string;
  phase: string;
  updated_at: string;
  source_revision: number;
}

function parseActions(raw: string, expectedRevision: number): AttentionAction[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  const actions = IssueBlockerActionSchema.array().safeParse(parsed);
  if (!actions.success) return undefined;
  return actions.data.map((action) => ({ ...action, expectedRevision }));
}

function health(row: ProjectionRow, now: number): ProjectionHealth {
  const projectedAtMs = Date.parse(row.projected_at);
  const lagMs = Number.isFinite(projectedAtMs) ? Math.max(0, now - projectedAtMs) : 0;
  const status = row.projection_status === "unknown"
    ? "unknown"
    : row.authoritative_revision > row.revision || (!TERMINAL_PHASES.has(row.phase) && lagMs > 30_000)
      ? "stale"
      : "current";
  return { projectedRevision: row.revision, sourceRevision: row.authoritative_revision, projectedAt: row.projected_at, stateChangedAt: row.state_changed_at, reconciledAt: row.reconciled_at, status, lagMs };
}

function safeEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeEvidenceValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !REDACTED_EVIDENCE_KEYS.has(key.toLowerCase())).map(([key, entry]) => [key, safeEvidenceValue(entry)]));
  }
  return redact(value);
}

function safeEvidenceText(value: string): string {
  return String(redact(value)).replace(/("(?:prompt|transcript|rawlog|stdout|stderr|repositorypath|worktreepath|sessionref|authorization|cookie|token|secret|credential)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,}\n]*)/gi, '$1"[redacted]"');
}

function safeNotFound(): never {
  throw new AuthFailure("Not found", 404);
}

export class AttentionService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly artifacts?: ArtifactStore, private readonly now: () => Date = () => new Date()) {}

  list(actorUserId: string): CompanyAttentionOverview[] {
    const now = this.now().getTime();
    const companies = this.auth.listVisibleCompanies(actorUserId);
    const rows = (companyId: string): ProjectionRow[] => this.database.authQuery((db) => db.prepare(`SELECT ip.task_id, t.title AS task_title, ip.company_id, ip.phase, ip.revision, ip.authoritative_revision, ip.allowed_commands_json, ip.pending_action, ip.updated_at, ip.projected_at, ip.state_changed_at, ip.projection_status, ip.reconciled_at
      FROM forge_issue_projections ip JOIN forge_tasks t ON t.id = ip.task_id WHERE ip.company_id = ? ORDER BY ip.task_id`).all(companyId) as ProjectionRow[]);
    const readAttention = (companyId: string): AttentionRow[] => this.database.authQuery((db) => db.prepare(`SELECT ai.id, ai.company_id, ai.task_id, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issue_key, t.title AS task_title, ai.category, ai.summary, ai.source_revision, ai.activated_at, ai.actions_json, ai.evidence_artifact_id, ai.evidence_sha256, a.mime_type, a.byte_size, a.kind
      FROM forge_attention_items ai JOIN forge_tasks t ON t.id = ai.task_id JOIN forge_companies c ON c.id = ai.company_id JOIN forge_artifacts a ON a.id = ai.evidence_artifact_id AND a.company_id = ai.company_id AND a.sha256 = ai.evidence_sha256
      WHERE ai.company_id = ? AND ai.active = 1 AND a.kind IN (${SAFE_ARTIFACT_KINDS_SQL})
      ORDER BY ai.activated_at ASC, ai.id ASC`).all(companyId) as AttentionRow[]);
    const result = companies.map((company) => {
      const projectionRows = rows(company.id);
      const activeRows = projectionRows.filter((row) => ACTIVE_PHASES.has(row.phase));
      const phases: Record<string, number> = {};
      for (const row of activeRows) phases[row.phase] = (phases[row.phase] ?? 0) + 1;
      const attention = readAttention(company.id).flatMap((row) => this.publicAttention(row));
      const recentOutcomes = this.database.authQuery((db) => db.prepare(`SELECT ip.task_id, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issue_key, t.title AS task_title, ip.phase, ip.state_changed_at AS updated_at, ip.revision AS source_revision
        FROM forge_issue_projections ip JOIN forge_tasks t ON t.id = ip.task_id JOIN forge_companies c ON c.id = ip.company_id WHERE ip.company_id = ? AND ip.phase IN ('done', 'cancelled', 'failed') AND ip.state_changed_at IS NOT NULL`).all(company.id) as RecentOutcomeRow[])
        .map((row): RecentOutcome => ({ taskId: row.task_id, issueKey: row.issue_key, taskTitle: row.task_title, phase: row.phase as IssuePhase, updatedAt: row.updated_at, sourceRevision: row.source_revision }))
        .filter((row) => Date.parse(row.updatedAt) >= now - RECENT_OUTCOME_WINDOW_MS)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) * -1 || left.taskId.localeCompare(right.taskId))
        .slice(0, RECENT_OUTCOME_LIMIT);
      const healthRows = projectionRows.map((row) => health(row, now));
      const projectionHealth = healthRows.reduce((worst, current) => current.status === "unknown" || (current.status === "stale" && worst.status === "current") ? current : worst, healthRows[0] ?? { projectedRevision: 0, sourceRevision: 0, projectedAt: "", stateChangedAt: null, reconciledAt: null, status: "unknown" as const, lagMs: 0 });
      const latestStateChangedAt = healthRows.map((row) => row.stateChangedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
      return { companyId: company.id, companyName: company.name, companyStatus: company.status, activeIssueCount: activeRows.length, phases, attentionCount: attention.length, attention, recentOutcomes, projectionHealth: { ...projectionHealth, stateChangedAt: latestStateChangedAt ?? projectionHealth.stateChangedAt } };
    });
    return result.sort((left, right) => {
      if (left.attentionCount || right.attentionCount) {
        return right.attentionCount - left.attentionCount
          || this.categoryRank(left) - this.categoryRank(right)
          || this.oldestAttention(left).localeCompare(this.oldestAttention(right))
          || left.companyId.localeCompare(right.companyId);
      }
      if (left.activeIssueCount || right.activeIssueCount) return (right.projectionHealth.stateChangedAt ?? "").localeCompare(left.projectionHealth.stateChangedAt ?? "") || left.companyId.localeCompare(right.companyId);
      return (right.recentOutcomes[0]?.updatedAt ?? "").localeCompare(left.recentOutcomes[0]?.updatedAt ?? "") || left.companyId.localeCompare(right.companyId);
    });
  }

  get(actorUserId: string, taskId: string): AttentionItem[] {
    const task = this.database.authQuery((db) => db.prepare("SELECT company_id FROM forge_tasks WHERE id = ?").get(taskId) as { company_id: string } | undefined);
    if (!task) safeNotFound();
    this.auth.requireCompanyAccess(actorUserId, task.company_id);
    return this.database.authQuery((db) => db.prepare(`SELECT ai.id, ai.company_id, ai.task_id, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issue_key, t.title AS task_title, ai.category, ai.summary, ai.source_revision, ai.activated_at, ai.actions_json, ai.evidence_artifact_id, ai.evidence_sha256, a.mime_type, a.byte_size, a.kind
      FROM forge_attention_items ai JOIN forge_tasks t ON t.id = ai.task_id JOIN forge_companies c ON c.id = ai.company_id JOIN forge_artifacts a ON a.id = ai.evidence_artifact_id AND a.company_id = ai.company_id AND a.sha256 = ai.evidence_sha256
      WHERE ai.task_id = ? AND ai.company_id = ? AND ai.active = 1 AND a.kind IN (${SAFE_ARTIFACT_KINDS_SQL}) ORDER BY ai.activated_at, ai.id`).all(taskId, task.company_id).flatMap((item) => this.publicAttention(item as AttentionRow)));
  }

  async evidence(actorUserId: string, attentionId: string): Promise<{ artifactId: string; sha256: string; kind: string; content: string; truncated: boolean }> {
    const row = this.database.authQuery((db) => db.prepare("SELECT company_id, evidence_artifact_id, evidence_sha256 FROM forge_attention_items WHERE id = ? AND active = 1").get(attentionId) as { company_id: string; evidence_artifact_id: string | null; evidence_sha256: string | null } | undefined);
    if (!row?.evidence_artifact_id || !row.evidence_sha256) safeNotFound();
    this.auth.requireCompanyAccess(actorUserId, row.company_id);
    const artifact = this.database.authQuery((db) => db.prepare(`SELECT id, company_id, kind, mime_type, byte_size, sha256, storage_path FROM forge_artifacts WHERE id = ? AND company_id = ? AND sha256 = ? AND kind IN (${SAFE_ARTIFACT_KINDS_SQL})`).get(row.evidence_artifact_id, row.company_id, row.evidence_sha256) as { id: string; company_id: string; kind: string; mime_type: string; byte_size: number; sha256: string; storage_path: string } | undefined);
    if (!artifact || !/^(text\/(plain|markdown)|application\/json)(;|$)/i.test(artifact.mime_type) || !SAFE_ARTIFACT_KINDS.includes(artifact.kind as typeof SAFE_ARTIFACT_KINDS[number]) || !this.artifacts) safeNotFound();
    let capture: { bytes: Buffer; truncated: boolean };
    try { capture = await this.artifacts.readBounded({ companyId: artifact.company_id, storagePath: artifact.storage_path, sha256: artifact.sha256 }, 64 * 1024); } catch { safeNotFound(); }
    const { bytes, truncated } = capture;
    let content: string;
    try {
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      content = JSON.stringify(safeEvidenceValue(value));
    } catch {
      content = safeEvidenceText(bytes.toString("utf8"));
    }
    const bounded = content.length > 12_000;
    return { artifactId: artifact.id, sha256: artifact.sha256, kind: artifact.kind, content: content.slice(0, 12_000), truncated: truncated || bounded };
  }

  rebuildAll(): number {
    return this.database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_companies").get() as { count: number }).count);
  }

  rebuild(_companyId: string): void {}

  private publicAttention(row: AttentionRow): AttentionItem[] {
    const category = AttentionCategorySchema.safeParse(row.category);
    const actions = parseActions(row.actions_json, row.source_revision);
    if (!category.success || !actions || !row.activated_at || !row.evidence_artifact_id || !row.evidence_sha256) return [];
    return [{ id: row.id || attentionId(row.company_id, row.task_id, row.source_revision, category.data), companyId: row.company_id, taskId: row.task_id, issueKey: row.issue_key, taskTitle: row.task_title, category: category.data, summary: row.summary, sourceRevision: row.source_revision, activatedAt: row.activated_at, actions, evidence: { artifactId: row.evidence_artifact_id, sha256: row.evidence_sha256, kind: row.kind, mimeType: row.mime_type, byteSize: row.byte_size, href: `/api/attention/${encodeURIComponent(row.id)}/evidence` } }];
  }

  private categoryRank(company: CompanyAttentionOverview): number {
    return Math.min(...company.attention.map((item) => ATTENTION_CATEGORY_SEVERITY.indexOf(item.category)), ATTENTION_CATEGORY_SEVERITY.length);
  }

  private oldestAttention(company: CompanyAttentionOverview): string {
    return company.attention.map((item) => item.activatedAt).sort()[0] ?? "";
  }
}

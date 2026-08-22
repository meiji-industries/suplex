import { AuthService } from "./auth.js";
import type { ForgeDatabase } from "./database.js";
import { type IssueCommand } from "./temporal/issue-contracts.js";
import { jsonRequired } from "./task-utils.js";

export interface AttentionAction {
  command: IssueCommand;
  label: string;
  expectedRevision: number;
  requiresNote: boolean;
  destructive: boolean;
}

export interface AttentionItem {
  companyId: string;
  taskId: string;
  issueKey: string | null;
  taskTitle: string;
  summary: string | null;
  sourceRevision: number;
  activatedAt: string;
  actions: AttentionAction[];
}

export interface CompanyAttentionOverview {
  companyId: string;
  companyName: string;
  companyStatus: string;
  attentionCount: number;
  attention: AttentionItem[];
}

interface ProjectionRow {
  company_id: string;
  issue_key: string | null;
  task_id: string;
  task_title: string;
  revision: number;
  allowed_commands_json: string;
  pending_action: string | null;
  activated_at: string;
}

const NOTE_COMMANDS = new Set<IssueCommand>(["approve_plan", "reject_plan", "request_plan_revision", "record_delivery_decision", "request_delivery_changes"]);

function actions(raw: string, expectedRevision: number): AttentionAction[] {
  try {
    const commands = jsonRequired(raw);
    if (!Array.isArray(commands) || !commands.every((command): command is IssueCommand => typeof command === "string")) return [];
    return commands.map((command) => ({ command, label: command.replaceAll("_", " "), expectedRevision, requiresNote: NOTE_COMMANDS.has(command), destructive: command === "cancel_issue" }));
  } catch {
    return [];
  }
}

export class AttentionService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService) {}

  list(actorUserId: string): CompanyAttentionOverview[] {
    return this.auth.listVisibleCompanies(actorUserId).map((company) => {
      const rows = this.database.authQuery((db) => db.prepare(`SELECT ip.company_id, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issue_key, ip.task_id, t.title AS task_title, ip.revision, ip.allowed_commands_json, ip.pending_action, COALESCE(ip.state_changed_at, ip.updated_at) AS activated_at
        FROM forge_issue_projections ip
        JOIN forge_tasks t ON t.id = ip.task_id
        JOIN forge_companies c ON c.id = ip.company_id
        WHERE ip.company_id = ? AND (ip.owner = 'human' OR ip.phase IN ('delivery_blocked', 'blocked', 'failed'))
        ORDER BY activated_at DESC, ip.task_id DESC`).all(company.id) as ProjectionRow[]);
      const attention = rows.map((row) => ({ companyId: row.company_id, taskId: row.task_id, issueKey: row.issue_key, taskTitle: row.task_title, summary: row.pending_action, sourceRevision: row.revision, activatedAt: row.activated_at, actions: actions(row.allowed_commands_json, row.revision) }));
      return { companyId: company.id, companyName: company.name, companyStatus: company.status, attentionCount: attention.length, attention };
    }).sort((left, right) => right.attentionCount - left.attentionCount || left.companyId.localeCompare(right.companyId));
  }
}

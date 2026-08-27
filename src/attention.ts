import { AuthService } from "./auth.js";
import type { ForgeDatabase } from "./database.js";
import { type IssueCommand } from "./temporal/issue-contracts.js";
import { jsonRequired } from "./task-utils.js";
import { attentionCardFor } from "./recovery/attention-card.js";
import type { AttentionCard, AttentionChoice } from "./recovery/convergence.js";

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
  card: AttentionCard;
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
  pane_id: string | null;
  agent_name: string | null;
  attention_excerpt: string | null;
}

interface Blocker { category?: unknown; summary?: unknown; actions?: unknown }

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

function genericCard(summary: string | null, pendingAction: string | null, actionList: AttentionAction[]): AttentionCard {
  const primary = actionList.find((action) => !action.destructive);
  const cancel = actionList.find((action) => action.command === "cancel_issue");
  const explanation = summary || pendingAction || "This task needs your input.";
  return { kind: "generic", title: (pendingAction || "Needs attention").replaceAll("_", " "), explanation, evidence: [{ kind: "text", ref: explanation }], primaryAction: primary ? { command: primary.command, label: primary.label, requiresNote: primary.requiresNote } : { command: "continue_work", label: "Open the pane and answer" }, ...(cancel ? { secondaryAction: { command: cancel.command, label: cancel.label, destructive: true } } : {}) };
}

function cardForBlocker(blocker: Blocker | undefined, row: ProjectionRow, actionList: AttentionAction[]): AttentionCard {
  const summary = typeof blocker?.summary === "string" && blocker.summary.trim() ? blocker.summary.trim() : row.pending_action;
  const category = typeof blocker?.category === "string" ? blocker.category : "";
  if (category === "provider_authentication") return summary ? attentionCardFor({ kind: "github_credential", detail: summary }) : attentionCardFor({ kind: "github_credential" });
  if (category === "member_decision" || category === "provider_ambiguity") {
    const rawChoices = Array.isArray(blocker?.actions) ? blocker.actions.flatMap((action, index): AttentionChoice[] => typeof action === "object" && action !== null && typeof (action as { label?: unknown }).label === "string" ? [{ id: typeof (action as { id?: unknown }).id === "string" ? (action as { id: string }).id : `choice-${index + 1}`, label: (action as { label: string }).label, description: typeof (action as { description?: unknown }).description === "string" ? (action as { description: string }).description : "Choose this behavior." }] : typeof action === "string" ? [{ id: `choice-${index + 1}`, label: action, description: "Choose this behavior." }] : []) : [];
    if (rawChoices.length >= 2) return attentionCardFor({ kind: "product_decision", question: summary || "Choose how this issue should behave.", choices: rawChoices as [AttentionChoice, AttentionChoice, ...AttentionChoice[]], recommendedChoiceId: rawChoices[0]!.id });
  }
  if (category === "unsafe_recovery" && /worktree/i.test(summary || "")) return attentionCardFor({ kind: "dirty_worktree_cleanup", dirtyFileCount: 1, worktreePath: "Recorded worktree" });
  if (category === "agent_exhausted" || category === "verification_unrecoverable") return attentionCardFor({ kind: "no_progress", failureClass: "code_failure", signature: summary || "Automatic repair needs your input." });
  return genericCard(summary, row.pending_action, actionList);
}

export class AttentionService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService) {}

  list(actorUserId: string): CompanyAttentionOverview[] {
    return this.auth.listVisibleCompanies(actorUserId).map((company) => {
      const rows = this.database.authQuery((db) => db.prepare(`SELECT ip.company_id, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issue_key, ip.task_id, t.title AS task_title, ip.revision, ip.allowed_commands_json, ip.pending_action, COALESCE(ip.state_changed_at, ip.updated_at) AS activated_at, NULL AS pane_id, NULL AS agent_name, NULL AS attention_excerpt
        FROM forge_issue_projections ip
        JOIN forge_tasks t ON t.id = ip.task_id
        JOIN forge_companies c ON c.id = ip.company_id
        WHERE ip.company_id = ? AND (ip.owner = 'human' OR ip.phase IN ('delivery_blocked', 'blocked', 'failed'))
        UNION ALL
        SELECT ip.company_id, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END, ip.task_id, t.title, ip.revision, '[]', NULL, ht.updated_at, rs.pane_id, rs.agent_name, ht.attention_excerpt
        FROM forge_herdr_turns ht
        JOIN forge_herdr_role_sessions rs ON rs.id = ht.role_session_id
        JOIN forge_issue_projections ip ON ip.task_id = ht.task_id
        JOIN forge_tasks t ON t.id = ip.task_id
        JOIN forge_companies c ON c.id = ip.company_id
        WHERE ip.company_id = ? AND ht.status IN ('blocked', 'awaiting_human') AND ip.phase NOT IN ('done', 'cancelled') AND rs.is_current = 1
        UNION ALL
        SELECT ip.company_id, CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END, ip.task_id, t.title, ip.revision, '[]', NULL, COALESCE(rs.attention_activated_at, rs.updated_at), rs.pane_id, rs.agent_name, NULL
        FROM forge_herdr_role_sessions rs
        JOIN forge_issue_projections ip ON ip.task_id = rs.task_id
        JOIN forge_tasks t ON t.id = ip.task_id
        JOIN forge_companies c ON c.id = ip.company_id
        WHERE ip.company_id = ? AND rs.status = 'blocked' AND ip.phase NOT IN ('done', 'cancelled') AND rs.is_current = 1
          AND NOT EXISTS (SELECT 1 FROM forge_herdr_turns ht WHERE ht.role_session_id = rs.id AND ht.status IN ('blocked', 'awaiting_human'))
        ORDER BY activated_at DESC, ip.task_id DESC`).all(company.id, company.id, company.id) as ProjectionRow[]);
      const attention = rows.map((row) => {
        const actionList = row.pane_id ? [] : actions(row.allowed_commands_json, row.revision);
        const summary = row.pane_id ? [`Agent needs you in ${row.pane_id}`, row.agent_name ? `(${row.agent_name})` : "", row.attention_excerpt].filter(Boolean).join(" ") : row.pending_action;
        const blocker = row.pane_id ? undefined : this.database.authQuery((db) => {
          const snapshot = db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(row.task_id) as { state_json?: string } | undefined;
          try { return snapshot?.state_json ? (jsonRequired(snapshot.state_json) as { blocker?: Blocker }).blocker : undefined; } catch { return undefined; }
        });
        const card = row.pane_id ? genericCard(row.attention_excerpt || "The agent asked a question in its pane.", "Agent is waiting for you", actionList) : cardForBlocker(blocker, row, actionList);
        return { companyId: row.company_id, taskId: row.task_id, issueKey: row.issue_key, taskTitle: row.task_title, summary, sourceRevision: row.revision, activatedAt: row.activated_at, actions: actionList, card };
      });
      return { companyId: company.id, companyName: company.name, companyStatus: company.status, attentionCount: attention.length, attention };
    }).sort((left, right) => right.attentionCount - left.attentionCount || left.companyId.localeCompare(right.companyId));
  }
}

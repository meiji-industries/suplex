import type { ForgeDatabase } from "./database.js";

export interface TurnRecoveryPromptClaim {
  turnId: string;
  taskId: string;
  roleSessionId: string;
  sessionRole: "planner" | "builder" | "reviewer" | "integrator";
  paneId: string | null;
  ledger: "agent" | "developer";
  executionId: string;
  executionRole: "planner" | "builder" | "reviewer" | "integrator";
  executionStatus: string;
  promptKind: string;
  promptSentAt: string;
  resultRelativePath: string;
  turnStatus: string;
  workflowId: string;
  revision: number;
  timestamp: string;
  attentionExcerpt: string;
}

export function claimTurnRecoveryPrompt(database: ForgeDatabase, claim: TurnRecoveryPromptClaim): boolean {
  return database.authTransaction((db) => {
    const claimed = db.prepare(`UPDATE forge_herdr_turns AS turn
      SET recovery_prompt_sent_at = ?, status = 'awaiting_human', attention_excerpt = ?, updated_at = ?
      WHERE turn.turn_id = ? AND turn.task_id = ? AND turn.role_session_id = ?
        AND turn.ledger = ? AND turn.execution_id = ? AND turn.execution_role = ?
        AND turn.prompt_kind = ? AND turn.prompt_sent_at IS ? AND turn.result_relative_path = ?
        AND turn.status = ? AND turn.recovery_prompt_sent_at IS NULL
        AND turn.turn_id = (
          SELECT latest.turn_id FROM forge_herdr_turns latest
          WHERE latest.role_session_id = turn.role_session_id
          ORDER BY latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1
        )
        AND EXISTS (
          SELECT 1 FROM forge_herdr_role_sessions session
          WHERE session.id = turn.role_session_id AND session.task_id = turn.task_id
            AND session.session_role = ? AND session.is_current = 1 AND session.pane_id IS ?
        )
        AND EXISTS (
          SELECT 1 FROM forge_issue_projections projection
          WHERE projection.task_id = turn.task_id AND projection.workflow_id = ?
            AND projection.revision = ? AND projection.phase NOT IN ('done', 'cancelled', 'failed')
        )
        AND ((turn.ledger = 'agent' AND EXISTS (
          SELECT 1 FROM forge_agent_executions execution
          WHERE execution.id = turn.execution_id AND execution.task_id = turn.task_id
            AND execution.workflow_id = ? AND execution.role = turn.execution_role
            AND execution.status = ? AND execution.status IN ('starting', 'running')
        )) OR (turn.ledger = 'developer' AND EXISTS (
          SELECT 1 FROM forge_developer_executions execution
          WHERE execution.id = turn.execution_id AND execution.task_id = turn.task_id
            AND execution.workflow_id = ? AND execution.status = ?
            AND execution.status IN ('starting', 'running')
        )))
      RETURNING turn_id`).get(
        claim.timestamp,
        claim.attentionExcerpt,
        claim.timestamp,
        claim.turnId,
        claim.taskId,
        claim.roleSessionId,
        claim.ledger,
        claim.executionId,
        claim.executionRole,
        claim.promptKind,
        claim.promptSentAt,
        claim.resultRelativePath,
        claim.turnStatus,
        claim.sessionRole,
        claim.paneId,
        claim.workflowId,
        claim.revision,
        claim.workflowId,
        claim.executionStatus,
        claim.workflowId,
        claim.executionStatus,
      );
    if (!claimed) return false;
    return true;
  });
}

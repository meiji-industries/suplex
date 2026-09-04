import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import { turnResultSchema } from "../../turn-result-schemas.js";
import { json } from "../../task-utils.js";
import { herdrResultAnswer, ownerAnswer, type OwnerAnswer } from "../workflow/owner-answer.js";
import { isTaskTurnLive } from "./herdr-liveness.js";

type Subject = { commit?: string | null; tree?: string | null; planRevision?: number | null };
type TurnRow = { ledger: "agent" | "developer"; resultRelativePath: string; terminalFailure: string | null; planRevision: number | null; subjectCommit: string | null; subjectTree: string | null };

function matchesSubject(subject: Subject, turn: TurnRow): boolean {
  return (subject.planRevision === undefined || subject.planRevision === null || turn.planRevision === subject.planRevision)
    && (!subject.commit || !turn.subjectCommit || turn.subjectCommit === subject.commit)
    && (!subject.tree || !turn.subjectTree || turn.subjectTree === subject.tree);
}

function unavailable(error: unknown): OwnerAnswer {
  return ownerAnswer({ type: "owner.unavailable", owner: "herdr", reason: error instanceof Error ? error.message : "Herdr owner read failed" });
}

export function createHerdrTurnReadActivities({ database, config }: { database: ForgeDatabase; config: ForgeConfig }) {
  return {
    async readHerdrTurn(input: { taskId: string; companyId: string; workflowId: string; role: "planner" | "reviewer" | "builder" | "integrator"; promptKind: string; subject: Subject }): Promise<OwnerAnswer> {
      try {
        const turn = database.authQuery((db) => db.prepare(`SELECT turn.ledger, turn.result_relative_path AS resultRelativePath,
            COALESCE(agent.failure_summary, developer.failure_summary) AS terminalFailure,
            COALESCE(agent.workflow_revision, developer.plan_revision) AS planRevision,
            review.subject_commit AS subjectCommit, review.subject_tree AS subjectTree
          FROM forge_herdr_turns turn
          LEFT JOIN forge_agent_executions agent ON turn.ledger = 'agent' AND agent.id = turn.execution_id
          LEFT JOIN forge_developer_executions developer ON turn.ledger = 'developer' AND developer.id = turn.execution_id
          LEFT JOIN forge_delivery_review_attempts review ON review.lead_execution_id = turn.execution_id
            AND review.task_id = turn.task_id AND review.company_id = ? AND review.workflow_id = ?
          WHERE turn.task_id = ? AND turn.execution_role = ? AND turn.prompt_kind = ?
            AND turn.ledger IN ('agent', 'developer')
          ORDER BY turn.updated_at DESC, turn.created_at DESC, turn.correction_index DESC, turn.turn_id DESC
          LIMIT 1`).get(input.companyId, input.workflowId, input.taskId, input.role, input.promptKind) as TurnRow | undefined);
        if (turn && matchesSubject(input.subject, turn)) {
          const schema = turnResultSchema(turn.ledger, input.promptKind);
          if (schema) {
            const runtimeRoot = resolve(config.runtimeRoot);
            const resultPath = resolve(runtimeRoot, turn.resultRelativePath);
            if (resultPath.startsWith(`${runtimeRoot}/`)) {
              const result = await readFile(resultPath, "utf8").catch(() => undefined);
              if (result !== undefined) {
                const parsed = schema.safeParse(json(result, null));
                if (parsed.success) return herdrResultAnswer(parsed.data);
              }
            }
          }
          if (turn.terminalFailure) return ownerAnswer({ type: "owner.failed", reason: turn.terminalFailure });
        }
        return (await isTaskTurnLive(database, config, input.taskId)).live ? ownerAnswer({ type: "owner.live" }) : ownerAnswer({ type: "owner.absent" });
      } catch (error) {
        return unavailable(error);
      }
    },
  };
}

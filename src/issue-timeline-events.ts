import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "./canonical-json.js";
import { timelineEventId, type NeutralTimelineEvent } from "./codex-rollout.js";
import type { ForgeDatabase } from "./database.js";
import { json } from "./task-utils.js";
export interface TimelineEventContext {
  taskId: string;
  companyId: string;
  workflowId: string;
  runId: string | null;
  revision: number;
}
export interface TimelineHistoryRow {
  streamId: number;
  id: string;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  executionId: string | null;
  executionRole: "planner" | "reviewer" | "builder" | "integrator" | null;
  sessionId: string | null;
  forgeTurnId: string | null;
}
const hash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
/** The cursor advances in the same SQLite transaction as its deterministic event rows. */
export class IssueTimelineEvents {
  constructor(private readonly database: ForgeDatabase) {}
  insert(
    context: TimelineEventContext,
    roleSessionId: string,
    cursor: number,
    events: readonly NeutralTimelineEvent[],
  ): number {
    return this.database.authQuery((db) =>
      db.transaction(() =>
        this.insertIn(db, context, roleSessionId, cursor, events),
      )(),
    );
  }
  private insertIn(
    db: Database.Database,
    context: TimelineEventContext,
    _roleSessionId: string,
    cursor: number,
    events: readonly NeutralTimelineEvent[],
  ): number {
    const insert = db.prepare(
      "INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, run_id, revision, source, event_type, metadata_json, created_at, event_hash, execution_id, execution_role, session_id, forge_turn_id, source_offset) VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of events) {
      const id = timelineEventId(item.sessionId, item.sourceOffset);
      const metadata = { kind: item.kind, data: item.data };
      const eventHash = hash(metadata);
      const current = db
        .prepare(
          "SELECT event_hash FROM forge_issue_timeline WHERE session_id = ? AND source_offset = ? AND source = 'agent'",
        )
        .get(item.sessionId, item.sourceOffset) as
        | {
            event_hash: string;
          }
        | undefined;
      if (current) {
        if (current.event_hash !== eventHash)
          throw new Error("Timeline replay identity conflict");
        continue;
      }
      insert.run(
        id,
        context.taskId,
        context.companyId,
        context.workflowId,
        context.runId,
        context.revision,
        item.kind,
        canonicalJson(metadata),
        item.timestamp,
        eventHash,
        item.executionId,
        item.executionRole,
        item.sessionId,
        item.forgeTurnId,
        item.sourceOffset,
      );
    }
    const next = events.reduce(
      (maximum, item) => Math.max(maximum, item.sourceOffset),
      cursor,
    );
    db.prepare(
      "UPDATE forge_herdr_turns SET rollout_cursor_offset = ?, updated_at = ? WHERE turn_id = ? AND rollout_cursor_offset <= ?",
    ).run(next, new Date().toISOString(), events[0]?.forgeTurnId ?? "", next);
    return next;
  }
  history(taskId: string, after = 0, limit = 100): TimelineHistoryRow[] {
    return this.database.authQuery((db) =>
      (
        db
          .prepare(
            "SELECT stream_id AS streamId, id, event_type AS eventType, metadata_json AS metadataJson, created_at AS createdAt, execution_id AS executionId, execution_role AS executionRole, session_id AS sessionId, forge_turn_id AS forgeTurnId FROM forge_issue_timeline WHERE task_id = ? AND stream_id > ? ORDER BY stream_id LIMIT ?",
          )
          .all(taskId, after, limit) as Array<
          TimelineHistoryRow & {
            metadataJson: string;
          }
        >
      ).map((row) => ({
        ...row,
        metadata: json<Record<string, unknown>>(row.metadataJson, {}),
      })),
    );
  }
}

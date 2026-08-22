import { defaultPayloadConverter, WorkflowNotFoundError } from "@temporalio/client";

import type { ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { connectTemporal } from "./temporal/service.js";
import { IssueProjectionEventSchema, IssueWorkflowStateSchema, type IssueProjectionEvent } from "./temporal/issue-contracts.js";
import { issueStateQuery, issueWorkflow } from "./temporal/workflows.js";

export class ProjectionRebuildFailure extends Error {
  readonly code: "temporal_rebuild_unavailable" | "projection_history_decode_failed" | "projection_history_incomplete";

  constructor(code: ProjectionRebuildFailure["code"], message: string) {
    super(message);
    this.name = "ProjectionRebuildFailure";
    this.code = code;
  }
}

export interface ProjectionRebuildResult {
  rebuilt: number;
  findings: Array<{ taskId: string; code: string; summary: string }>;
}

type HistoryEvent = Record<string, unknown>;

function historyEvents(history: unknown): HistoryEvent[] {
  const events = (history as { events?: unknown[] }).events;
  return Array.isArray(events) ? events.filter((event): event is HistoryEvent => Boolean(event && typeof event === "object")) : [];
}

function projectionEvents(history: unknown, runId: string): IssueProjectionEvent[] {
  return historyEvents(history).flatMap((event) => {
    const attributes = event.activityTaskScheduledEventAttributes as { activityType?: { name?: string } | string; input?: { payloads?: unknown[] } } | undefined;
    const activityName = typeof attributes?.activityType === "string" ? attributes.activityType : attributes?.activityType?.name;
    const payload = attributes?.input?.payloads?.[0];
    if (activityName !== "projectIssueState") return [];
    if (!payload) throw new ProjectionRebuildFailure("projection_history_decode_failed", "Projection Activity input is missing");
    try {
      const decoded = defaultPayloadConverter.fromPayload(payload as never) as unknown;
      const current = IssueProjectionEventSchema.safeParse(decoded);
      if (current.success) return [current.data];
      const legacy = IssueWorkflowStateSchema.safeParse(decoded);
      if (legacy.success) return [{ schemaVersion: 1, runId, eventId: legacy.data.lastEventId, state: legacy.data }];
      throw new ProjectionRebuildFailure("projection_history_decode_failed", "Projection Activity input failed schema validation");
    } catch (error) {
      if (error instanceof ProjectionRebuildFailure) throw error;
      throw new ProjectionRebuildFailure("projection_history_decode_failed", "Projection Activity input could not be decoded");
    }
  });
}

function continuedRunId(history: unknown): string | undefined {
  const events = historyEvents(history);
  const event = [...events].reverse().find((candidate) => candidate.workflowExecutionContinuedAsNewEventAttributes);
  const attributes = event?.workflowExecutionContinuedAsNewEventAttributes as { newExecutionRunId?: string } | undefined;
  return attributes?.newExecutionRunId;
}

export class ProjectionRebuildService {
  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig) {}

  async rebuild(scope: { companyId?: string; taskId?: string } = {}): Promise<ProjectionRebuildResult> {
    const tasks = this.database.authQuery((db) => {
      const conditions = ["1 = 1"];
      const values: string[] = [];
      if (scope.companyId) { conditions.push("company_id = ?"); values.push(scope.companyId); }
      if (scope.taskId) { conditions.push("id = ?"); values.push(scope.taskId); }
      return db.prepare(`SELECT id, company_id, workflow_id FROM forge_tasks WHERE ${conditions.join(" AND ")} ORDER BY id`).all(...values) as Array<{ id: string; company_id: string; workflow_id: string }>;
    });
    let temporal;
    try {
      temporal = await connectTemporal(this.config);
    } catch {
      throw new ProjectionRebuildFailure("temporal_rebuild_unavailable", "Temporal is unavailable; projection rebuild was not run");
    }
    const findings: ProjectionRebuildResult["findings"] = [];
    let rebuilt = 0;
    try {
      for (const task of tasks) {
        try {
          const handle = temporal.client.workflow.getHandle<typeof issueWorkflow>(task.workflow_id);
          const description = await handle.describe();
          const runs = new Set<string>();
          let runId: string | undefined = description.rootExecution?.runId ?? description.runId;
          const events: IssueProjectionEvent[] = [];
          while (runId && !runs.has(runId)) {
            runs.add(runId);
            const runHandle = temporal.client.workflow.getHandle<typeof issueWorkflow>(task.workflow_id, runId);
            const history = await runHandle.fetchHistory();
            events.push(...projectionEvents(history, runId));
            runId = continuedRunId(history);
          }
          if (runId && runs.has(runId)) throw new ProjectionRebuildFailure("projection_history_incomplete", "Temporal projection history contains a repeated execution run");
          if (description.status.name === "RUNNING") {
            try {
              const state = IssueWorkflowStateSchema.parse(await handle.query(issueStateQuery));
              const latestHistoryRevision = events.reduce((latest, event) => Math.max(latest, event.state.revision), -1);
              // A continued run may expose the same business revision with a
              // newer continuationCount. That is execution metadata, not a new
              // projection event, and the prior run remains the authority for
              // the already-emitted revision.
              if (state.revision > latestHistoryRevision) events.push({ schemaVersion: 1, runId: description.runId, eventId: state.lastEventId, state });
            } catch {
              // History remains the authority when a running query is unavailable.
            }
          }
          const ordered = events.sort((left, right) => left.state.revision - right.state.revision);
          if (ordered.length === 0) throw new ProjectionRebuildFailure("projection_history_incomplete", "Temporal history contains no projection events");
          this.database.replaceIssueProjectionFromEvents(task.id, ordered);
          rebuilt += 1;
        } catch (error) {
          const code = error instanceof WorkflowNotFoundError ? "projection_history_incomplete" : error instanceof ProjectionRebuildFailure ? error.code : "projection_history_decode_failed";
          const summary = error instanceof WorkflowNotFoundError ? "Temporal history is missing for the selected task" : error instanceof Error ? error.message : "Temporal projection history could not be decoded";
          findings.push({ taskId: task.id, code, summary: summary.slice(0, 240) });
          if (tasks.length === 1) {
            throw error instanceof ProjectionRebuildFailure
              ? error
              : new ProjectionRebuildFailure(code, summary);
          }
        }
      }
    } catch (error) {
      throw error;
    } finally {
      await temporal.connection.close();
    }
    return { rebuilt, findings };
  }
}

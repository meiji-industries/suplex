import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { AnalyticsResponseSchema, TaskCostsResponseSchema } from "../../tasks/analytics/contracts.js";
import { usageMetrics } from "../../tasks/analytics/metrics.js";
import { TaskFailure, type TaskService } from "../../tasks/tasks.js";
import type { TaskHost } from "../../tasks/host.js";
import type { ForgeConfig } from "../../platform/config.js";
import { readTaskAgentStatuses } from "../../tasks/agent-status.js";
import { TaskAgentsResponseSchema, TaskArchiveBodySchema, TaskArchiveResponseSchema, TaskIssueBodySchema } from "../contracts/tasks.js";
import { readTaskChecks, readTaskDiff, readTaskDiffSummary } from "../../tasks/inspection.js";
import { readTaskExecution } from "../../tasks/execution/execution.js";
import { readTaskSessionHistory } from "../../tasks/history/read.js";
import { SessionHistoryCursorError } from "../../tasks/history/history.js";
import { pageSessionHistory } from "../../tasks/history/history.js";
import { diffSessionHistory, pollSessionHistory } from "../../tasks/history/live.js";
import type { NativeHistoryMessage, SessionHistoryLiveEvent } from "../../tasks/history/contracts.js";
import type { TaskSession } from "../../tasks/control.js";
import { nativeSessionReader } from "../../runtimes/task-harness-registry.js";
import { originAllowed } from "./task-pane.js";
import { TaskTimelineResponseSchema } from "../../tasks/timeline/contracts.js";
import { TaskExecutionResponseSchema } from "../../tasks/execution/contracts.js";
import { TaskChecksResponseSchema, TaskDiffResponseSchema, TaskDiffSummaryResponseSchema } from "../contracts/tasks.js";
import { CompanyIdParamsSchema, TaskArtifactParamsSchema, TaskIdParamsSchema } from "../contracts/common.js";
import { normalizeWorkflowInput, WorkflowInputFailure } from "../../coordination/workflows.js";
import { MAX_TASK_REQUEST_BYTES, SessionHistoryPageSchema, TaskActivityResponseSchema, TaskAnswerBodySchema, TaskBlockedByBodySchema, TaskBodySchema, TaskDependenciesBodySchema, TaskDetailsBodySchema, TaskListResponseSchema, TaskNoteBodySchema, TaskSessionHistoryParamsSchema, TaskSessionHistoryQuerySchema, TaskWorkerReplacementBodySchema, TaskRenameBodySchema, TaskResponseSchema } from "../contracts/tasks.js";

export interface TaskRoutesOptions {
  tasks: TaskService;
  host?: Pick<TaskHost, "recover">;
  config?: Pick<ForgeConfig, "databasePath" | "reachableAddress">;
  readHistory?: (databasePath: string, session: TaskSession) => Promise<NativeHistoryMessage[]>;
}

const tasks: FastifyPluginAsync<TaskRoutesOptions> = async (app, { tasks, host, config, readHistory }) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const liveConnections = new Set<() => void>();
  app.addHook("onClose", async () => {
    for (const close of [...liveConnections]) close();
  });
  const taskResponse = { params: TaskIdParamsSchema, response: { 200: TaskResponseSchema } };
  const listQuery = z.object({ archived: z.enum(["true", "false"]).optional() });
  typed.get("/api/companies/:companyId/task-costs", { schema: { params: CompanyIdParamsSchema, response: { 200: TaskCostsResponseSchema } } }, async (request, reply) => {
    const result = tasks.analytics(request.forgeUser.id, request.params.companyId);
    return reply.header("Cache-Control", "private, no-store").send({ tasks: result.tasks.map(task => { const metrics = usageMetrics(task.usage); return { id: task.id, cost: metrics.cost, unpriced: metrics.unpricedMessages > 0, subsidized: metrics.subsidized, partial: metrics.unpricedMessages > 0 || task.staleSessions > 0 || task.observedSessions < task.sessions || task.usage.some(entry => entry.completedAt === null) }; }) });
  });
  typed.get("/api/companies/:companyId/analytics", { schema: { params: CompanyIdParamsSchema, response: { 200: AnalyticsResponseSchema } } }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(tasks.analytics(request.forgeUser.id, request.params.companyId));
  });
  typed.get("/api/companies/:companyId/timeline", { schema: { params: CompanyIdParamsSchema, response: { 200: TaskTimelineResponseSchema, 503: z.object({ error: z.string() }) } } }, async (request, reply) => {
    const companyId = request.params.companyId;
    const all = [...tasks.listTasks(request.forgeUser.id, companyId, false), ...tasks.listTasks(request.forgeUser.id, companyId, true)];
    const result = await tasks.timeline(request.forgeUser.id, all.map(task => task.id));
    tasks.listTasks(request.forgeUser.id, companyId);
    return reply.header("Cache-Control", "private, no-store").send(result);
  });
  typed.get("/api/tasks/:taskId/execution", { schema: { params: TaskIdParamsSchema, response: { 200: TaskExecutionResponseSchema, 503: z.object({ error: z.string() }) } } }, async (request, reply) => {
    const task = tasks.getTask(request.forgeUser.id, request.params.taskId);
    if (!config) return reply.code(503).send({ error: "Agent activity is not available" });
    const result = await readTaskExecution(config.databasePath, tasks.repository.controls.sessions(task.id));
    tasks.getTask(request.forgeUser.id, task.id);
    return reply.header("Cache-Control", "private, no-store").send(result);
  });
  typed.get("/api/tasks/:taskId/sessions/:sessionId/history", { schema: { params: TaskSessionHistoryParamsSchema, querystring: TaskSessionHistoryQuerySchema, response: { 200: SessionHistoryPageSchema, 503: z.object({ error: z.string() }) } } }, async (request, reply) => {
    const task = tasks.getTask(request.forgeUser.id, request.params.taskId);
    const session = tasks.repository.controls.sessions(task.id).find(candidate => candidate.id === request.params.sessionId);
    if (!session) throw new TaskFailure("Not found", 404);
    if (!config) return reply.code(503).send({ error: "Session history is not available" });
    let result;
    try {
      result = await readTaskSessionHistory(config.databasePath, session, request.query.before);
    } catch (error) {
      if (error instanceof SessionHistoryCursorError) throw new TaskFailure(error.message, 400, "cursor_invalid");
      request.log.warn({ taskId: task.id, sessionId: session.id, err: error }, "Native session history read failed");
      return reply.code(503).send({ error: "Session history is not available" });
    }
    tasks.getTask(request.forgeUser.id, task.id);
    return reply.header("Cache-Control", "private, no-store").send(result);
  });
  typed.get("/api/tasks/:taskId/sessions/:sessionId/history/live", { websocket: true, schema: { params: TaskSessionHistoryParamsSchema } }, (socket, request) => {
    let stopPolling = (): void => {};
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      stopPolling();
      liveConnections.delete(release);
      if (socket.readyState === 0 || socket.readyState === 1) socket.close(1012, "server closing");
    };
    socket.once("close", release);
    socket.once("error", release);
    socket.on("message", () => socket.close(1008, "read only"));
    liveConnections.add(release);

    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!originAllowed(origin, request.headers.host, config?.reachableAddress)) {
      socket.close(4403, "origin");
      return;
    }
    if (!config) {
      socket.close(1013, "history unavailable");
      return;
    }
    const currentSession = (): TaskSession | null => {
      const task = tasks.getTask(request.forgeUser.id, request.params.taskId);
      return tasks.repository.controls.sessions(task.id).find(candidate => candidate.id === request.params.sessionId) ?? null;
    };
    let session: TaskSession | null;
    try { session = currentSession(); }
    catch {
      socket.close(4404, "not found");
      return;
    }
    if (!session) {
      socket.close(4404, "not found");
      return;
    }

    let nativeIdentity = session.nativeSessionId;
    let native = readHistory ? null : nativeSessionReader(config.databasePath, session);
    const observe = (): Promise<NativeHistoryMessage[]> => {
      const fresh = currentSession();
      if (!fresh) throw new Error("Session is no longer available");
      session = fresh;
      if (readHistory) return readHistory(config.databasePath, fresh);
      if (!native || nativeIdentity !== fresh.nativeSessionId) {
        nativeIdentity = fresh.nativeSessionId;
        native = nativeSessionReader(config.databasePath, fresh);
      }
      return native.history(fresh);
    };
    let previous: NativeHistoryMessage[] = [];
    let sentSnapshot = false;
    const send = (event: SessionHistoryLiveEvent): boolean => {
      if (socket.readyState !== 1) return false;
      const payload = JSON.stringify(event);
      if (socket.bufferedAmount + Buffer.byteLength(payload) > 4 * 1024 * 1024) {
        socket.close(1013, "client too slow");
        return false;
      }
      try {
        socket.send(payload);
        return true;
      } catch {
        socket.close(1013, "delivery failed");
        return false;
      }
    };
    const recheck = (): boolean => {
      try {
        if (!currentSession()) {
          socket.close(4404, "session removed");
          return false;
        }
        return true;
      } catch {
        socket.close(4403, "access revoked");
        return false;
      }
    };
    stopPolling = pollSessionHistory({
      read: observe,
      intervalMs: session.current ? 500 : 2_000,
      onHistory(messages, recovered) {
        if (!recheck()) return;
        if (!sentSnapshot || recovered) {
          if (!send({ type: "snapshot", page: pageSessionHistory(messages), order: messages.map(message => message.id) })) return;
          sentSnapshot = true;
          previous = messages;
          return;
        }
        const change = diffSessionHistory(previous, messages);
        previous = messages;
        if (change) send({ type: "update", ...change });
      },
      onError(error) {
        if (!recheck()) return;
        request.log.warn({ taskId: request.params.taskId, sessionId: request.params.sessionId, err: error }, "Live native session history read failed");
        send({ type: "error", message: "Live output is not available. Forge will retry." });
      },
    });
  });
  typed.get("/api/tasks/:taskId/timeline", { schema: { params: TaskIdParamsSchema, response: { 200: TaskTimelineResponseSchema } } }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(await tasks.timeline(request.forgeUser.id, [request.params.taskId]));
  });
  typed.get("/api/tasks/:taskId/agents", { schema: { params: TaskIdParamsSchema, response: { 200: TaskAgentsResponseSchema, 503: z.object({ error: z.string() }) } } }, async (request, reply) => {
    const task = tasks.getTask(request.forgeUser.id, request.params.taskId);
    if (!config) return reply.code(503).send({ error: "Agent status is not available" });
    const result = await readTaskAgentStatuses(config.databasePath, task, tasks.repository.controls.sessions(task.id));
    tasks.getTask(request.forgeUser.id, task.id);
    return reply.header("Cache-Control", "private, no-store").send(result);
  });
  const wake = (taskId: string): void => { if (host) void host.recover(taskId).catch(error => app.log.warn({ taskId, err: error }, "Task recovery will be retried")); };
  typed.get("/api/tasks", { schema: { querystring: listQuery, response: { 200: TaskListResponseSchema } } }, async request => ({ tasks: tasks.listTasks(request.forgeUser.id, undefined, request.query.archived === "true") }));
  typed.get("/api/companies/:companyId/tasks", { schema: { params: CompanyIdParamsSchema, querystring: listQuery, response: { 200: TaskListResponseSchema } } }, async request => ({ tasks: tasks.listTasks(request.forgeUser.id, request.params.companyId, request.query.archived === "true") }));
  // Workflow defaults apply before schema defaults can erase whether the caller supplied a field.
  const normalizeWorkflow = async (request: { body: unknown }, reply: { code(status: number): { send(body: unknown): unknown } }): Promise<void> => {
    try { if (request.body && typeof request.body === "object") request.body = normalizeWorkflowInput(request.body as Record<string, unknown>, { requireSource: true }); }
    catch (error) { if (error instanceof WorkflowInputFailure) { reply.code(error.statusCode).send({ error: error.message }); return; } throw error; }
  };
  typed.post("/api/companies/:companyId/tasks", { bodyLimit: MAX_TASK_REQUEST_BYTES, preValidation: normalizeWorkflow, schema: { params: CompanyIdParamsSchema, body: TaskBodySchema, response: { 200: TaskResponseSchema, 201: TaskResponseSchema } } }, async (request, reply) => {
    const result = await tasks.createTask(request.forgeUser.id, request.params.companyId, request.body);
    if (result.task.status === "active") wake(result.task.id);
    return reply.code(result.created ? 201 : 200).send(result.task);
  });
  typed.get("/api/tasks/:taskId", { schema: taskResponse }, async (request, reply) => reply.header("Cache-Control", "private, no-store").send(tasks.getTask(request.forgeUser.id, request.params.taskId)));
  typed.patch("/api/tasks/:taskId", { schema: { ...taskResponse, body: TaskDetailsBodySchema } }, async request => tasks.updateTaskDetails(request.forgeUser.id, request.params.taskId, request.body));
  typed.put("/api/tasks/:taskId/dependencies", { schema: { ...taskResponse, body: TaskDependenciesBodySchema } }, async request => tasks.setTaskDependencies(request.forgeUser.id, request.params.taskId, request.body.dependsOn));
  typed.patch("/api/tasks/:taskId/blocked-by", { schema: { ...taskResponse, body: TaskBlockedByBodySchema } }, async request => tasks.setTaskBlockedBy(request.forgeUser.id, request.params.taskId, request.body));
  typed.patch("/api/tasks/:taskId/issue", { schema: { ...taskResponse, body: TaskIssueBodySchema } }, async request => tasks.setTaskIssue(request.forgeUser.id, request.params.taskId, request.body.issue));
  typed.post("/api/tasks/:taskId/rename", { schema: { ...taskResponse, body: TaskRenameBodySchema } }, async request => tasks.renameTask(request.forgeUser.id, request.params.taskId, request.body));
  typed.post("/api/tasks/:taskId/start", { schema: taskResponse }, async request => {
    const task = tasks.startTask(request.forgeUser.id, request.params.taskId);
    wake(task.id);
    return task;
  });
  typed.post("/api/tasks/:taskId/answer", { schema: { ...taskResponse, body: TaskAnswerBodySchema } }, async request => {
    const task = "limitDecision" in request.body
      ? tasks.answerTaskLimit(request.forgeUser.id, request.params.taskId, request.body.questionId, request.body.limitDecision)
      : tasks.answerTask(request.forgeUser.id, request.params.taskId, request.body.questionId, request.body.answer, request.body.confirmCommandsStopped);
    wake(task.id);
    return task;
  });
  typed.post("/api/tasks/:taskId/replace-worker", { schema: { ...taskResponse, body: TaskWorkerReplacementBodySchema } }, async request => {
    const task = tasks.replaceWorker(request.forgeUser.id, request.params.taskId, request.body);
    wake(task.id);
    return task;
  });
  typed.post("/api/tasks/:taskId/note", { schema: { ...taskResponse, body: TaskNoteBodySchema } }, async request => {
    const task = tasks.sendNote(request.forgeUser.id, request.params.taskId, request.body.note);
    wake(task.id);
    return task;
  });
  typed.post("/api/tasks/:taskId/cancel", { schema: taskResponse }, async request => {
    const task = tasks.cancelTask(request.forgeUser.id, request.params.taskId);
    wake(task.id);
    return task;
  });
  typed.post("/api/tasks/:taskId/refresh", { schema: taskResponse }, async request => {
    const task = tasks.getTask(request.forgeUser.id, request.params.taskId);
    wake(task.id);
    return task;
  });
  typed.post("/api/tasks/:taskId/archive", { schema: { params: TaskIdParamsSchema, body: TaskArchiveBodySchema.optional(), response: { 200: TaskArchiveResponseSchema } } }, async request => tasks.archiveTask(request.forgeUser.id, request.params.taskId, request.body?.confirmDiscardDirty));
  typed.post("/api/tasks/:taskId/unarchive", { schema: taskResponse }, async request => tasks.unarchiveTask(request.forgeUser.id, request.params.taskId));
  typed.get("/api/tasks/:taskId/activity", { schema: { params: TaskIdParamsSchema, response: { 200: TaskActivityResponseSchema } } }, async (request, reply) => reply.header("Cache-Control", "private, no-store").send(tasks.getTaskActivity(request.forgeUser.id, request.params.taskId)));
  typed.get("/api/tasks/:taskId/diff", { schema: { params: TaskIdParamsSchema, response: { 200: TaskDiffResponseSchema } } }, async (request, reply) => {
    const result = await readTaskDiff(tasks.getTask(request.forgeUser.id, request.params.taskId));
    tasks.getTask(request.forgeUser.id, request.params.taskId);
    return reply.header("Cache-Control", "private, no-store").send(result);
  });
  typed.get("/api/tasks/:taskId/diff/summary", { schema: { params: TaskIdParamsSchema, response: { 200: TaskDiffSummaryResponseSchema } } }, async (request, reply) => {
    const result = await readTaskDiffSummary(tasks.getTask(request.forgeUser.id, request.params.taskId));
    tasks.getTask(request.forgeUser.id, request.params.taskId);
    return reply.header("Cache-Control", "private, no-store").send(result);
  });
  typed.get("/api/tasks/:taskId/checks", { schema: { params: TaskIdParamsSchema, response: { 200: TaskChecksResponseSchema } } }, async (request, reply) => {
    const result = await readTaskChecks(tasks.getTask(request.forgeUser.id, request.params.taskId));
    tasks.getTask(request.forgeUser.id, request.params.taskId);
    return reply.header("Cache-Control", "private, no-store").send(result);
  });
  for (const kind of ["artifacts", "images"] as const) typed.get(`/api/tasks/:taskId/${kind}/:artifactId`, { schema: { params: TaskArtifactParamsSchema } }, async (request, reply) => {
    const result = await tasks.getTaskArtifact(request.forgeUser.id, request.params.taskId, request.params.artifactId);
    return reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").type(result.artifact.mimeType).send(result.bytes);
  });
};

export default tasks;

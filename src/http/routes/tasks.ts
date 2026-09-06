import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { AnalyticsResponseSchema, TaskCostsResponseSchema } from "../../task-analytics-contracts.js";
import { usageMetrics } from "../../task-analytics-metrics.js";
import type { TaskService } from "../../tasks.js";
import type { TaskHost } from "../../task-host.js";
import type { ForgeConfig } from "../../config.js";
import { readTaskAgentStatuses } from "../../task-agent-status.js";
import { TaskAgentsResponseSchema, TaskArchiveBodySchema, TaskArchiveResponseSchema } from "../contracts/tasks.js";
import { readTaskChecks, readTaskDiff } from "../../task-inspection.js";
import { readTaskExecution } from "../../task-execution.js";
import { TaskTimelineResponseSchema } from "../../task-timeline-contracts.js";
import { TaskExecutionResponseSchema } from "../../task-execution-contracts.js";
import { TaskChecksResponseSchema, TaskDiffResponseSchema } from "../contracts/tasks.js";
import { CompanyIdParamsSchema, TaskArtifactParamsSchema, TaskIdParamsSchema } from "../contracts/common.js";
import { MAX_TASK_REQUEST_BYTES, TaskActivityResponseSchema, TaskAnswerBodySchema, TaskBodySchema, TaskDetailsBodySchema, TaskListResponseSchema, TaskNoteBodySchema, TaskResponseSchema } from "../contracts/tasks.js";

export interface TaskRoutesOptions { tasks: TaskService; host?: Pick<TaskHost, "recover">; config?: Pick<ForgeConfig, "databasePath"> }

const tasks: FastifyPluginAsync<TaskRoutesOptions> = async (app, { tasks, host, config }) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
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
  typed.post("/api/companies/:companyId/tasks", { bodyLimit: MAX_TASK_REQUEST_BYTES, schema: { params: CompanyIdParamsSchema, body: TaskBodySchema, response: { 200: TaskResponseSchema, 201: TaskResponseSchema } } }, async (request, reply) => {
    const result = await tasks.createTask(request.forgeUser.id, request.params.companyId, request.body);
    if (result.task.status === "active") wake(result.task.id);
    return reply.code(result.created ? 201 : 200).send(result.task);
  });
  typed.get("/api/tasks/:taskId", { schema: taskResponse }, async (request, reply) => reply.header("Cache-Control", "private, no-store").send(tasks.getTask(request.forgeUser.id, request.params.taskId)));
  typed.patch("/api/tasks/:taskId", { schema: { ...taskResponse, body: TaskDetailsBodySchema } }, async request => tasks.updateTaskDetails(request.forgeUser.id, request.params.taskId, request.body));
  typed.post("/api/tasks/:taskId/start", { schema: taskResponse }, async request => {
    const task = tasks.startTask(request.forgeUser.id, request.params.taskId);
    wake(task.id);
    return task;
  });
  typed.post("/api/tasks/:taskId/answer", { schema: { ...taskResponse, body: TaskAnswerBodySchema } }, async request => {
    const task = tasks.answerTask(request.forgeUser.id, request.params.taskId, request.body.questionId, request.body.answer, request.body.confirmCommandsStopped);
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

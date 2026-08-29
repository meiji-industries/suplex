import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { ForgeDatabase } from "../../database.js";
import { TaskArchiveService } from "../../task-archive.js";
import type { TaskService } from "../../tasks.js";
import { TaskIdParamsSchema } from "../contracts/common.js";
import { ArchiveTaskBodySchema, TaskResponseSchema } from "../contracts/tasks.js";

export interface TaskArchiveRoutesOptions { tasks: TaskService; database: ForgeDatabase; archive?: TaskArchiveService; }

const taskArchive: FastifyPluginAsync<TaskArchiveRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const archive = options.archive ?? new TaskArchiveService(options.tasks, options.database);
  typed.post("/api/tasks/:taskId/archive", { schema: { params: TaskIdParamsSchema, body: ArchiveTaskBodySchema, response: { 200: z.discriminatedUnion("status", [z.object({ status: z.literal("archived"), task: TaskResponseSchema }), z.object({ status: z.literal("confirmation_required"), dirtyFileCount: z.number().int().nonnegative(), task: TaskResponseSchema })]) } } }, async (request, reply) => reply.send(await archive.archiveTask(request.forgeUser.id, request.params.taskId, request.body.expectedRevision, request.body.confirmDiscardDirty === undefined ? {} : { confirmDiscardDirty: request.body.confirmDiscardDirty })));
  typed.post("/api/tasks/:taskId/unarchive", { schema: { params: TaskIdParamsSchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(archive.unarchiveTask(request.forgeUser.id, request.params.taskId)));
};

export default taskArchive;

import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { TaskService } from "../../tasks.js";
import { TaskIdParamsSchema } from "../contracts/common.js";
import { TaskBranchSyncResponseSchema } from "../contracts/task-branch.js";

export interface TaskBranchRoutesOptions {
  tasks: TaskService;
}

const taskBranch: FastifyPluginAsync<TaskBranchRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const schema = { params: TaskIdParamsSchema, response: { 200: TaskBranchSyncResponseSchema, 409: z.object({ error: z.string() }) } };
  typed.get("/api/tasks/:taskId/branch-sync", { schema }, async (request, reply) => reply.header("Cache-Control", "private, no-store").send(await options.tasks.getBranchSync(request.forgeUser.id, request.params.taskId)));
  typed.post("/api/tasks/:taskId/push-branch", { schema }, async (request, reply) => reply.send(await options.tasks.pushBranch(request.forgeUser.id, request.params.taskId)));
};

export default taskBranch;

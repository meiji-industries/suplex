import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import { ACTIVE_PHASES } from "../../issue-phases.js";
import type { TaskService } from "../../tasks.js";
import { CompanyIdParamsSchema, TaskIdParamsSchema } from "../contracts/common.js";
import { CompanyBranchSyncResponseSchema, TaskBranchSyncResponseSchema, type CompanyBranchSyncResponse } from "../contracts/task-branch.js";

export interface TaskBranchRoutesOptions {
  tasks: TaskService;
}

const taskBranch: FastifyPluginAsync<TaskBranchRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const schema = { params: TaskIdParamsSchema, response: { 200: TaskBranchSyncResponseSchema, 409: z.object({ error: z.string() }) } };
  typed.get("/api/companies/:companyId/branch-sync", { schema: { params: CompanyIdParamsSchema, response: { 200: CompanyBranchSyncResponseSchema } } }, async (request, reply) => {
    const taskIds = options.tasks.listTasks(request.forgeUser.id, request.params.companyId).filter((task) => ACTIVE_PHASES.has(task.phase)).map((task) => task.id);
    const sync: CompanyBranchSyncResponse = {};
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, taskIds.length) }, async () => {
      while (next < taskIds.length) {
        const taskId = taskIds[next++];
        if (!taskId) continue;
        const status = await options.tasks.getBranchSync(request.forgeUser.id, taskId);
        if (!("available" in status)) sync[taskId] = { ahead: status.ahead, behind: status.behind, aheadOfBase: status.aheadOfBase, behindBase: status.behindBase, conflictsWithBase: status.conflictsWithBase, remoteExists: status.remoteExists };
      }
    }));
    return reply.header("Cache-Control", "private, no-store").send(sync);
  });
  typed.get("/api/tasks/:taskId/branch-sync", { schema }, async (request, reply) => reply.header("Cache-Control", "private, no-store").send(await options.tasks.getBranchSync(request.forgeUser.id, request.params.taskId)));
  typed.post("/api/tasks/:taskId/push-branch", { schema }, async (request, reply) => reply.send(await options.tasks.pushBranch(request.forgeUser.id, request.params.taskId)));
};

export default taskBranch;

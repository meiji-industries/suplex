import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import { reconcile } from "../../reconcile.js";
import { getIssueEngine } from "../../engine/index.js";
import type { TaskService } from "../../tasks.js";
import { TaskIdParamsSchema } from "../contracts/common.js";

export interface TaskRefreshRoutesOptions {
  tasks: TaskService;
  database: ForgeDatabase;
  config: ForgeConfig;
  reconcile?: typeof reconcile;
}

const taskRefresh: FastifyPluginAsync<TaskRefreshRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post("/api/tasks/:taskId/refresh", { schema: { params: TaskIdParamsSchema } }, async (request, reply) => {
    options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const result = await (options.reconcile ?? reconcile)(options.database, options.config, getIssueEngine(options.config), { force: true, logger: app.log });
    return reply.header("Cache-Control", "private, no-store").send(result);
  });
};

export default taskRefresh;

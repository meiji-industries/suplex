import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import { refreshTaskFromGithub, type GithubReconciliationResult } from "../../github-observation-reconciliation.js";
import type { TaskService } from "../../tasks.js";
import { reconcileWorktrees, type WorktreeReconciliationResult } from "../../worktree-reconciliation.js";
import { TaskIdParamsSchema } from "../contracts/common.js";

export interface TaskRefreshRoutesOptions {
  tasks: TaskService;
  database: ForgeDatabase;
  config: ForgeConfig;
  refreshGithub?: (database: ForgeDatabase, config: ForgeConfig, taskId: string) => Promise<GithubReconciliationResult>;
  refreshWorktrees?: (database: ForgeDatabase, config: ForgeConfig, options: { taskId: string }) => Promise<WorktreeReconciliationResult>;
}

const taskRefresh: FastifyPluginAsync<TaskRefreshRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const refreshGithub = options.refreshGithub ?? refreshTaskFromGithub;
  const refreshWorktrees = options.refreshWorktrees ?? reconcileWorktrees;
  typed.post("/api/tasks/:taskId/refresh", { schema: { params: TaskIdParamsSchema } }, async (request, reply) => {
    options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const [github, worktrees] = await Promise.all([
      refreshGithub(options.database, options.config, request.params.taskId),
      refreshWorktrees(options.database, options.config, { taskId: request.params.taskId }),
    ]);
    return reply.header("Cache-Control", "private, no-store").send({ github, worktrees });
  });
};

export default taskRefresh;

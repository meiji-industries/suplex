import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import type { ForgeDatabase } from "../../database.js";
import { CliHerdrClient, type HerdrClient } from "../../herdr-client.js";
import type { TaskService } from "../../tasks.js";
import { TaskIdParamsSchema } from "../contracts/common.js";
import { TaskPaneResponseSchema } from "../contracts/tasks.js";

export interface TaskPaneRoutesOptions {
  tasks: TaskService;
  database: ForgeDatabase;
  herdr?: Pick<HerdrClient, "readAgent">;
}

const taskPane: FastifyPluginAsync<TaskPaneRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const herdr = options.herdr ?? new CliHerdrClient();
  typed.get("/api/tasks/:taskId/pane", { schema: { params: TaskIdParamsSchema, response: { 200: TaskPaneResponseSchema } } }, async (request, reply) => {
    options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const sessions = options.database.authQuery((db) => db.prepare("SELECT session_role AS role, agent_name AS agentName FROM forge_herdr_role_sessions WHERE task_id = ? AND is_current = 1 AND agent_name IS NOT NULL ORDER BY CASE session_role WHEN 'lead' THEN 0 WHEN 'developer' THEN 1 ELSE 2 END").all(request.params.taskId) as Array<{ role: string; agentName: string }>);
    const panes = await Promise.all(sessions.map(async ({ role, agentName }) => ({ role, text: await herdr.readAgent(agentName, "recent-unwrapped", 120, "ansi").catch(() => "") })));
    return reply.send({ panes });
  });
};

export default taskPane;

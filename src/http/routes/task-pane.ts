import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

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
  typed.get("/api/tasks/:taskId/pane", { schema: { params: TaskIdParamsSchema, querystring: z.object({ role: z.enum(["developer", "lead"]) }), response: { 200: TaskPaneResponseSchema } } }, async (request, reply) => {
    options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const agentName = options.database.authQuery((db) => (db.prepare("SELECT agent_name FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(request.params.taskId, request.query.role) as { agent_name: string | null } | undefined)?.agent_name);
    return reply.send({ text: agentName ? await herdr.readAgent(agentName, "recent-unwrapped", 120).catch(() => "") : "" });
  });
};

export default taskPane;

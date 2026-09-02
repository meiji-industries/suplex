import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ForgeDatabase } from "../../database.js";
import { CliHerdrClient, type HerdrClient } from "../../herdr-client.js";
import type { TaskService } from "../../tasks.js";
import { TaskIdParamsSchema } from "../contracts/common.js";
import { TaskPaneResponseSchema } from "../contracts/tasks.js";

export interface TaskPaneRoutesOptions {
  tasks: TaskService;
  database: ForgeDatabase;
  herdr?: Pick<HerdrClient, "readAgent" | "sendText" | "sendKeys" | "attachCommand">;
}

const PaneRoleSchema = z.enum(["planner", "builder", "reviewer", "integrator"]);
const TaskPaneInputParamsSchema = TaskIdParamsSchema.extend({ role: PaneRoleSchema });
const TaskPaneInputBodySchema = z.union([
  z.object({ text: z.string().max(20_000) }).strict(),
  z.object({ keys: z.array(z.string()).max(16) }).strict(),
]);

const taskPane: FastifyPluginAsync<TaskPaneRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const herdr = options.herdr ?? new CliHerdrClient();
  typed.get("/api/tasks/:taskId/pane", { schema: { params: TaskIdParamsSchema, response: { 200: TaskPaneResponseSchema } } }, async (request, reply) => {
    options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const sessions = options.database.authQuery((db) => db.prepare("SELECT session_role AS role, agent_name AS agentName, status FROM forge_herdr_role_sessions WHERE task_id = ? AND is_current = 1 AND agent_name IS NOT NULL ORDER BY CASE session_role WHEN 'planner' THEN 0 WHEN 'builder' THEN 1 WHEN 'reviewer' THEN 2 ELSE 3 END").all(request.params.taskId) as Array<{ role: string; agentName: string; status: string | null }>);
    const panes = await Promise.all(sessions.map(async ({ role, agentName, status }) => ({ role, agentName, status, attachCommand: herdr.attachCommand(agentName), text: await herdr.readAgent(agentName, "recent-unwrapped", 120, "ansi").catch(() => "") })));
    return reply.send({ panes });
  });
  typed.post("/api/tasks/:taskId/pane/:role/input", {
    onRequest: async (request, reply) => {
      if (!PaneRoleSchema.safeParse(request.params.role).success) return reply.code(404).send({ error: "no live session" });
    },
    schema: { params: TaskPaneInputParamsSchema, body: TaskPaneInputBodySchema },
  }, async (request, reply) => {
    const role = request.params.role;
    const task = options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const session = options.database.authQuery((db) => db.prepare("SELECT agent_name AS agentName FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1 AND agent_name IS NOT NULL").get(request.params.taskId, role) as { agentName: string } | undefined);
    if (!session) return reply.code(404).send({ error: "no live session" });
    if ("text" in request.body) await herdr.sendText(session.agentName, request.body.text);
    else await herdr.sendKeys(session.agentName, request.body.keys);
    const kind = "text" in request.body ? "text" : "keys";
    const length = "text" in request.body ? request.body.text.length : request.body.keys.length;
    options.database.authQuery((db) => db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'pane_input', ?, ?, ?)").run(randomUUID(), request.forgeUser.id, task.companyId, JSON.stringify({ taskId: request.params.taskId, role, kind, length }), new Date().toISOString()));
    return reply.send({ ok: true });
  });
};

export default taskPane;

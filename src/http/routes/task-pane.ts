import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ForgeDatabase } from "../../database.js";
import { CliHerdrClient, type HerdrClient } from "../../herdr-client.js";
import { openHerdrTerminalBridge } from "../../herdr-terminal-bridge.js";
import type { TaskService } from "../../tasks.js";
import type { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import { TaskIdParamsSchema } from "../contracts/common.js";
import { TaskPaneResponseSchema } from "../contracts/tasks.js";

export interface TaskPaneRoutesOptions {
  tasks: TaskService;
  database: ForgeDatabase;
  herdr?: Pick<HerdrClient, "sendText" | "sendKeys" | "attachCommand">;
  auth?: AuthService;
  config?: ForgeConfig;
  openBridge?: typeof openHerdrTerminalBridge;
}

const PaneRoleSchema = z.enum(["planner", "builder", "reviewer", "integrator"]);
const TaskPaneInputParamsSchema = TaskIdParamsSchema.extend({ role: PaneRoleSchema });
const TaskPaneTerminalQuerySchema = z.object({ cols: z.coerce.number().int().default(80), rows: z.coerce.number().int().default(24) });
const TaskPaneInputBodySchema = z.union([
  z.object({ text: z.string().max(20_000) }).strict(),
  z.object({ keys: z.array(z.string()).max(16) }).strict(),
]);

const taskPane: FastifyPluginAsync<TaskPaneRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const herdr = options.herdr ?? new CliHerdrClient();
  const openBridge = options.openBridge ?? openHerdrTerminalBridge;
  typed.get("/api/tasks/:taskId/pane", { schema: { params: TaskIdParamsSchema, response: { 200: TaskPaneResponseSchema } } }, async (request, reply) => {
    options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const sessions = options.database.authQuery((db) => db.prepare("SELECT session_role AS role, pane_id AS paneId, agent_name AS agentName, status FROM forge_herdr_role_sessions WHERE task_id = ? AND is_current = 1 AND agent_name IS NOT NULL ORDER BY CASE session_role WHEN 'planner' THEN 0 WHEN 'builder' THEN 1 WHEN 'reviewer' THEN 2 ELSE 3 END").all(request.params.taskId) as Array<{ role: string; paneId: string | null; agentName: string; status: string | null }>);
    const panes = sessions.map(({ role, paneId, agentName, status }) => ({ role, paneId, agentName, status, attachCommand: herdr.attachCommand(agentName) }));
    return reply.send({ panes });
  });
  typed.get("/api/tasks/:taskId/pane/:role/terminal", {
    websocket: true,
    schema: { params: TaskPaneInputParamsSchema, querystring: TaskPaneTerminalQuerySchema },
  }, (socket, request) => {
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (origin && options.config && origin !== new URL(options.config.reachableAddress).origin) return socket.close(4403, "origin");
    let task: ReturnType<TaskService["getTask"]>;
    try {
      task = options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    } catch {
      socket.close(4404, "not found");
      return;
    }
    const session = options.database.authQuery((db) => db.prepare("SELECT pane_id AS paneId, agent_name AS agentName FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(request.params.taskId, request.params.role) as { paneId: string | null; agentName: string | null } | undefined);
    if (!session?.paneId) {
      socket.send(JSON.stringify({ type: "closed", reason: "no live session" }));
      socket.close(4404, "no live session");
      return;
    }
    let lastWidth: number | undefined;
    let lastHeight: number | undefined;
    const bridge = openBridge({ paneId: session.paneId, cols: request.query.cols, rows: request.query.rows, onEvent: (event) => {
      if (event.type === "frame") {
        if (event.frame.width !== lastWidth || event.frame.height !== lastHeight) {
          lastWidth = event.frame.width;
          lastHeight = event.frame.height;
          socket.send(JSON.stringify({ type: "size", cols: lastWidth, rows: lastHeight }));
        }
        socket.send(event.frame.bytes);
      } else if (event.type === "closed") {
        socket.send(JSON.stringify({ type: "closed", reason: event.reason }));
        socket.close(1000);
      } else socket.send(JSON.stringify({ type: "error", message: event.message }));
    } });
    socket.send(JSON.stringify({ type: "open", paneId: session.paneId, agentName: session.agentName, cols: request.query.cols, rows: request.query.rows }));
    options.database.authQuery((db) => db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'pane_terminal_attached', ?, ?, ?)").run(randomUUID(), request.forgeUser.id, task.companyId, JSON.stringify({ taskId: request.params.taskId, role: request.params.role, paneId: session.paneId }), new Date().toISOString()));
    socket.on("message", (message: Buffer, isBinary: boolean) => {
      if (isBinary) {
        bridge.input(Buffer.from(message));
        return;
      }
      try {
        const command = JSON.parse(message.toString()) as { type?: string; cols?: number; rows?: number; direction?: "up" | "down"; lines?: number };
        if (command.type === "resize" && typeof command.cols === "number" && typeof command.rows === "number") bridge.resize(command.cols, command.rows);
        if (command.type === "scroll" && (command.direction === "up" || command.direction === "down") && typeof command.lines === "number") bridge.scroll(command.direction, command.lines);
      } catch {
        // Ignore malformed terminal commands.
      }
    });
    socket.once("close", () => bridge.release());
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

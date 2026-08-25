import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import type { TaskService } from "../../tasks.js";
import { TaskIdParamsSchema } from "../contracts/common.js";
import { AgentEventHistorySchema, AgentEventQuerySchema } from "../contracts/agent-events.js";

export interface AgentEventRoutesOptions { tasks: TaskService }

const agentEvents: FastifyPluginAsync<AgentEventRoutesOptions> = async (app, { tasks }) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/tasks/:taskId/agent-events", { schema: { params: TaskIdParamsSchema, querystring: AgentEventQuerySchema, response: { 200: AgentEventHistorySchema } } }, async (request, reply) => {
    const after = cursor(request.headers["last-event-id"]) ?? request.query.after ?? 0;
    const history = () => tasks.getAgentEventHistory(request.forgeUser.id, request.params.taskId, after, 200);
    if (!request.headers.accept?.includes("text/event-stream")) return reply.header("Cache-Control", "private, no-store").send(history());
    let closed = false;
    let last = after;
    let status = "";
    let timer: NodeJS.Timeout | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (keepalive) clearInterval(keepalive);
    };
    const send = (): void => {
      if (closed || reply.raw.destroyed) return close();
      try {
        const current = tasks.getAgentEventHistory(request.forgeUser.id, request.params.taskId, last, 200);
        for (const event of current.events) {
          reply.raw.write(`id: ${event.streamId}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`);
          last = event.streamId;
        }
        const nextStatus = JSON.stringify(current.status);
        if (nextStatus !== status) {
          reply.raw.write(`event: status\ndata: ${nextStatus}\n\n`);
          status = nextStatus;
        }
      } catch {
        reply.raw.write("event: error\ndata: {\"code\":\"agent-events-unavailable\"}\n\n");
        close();
        reply.raw.end();
      }
    };
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", Connection: "keep-alive" });
    send();
    if (!closed) timer = setInterval(send, 750);
    if (!closed) keepalive = setInterval(() => { if (!closed && reply.raw.writable) reply.raw.write(": keepalive\n\n"); }, 15_000);
    request.raw.on("close", close);
    return reply;
  });
};

function cursor(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

export default agentEvents;

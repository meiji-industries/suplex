import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { TaskService } from "../../tasks.js";
import { TaskIdParamsSchema } from "../contracts/common.js";

export interface DevelopmentEventRoutesOptions { tasks: TaskService }

const developmentEvents: FastifyPluginAsync<DevelopmentEventRoutesOptions> = async (app, { tasks }) => {
  const liveEvents = (path: string, prefix: string, progress: (userId: string, taskId: string, cursor?: { executionId: string; sequence: number }) => ReturnType<TaskService["getDeveloperProgress"]>) => app.withTypeProvider<ZodTypeProvider>().get(path, { schema: { params: TaskIdParamsSchema, querystring: z.object({ cursor: z.string().optional() }) } }, async (request, reply) => {
    const header = request.headers["last-event-id"];
    const match = new RegExp(`^(${prefix}_[a-f0-9]{24}):(\\d+)$`).exec(request.query.cursor ?? (Array.isArray(header) ? header[0] : header) ?? "");
    let cursor = match ? { executionId: match[1]!, sequence: Number(match[2]) } : undefined;
    let previous = "";
    let closed = false;
    let interval: NodeJS.Timeout | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    const stop = (destroy = false): void => {
      if (closed) return;
      closed = true;
      if (interval) clearInterval(interval);
      if (keepalive) clearInterval(keepalive);
      if (destroy && !reply.raw.destroyed) reply.raw.destroy();
    };
    const send = (): void => {
      if (closed || reply.raw.destroyed) return stop();
      try {
        const current = progress(request.forgeUser.id, request.params.taskId, cursor);
        const status = JSON.stringify({ status: current.status, execution: current.execution });
        if (status !== previous) { reply.raw.write(`event: status\ndata: ${status}\n\n`); previous = status; }
        if (!current.execution?.id) return;
        for (const event of current.events) {
          const id = `${current.execution.id}:${event.sequence}`;
          reply.raw.write(`id: ${id}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = { executionId: current.execution.id, sequence: event.sequence };
        }
      } catch { stop(true); }
    };
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", Connection: "keep-alive" });
    send();
    if (!closed) interval = setInterval(send, 750);
    if (!closed) keepalive = setInterval(() => { try { if (!closed && reply.raw.writable) reply.raw.write(": keepalive\n\n"); } catch { stop(true); } }, 15_000);
    request.raw.on("close", stop);
    return reply;
  });
  liveEvents("/api/tasks/:taskId/development-events", "developer", (userId, taskId, cursor) => tasks.getDeveloperProgress(userId, taskId, cursor));
  liveEvents("/api/tasks/:taskId/planning-events", "agent", (userId, taskId, cursor) => tasks.getPlanningProgress(userId, taskId, cursor));
};

export default developmentEvents;

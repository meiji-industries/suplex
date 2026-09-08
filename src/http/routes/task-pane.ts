import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { openHerdrTerminalBridge } from "../../herdr-terminal-bridge.js";
import type { TaskService } from "../../tasks.js";
import type { ForgeConfig } from "../../config.js";
import { TaskSessionKindSchema } from "../../task-control.js";
import { TaskIdParamsSchema } from "../contracts/common.js";

export interface TaskPaneRoutesOptions { tasks: TaskService; config?: ForgeConfig; openBridge?: typeof openHerdrTerminalBridge }
const Params = TaskIdParamsSchema.extend({ role: TaskSessionKindSchema });
const Query = z.object({ cols: z.coerce.number().int().min(20).max(300).default(80), rows: z.coerce.number().int().min(5).max(150).default(24) });

export function originAllowed(origin: string | undefined, host: string | undefined, reachableAddress: string | undefined): boolean {
  if (!origin) return true;
  try { const url = new URL(origin); return url.origin === (reachableAddress ? new URL(reachableAddress).origin : undefined) || url.host === host; }
  catch { return false; }
}

const taskPane: FastifyPluginAsync<TaskPaneRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/tasks/:taskId/pane/:role/terminal", { websocket: true, schema: { params: Params, querystring: Query } }, (socket, request) => {
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!originAllowed(origin, request.headers.host, options.config?.reachableAddress)) return socket.close(4403, "origin");
    const current = () => options.tasks.getTaskActivity(request.forgeUser.id, request.params.taskId).sessions.find(session => session.kind === request.params.role && session.current);
    let session: ReturnType<typeof current>;
    try { session = current(); } catch { return socket.close(4404, "not found"); }
    if (!session?.paneId) return socket.close(4404, "no attachment");
    const paneId = session.paneId;
    const bridge = (options.openBridge ?? openHerdrTerminalBridge)({ paneId, cols: request.query.cols, rows: request.query.rows, onEvent: event => {
      if (event.type === "frame") {
        socket.send(JSON.stringify({ type: "size", cols: event.frame.width, rows: event.frame.height }));
        socket.send(event.frame.bytes);
      } else if (event.type === "closed") socket.close(1000, event.reason.slice(0, 100));
      else socket.send(JSON.stringify({ type: "error", message: event.message }));
    } });
    const accessCheck = setInterval(() => {
      try { if (current()?.paneId !== paneId) socket.close(4404, "attachment changed"); }
      catch { socket.close(4403, "access revoked"); }
    }, 1_000);
    accessCheck.unref();
    socket.send(JSON.stringify({ type: "open", paneId, readOnly: true, cols: request.query.cols, rows: request.query.rows }));
    socket.once("close", () => { clearInterval(accessCheck); bridge.release(); });
  });
};

export default taskPane;

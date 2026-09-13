import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { openHerdrTerminalBridge } from "../../integrations/herdr/terminal-bridge.js";
import type { TaskService } from "../../tasks/tasks.js";
import type { ForgeConfig } from "../../platform/config.js";
import { TaskSessionKindSchema } from "../../tasks/control.js";
import { TaskIdParamsSchema } from "../contracts/common.js";
import { json } from "../../shared/json.js";

export interface TaskPaneRoutesOptions { tasks: TaskService; config?: ForgeConfig; openBridge?: typeof openHerdrTerminalBridge }
const Params = TaskIdParamsSchema.extend({ role: TaskSessionKindSchema.or(z.literal("shell")) });
const Query = z.object({ cols: z.coerce.number().int().min(20).max(300).default(80), rows: z.coerce.number().int().min(5).max(150).default(24) });

/** Close code for a terminal control bridge displaced by a newer controller. */
export const TERMINAL_TAKEOVER_CLOSE_CODE = 4498;

export function originAllowed(origin: string | undefined, host: string | undefined, reachableAddress: string | undefined): boolean {
  if (!origin) return true;
  try { const url = new URL(origin); return url.origin === (reachableAddress ? new URL(reachableAddress).origin : undefined) || url.host === host; }
  catch { return false; }
}

const taskPane: FastifyPluginAsync<TaskPaneRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/tasks/:taskId/pane/:role/terminal", { websocket: true, schema: { params: Params, querystring: Query } }, async (socket, request) => {
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!originAllowed(origin, request.headers.host, options.config?.reachableAddress)) return socket.close(4403, "origin");
    const shell = request.params.role === "shell";
    const current = () => {
      const activity = options.tasks.getTaskActivity(request.forgeUser.id, request.params.taskId);
      return shell ? (activity.shellPaneId ? { paneId: activity.shellPaneId } : undefined) : activity.sessions.find(session => session.kind === request.params.role && session.current);
    };
    let paneId: string | null;
    if (shell) {
      try { paneId = await options.tasks.taskShellPane(request.forgeUser.id, request.params.taskId); }
      catch { return socket.close(4404, "not found"); }
      if (!paneId) return socket.close(4404, "no shell pane");
    } else {
      let session: ReturnType<typeof current>;
      try { session = current(); } catch { return socket.close(4404, "not found"); }
      if (!session?.paneId) return socket.close(4404, "no attachment");
      paneId = session.paneId;
    }
    const bridge = (options.openBridge ?? openHerdrTerminalBridge)({ paneId, cols: request.query.cols, rows: request.query.rows, mode: shell ? "control" : "observe", onEvent: event => {
      if (event.type === "frame") {
        socket.send(JSON.stringify({ type: "size", cols: event.frame.width, rows: event.frame.height }));
        socket.send(event.frame.bytes);
      } else if (event.type === "closed") socket.close(event.reason.includes("taken over") ? TERMINAL_TAKEOVER_CLOSE_CODE : 1000, event.reason.slice(0, 100));
      else socket.send(JSON.stringify({ type: "error", message: event.message }));
    } });
    const accessCheck = setInterval(() => {
      try { if (current()?.paneId !== paneId) socket.close(4404, "attachment changed"); }
      catch { socket.close(4403, "access revoked"); }
    }, 1_000);
    accessCheck.unref();
    socket.send(JSON.stringify({ type: "open", paneId, readOnly: !shell, cols: request.query.cols, rows: request.query.rows }));
    if (shell) socket.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) { bridge.input(bytes); return; }
      const message = json<Record<string, unknown> | null>(bytes.toString(), null);
      if (!message) return;
      if (message.type === "resize" && Number.isFinite(Number(message.cols)) && Number.isFinite(Number(message.rows))) bridge.resize(Number(message.cols), Number(message.rows));
      else if (message.type === "scroll" && (message.direction === "up" || message.direction === "down") && Number.isFinite(Number(message.lines))) bridge.scroll(message.direction, Number(message.lines));
    });
    socket.once("close", () => { clearInterval(accessCheck); bridge.release(); });
  });
};

export default taskPane;

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { AuthService } from "../../identity/auth.js";
import { CliHerdrClient } from "../../integrations/herdr/client.js";
import { openHerdrTerminalBridge } from "../../integrations/herdr/terminal-bridge.js";
import type { ForgeConfig } from "../../platform/config.js";
import type { ProviderInstanceService } from "../../profiles/provider-instances.js";
import { ProviderLoginService, providerLoginCommand, type ProviderLoginPort } from "../../profiles/provider-login.js";
import { json } from "../../shared/json.js";
import { ErrorResponseSchema } from "../contracts/common.js";
import { ProviderLoginResponseSchema } from "../contracts/providers.js";
import { HarnessKindSchema, type HarnessKind } from "../../runtimes/harness-kind.js";
import { originAllowed, TERMINAL_TAKEOVER_CLOSE_CODE } from "./task-pane.js";

export interface ProviderLoginRoutesOptions {
  auth?: Pick<AuthService, "getUserForAuthority">;
  providerInstances?: ProviderInstanceService;
  logins?: ProviderLoginService;
  herdr?: ProviderLoginPort;
  config?: ForgeConfig;
  openBridge?: typeof openHerdrTerminalBridge;
  loginCommand?: (providerId: HarnessKind, homeDirectory?: string | null) => Promise<string>;
}

const TerminalParams = z.object({ paneId: z.string().min(1) });
const TerminalQuery = z.object({ cols: z.coerce.number().int().min(20).max(300).default(80), rows: z.coerce.number().int().min(5).max(150).default(24) });

const providerLogin: FastifyPluginAsync<ProviderLoginRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const logins = options.logins ?? new ProviderLoginService(options.herdr ?? new CliHerdrClient());
  const loginCommand = options.loginCommand ?? providerLoginCommand;
  const requireAdmin = (role: string, reply: FastifyReply): boolean => {
    if (role === "admin") return true;
    reply.code(403).send({ error: "Administrator access required" });
    return false;
  };
  const start = async (request: FastifyRequest, reply: FastifyReply, input: { target: string; label: string; command: string }) => {
    try {
      const session = await logins.start({ ...input, cwd: process.cwd() });
      return await reply.header("Cache-Control", "private, no-store").send({ paneId: session.paneId });
    } catch (error) {
      request.log.warn({ err: error }, "Provider sign-in pane could not start");
      return await reply.code(503).send({ error: "Forge could not open a sign-in pane. Check Herdr on the Forge host." });
    }
  };
  typed.post("/api/admin/providers/:providerId/login", { schema: { params: z.object({ providerId: HarnessKindSchema }), response: { 200: ProviderLoginResponseSchema, 400: ErrorResponseSchema, 403: ErrorResponseSchema, 503: ErrorResponseSchema } } }, async (request, reply) => {
    if (!requireAdmin(request.forgeUser.role, reply)) return;
    return start(request, reply, { target: `provider:${request.params.providerId}`, label: request.params.providerId, command: await loginCommand(request.params.providerId) });
  });
  if (options.providerInstances) {
    const providerInstances = options.providerInstances;
    typed.post("/api/admin/provider-instances/:instanceId/login", { schema: { params: z.object({ instanceId: z.string().min(1) }), response: { 200: ProviderLoginResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema, 503: ErrorResponseSchema } } }, async (request, reply) => {
      if (!requireAdmin(request.forgeUser.role, reply)) return;
      const instance = providerInstances.list(request.forgeUser.id).find(candidate => candidate.id === request.params.instanceId);
      if (!instance) return reply.code(404).send({ error: "Not found" });
      return start(request, reply, { target: `instance:${instance.id}`, label: instance.label, command: await loginCommand(instance.provider, instance.homeDirectory) });
    });
  }
  typed.delete("/api/admin/provider-login/:paneId", { schema: { params: TerminalParams, response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema } } }, async (request, reply) => {
    if (!requireAdmin(request.forgeUser.role, reply)) return;
    if (!await logins.close(request.params.paneId)) return reply.code(404).send({ error: "Not found" });
    return reply.code(204).send(null);
  });
  typed.get("/api/admin/provider-login/:paneId/terminal", { websocket: true, schema: { params: TerminalParams, querystring: TerminalQuery } }, async (socket, request) => {
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!originAllowed(origin, request.headers.host, options.config?.reachableAddress)) return socket.close(4403, "origin");
    if (request.forgeUser.role !== "admin") return socket.close(4403, "access");
    if (!logins.get(request.params.paneId)) return socket.close(4404, "not found");
    const paneId = request.params.paneId;
    const bridge = (options.openBridge ?? openHerdrTerminalBridge)({ paneId, cols: request.query.cols, rows: request.query.rows, mode: "control", onEvent: event => {
      if (event.type === "frame") {
        socket.send(JSON.stringify({ type: "size", cols: event.frame.width, rows: event.frame.height }));
        socket.send(event.frame.bytes);
      } else if (event.type === "closed") socket.close(event.reason.includes("taken over") ? TERMINAL_TAKEOVER_CLOSE_CODE : 1000, event.reason.slice(0, 100));
      else socket.send(JSON.stringify({ type: "error", message: event.message }));
    } });
    const accessCheck = setInterval(() => {
      const user = options.auth?.getUserForAuthority(request.forgeUser.id);
      if (options.auth && user?.role !== "admin") socket.close(4403, "access revoked");
      else if (!logins.get(paneId)) socket.close(4404, "pane closed");
    }, 1_000);
    accessCheck.unref();
    socket.send(JSON.stringify({ type: "open", paneId, readOnly: false, cols: request.query.cols, rows: request.query.rows }));
    socket.on("message", (data, isBinary) => {
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

export default providerLogin;

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { OAuthService } from "../../identity/oauth.js";
import type { SuplexConfig } from "../../platform/config.js";
import type { TaskHost } from "../../tasks/host.js";
import type { AgentApiGithubPort, TaskService } from "../../tasks/tasks.js";
import { TaskFailure } from "../../tasks/tasks.js";
import { ExternalAgentFailure } from "../../identity/external-agents.js";
import { SUPLEX_MCP_TOOLS } from "../../integrations/suplex/mcp-bridge.js";
import { SuplexMcpRuntime, presentSuplexMcpResult } from "../../integrations/suplex/mcp-runtime.js";
import { oauthBearerChallenge } from "./oauth.js";

function requestAuthorityAllowed(config: SuplexConfig, host: string | undefined, origin: string | undefined): boolean {
  const canonical = new URL(config.reachableAddress);
  if (host?.toLowerCase() !== canonical.host.toLowerCase()) return false;
  if (origin === undefined) return true;
  try { return new URL(origin).origin === canonical.origin; }
  catch { return false; }
}

export function registerMcpRoutes(app: FastifyInstance, options: { oauth: OAuthService; config: SuplexConfig; tasks: TaskService; agentDelivery: boolean; host?: Pick<TaskHost, "recover">; github?: AgentApiGithubPort }): void {
  const unauthorized = (reply: FastifyReply) => reply.header("WWW-Authenticate", oauthBearerChallenge(options.oauth)).header("Cache-Control", "no-store").code(401).send({ error: "invalid_token" });

  app.post("/mcp", { config: { oauthProtocol: true }, bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    if (!requestAuthorityAllowed(options.config, request.headers.host, Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin)) return reply.code(403).send({ error: "request_origin_invalid" });
    const authorization = request.headers.authorization;
    if (!authorization || !authorization.startsWith("Bearer ") || authorization.includes(",")) return unauthorized(reply);
    let principal;
    try { principal = options.oauth.authenticateAccessToken(authorization.slice(7).trim()); }
    catch { return unauthorized(reply); }

    const runtime = new SuplexMcpRuntime({ principal, tasks: options.tasks, agentDelivery: options.agentDelivery, ...(options.host ? { host: options.host } : {}), ...(options.github ? { github: options.github } : {}), logRecoveryFailure: (taskId, error) => app.log.warn({ taskId, err: error }, "Task recovery will be retried") });
    const server = new Server({ name: "suplex", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...SUPLEX_MCP_TOOLS] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const result = await runtime.call(params.name, (params.arguments ?? {}) as Record<string, unknown>);
        const presented = presentSuplexMcpResult(result);
        return { content: [{ type: "text", text: JSON.stringify(presented) }], structuredContent: presented as Record<string, unknown>, ...(result.status >= 400 ? { isError: true } : {}) };
      } catch (error) {
        const result = error instanceof TaskFailure || error instanceof ExternalAgentFailure
          ? { status: error.statusCode, body: { error: error.publicMessage, code: error.code } }
          : error instanceof z.ZodError
            ? { status: 400, body: { error: "Invalid request", code: "request_invalid" } }
            : { status: 500, body: { error: "Internal server error", code: "internal_error" } };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.hijack();
    try {
      // SDK v1's optional callback types predate exactOptionalPropertyTypes. Runtime compatibility is verified by the official client test.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", { config: { oauthProtocol: true } }, async (_request, reply) => reply.header("Allow", "POST").code(405).send({ error: "method_not_allowed" }));
  }
}

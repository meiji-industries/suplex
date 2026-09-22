import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";

import type { AuthService, AuthUser } from "./identity/auth.js";
import type { ForgeDatabase } from "./platform/database.js";
import type { ForgeConfig } from "./platform/config.js";
import type { TaskHost } from "./tasks/host.js";
import type { ExternalAgentService } from "./identity/external-agents.js";
import type { OAuthService } from "./identity/oauth.js";
import type { AgentDeliveryService } from "./delivery/agent-delivery.js";
import type { ReadProviders } from "./profiles/provider-catalog.js";
import type { ProviderLoginPort } from "./profiles/provider-login.js";
import { inspectHostHealth, inspectProviderChecks, type HealthSnapshot, type HostHealthDependencies } from "./platform/health.js";
import type { UpdateResponse, UpdateRestartResponse } from "./http/contracts/update.js";
import type { AgentProfileService } from "./profiles/agent-profiles.js";
import type { ProviderInstanceService } from "./profiles/provider-instances.js";
import type { ProjectService } from "./projects/projects.js";
import type { TaskService } from "./tasks/tasks.js";
import type { TaskTemplateService } from "./tasks/templates.js";
import type { WorkflowRecordService } from "./coordination/workflow-records.js";
import type { GithubTriggerService } from "./integrations/github/triggers.js";
import { HealthSnapshotSchema } from "./platform/schemas.js";
import type { ProviderHarnessKind } from "./platform/health-contract.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "./identity/auth-identifiers.js";
import { installHttpErrorHandlers } from "./http/errors.js";
import { isLoopbackHost } from "./http/session.js";
import { isAgentApiRuntimeRequest } from "./http/agent-api-runtime.js";
import { isOAuthProtocolRequest } from "./http/oauth-runtime.js";
import authRoutes from "./http/routes/auth.js";
import authenticated from "./http/routes/authenticated.js";
import assets from "./http/routes/assets.js";
import health, { cachedHealthReader } from "./http/routes/health.js";
import pages from "./http/routes/pages.js";
import discovery from "./http/routes/discovery.js";
import agentPairing from "./http/routes/agent-pairing.js";
import { registerAgentApiTaskRoutes } from "./http/routes/agent-api.js";
import type { AgentApiGithubPort } from "./tasks/tasks.js";
import taskTemplates from "./http/routes/task-templates.js";
import workflowRoutes from "./http/routes/workflows.js";
import githubTriggerRoutes from "./http/routes/github-triggers.js";
import oauthRoutes from "./http/routes/oauth.js";
import { registerMcpRoutes } from "./http/routes/mcp.js";
import { runWithSystemEvents, type EventSink } from "./platform/system-events.js";

export interface AppDependencies {
  fullApp?: boolean;
  config: ForgeConfig;
  health: HostHealthDependencies;
  getHealth?: () => Promise<HealthSnapshot>;
  healthNow?: () => number;
  auth?: AuthService;
  projects?: ProjectService;
  profiles?: AgentProfileService;
  providerInstances?: ProviderInstanceService;
  readProviderInstanceReadiness?: (homeDirectory: string) => Promise<{ status: "healthy" | "warning" | "unhealthy"; summary: string }>;
  tasks?: TaskService;
  taskTemplates?: TaskTemplateService;
  workflows?: WorkflowRecordService;
  githubTriggers?: GithubTriggerService;
  host?: Pick<TaskHost, "recover">;
  database?: ForgeDatabase;
  logger?: Logger | false;
  systemEvents?: EventSink;
  externalAgent?: ExternalAgentService;
  oauth?: OAuthService;
  agentDelivery?: AgentDeliveryService;
  agentApiGithub?: AgentApiGithubPort;
  readProviders?: ReadProviders;
  providerLoginHerdr?: ProviderLoginPort;
  readUpdate?: (check: boolean, user: AuthUser) => Promise<UpdateResponse>;
  requestUpdateRestart?: (user: AuthUser) => Promise<UpdateRestartResponse>;
  instanceId?: string;
  https?: { key: Buffer; cert: Buffer };
  frontendDevelopment?: {
    transformIndexHtml(url: string, html: string): Promise<string>;
  };
}

export function createAppServer(dependencies: AppDependencies): FastifyInstance {
  const app = (dependencies.logger === undefined || dependencies.logger === false
    ? Fastify({ logger: false, disableRequestLogging: true, ...(dependencies.https ? { https: dependencies.https } : {}) })
    : Fastify({ loggerInstance: dependencies.logger, disableRequestLogging: true, ...(dependencies.https ? { https: dependencies.https } : {}) })) as unknown as FastifyInstance;
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  void app.register(cookie);
  void app.register(websocket, { options: { maxPayload: 1 << 20 } });
  installHttpErrorHandlers(app);
  if (dependencies.systemEvents) app.addHook("onRequest", (request, _reply, done) => {
    const rawClientId = request.headers["x-forge-tab-id"];
    const clientId = typeof rawClientId === "string" && /^[a-f0-9-]{16,64}$/i.test(rawClientId) ? rawClientId : undefined;
    runWithSystemEvents(dependencies.systemEvents!, { source: "http", trigger: `${request.method} ${request.routeOptions.url ?? "unknown"}`, requestId: request.id, ...(clientId ? { clientId } : {}) }, done);
  });
  app.addHook("onResponse", (request, reply) => {
    const statusCode = reply.statusCode;
    const responseTime = reply.elapsedTime;
    const shouldLogAtInfo = statusCode >= 400 || responseTime > 1_000 || request.method !== "GET";
    const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : shouldLogAtInfo ? "info" : "debug";
    request.log[level]({
      req: { method: request.method, url: request.url },
      res: { statusCode },
      responseTime,
    }, "request");
  });
  if (dependencies.fullApp) {
    app.addHook("onRequest", (request, _reply, done) => { request.log.info({ req: request.raw }, "incoming request"); done(); });
    app.addHook("onSend", (request, reply, payload, done) => { request.log.info({ responseTime: Number(reply.elapsedTime ?? 0), statusCode: reply.statusCode }, "request completed"); done(null, payload); });
  }

  const configuredOrigin = new URL(dependencies.config.reachableAddress).origin;
  const loopbackOrigins = new Set([`http://localhost:${dependencies.config.port}`, `http://127.0.0.1:${dependencies.config.port}`, `http://[::1]:${dependencies.config.port}`]);
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // Agent API routes authenticate a bearer credential independently of board sessions and CSRF.
    if (isAgentApiRuntimeRequest(request) || isOAuthProtocolRequest(request)) return;
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const hasSession = [SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME].some((name) => typeof request.cookies[name] === "string" && request.cookies[name] !== "");
    if (!hasSession) return;
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (typeof origin === "string" && origin === configuredOrigin) return;
    if (typeof origin === "string" && loopbackOrigins.has(origin) && isLoopbackHost(dependencies.config, request.headers.host)) return;
    const token = Array.isArray(request.headers[CSRF_HEADER_NAME]) ? request.headers[CSRF_HEADER_NAME][0] : request.headers[CSRF_HEADER_NAME];
    const cookieToken = request.cookies[CSRF_COOKIE_NAME];
    if (typeof token === "string" && token === cookieToken && token.length >= 32) return;
    return reply.code(403).send({ error: "request_origin_invalid" });
  });

  return app;
}

export function registerAppRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  const getHealth = dependencies.getHealth ?? (() => inspectHostHealth(dependencies.config, dependencies.health));
  // The cached snapshot covers host checks only; provider checks are contextual
  // and always probed fresh for the requested context.
  const readBaseHealth = cachedHealthReader(async (): Promise<HealthSnapshot> => HealthSnapshotSchema.parse(await getHealth()), dependencies.healthNow);
  const readHealth = async (force = false, context?: { providers: readonly ProviderHarnessKind[] }): Promise<HealthSnapshot> => {
    const base = await readBaseHealth(force);
    const providerChecks = await inspectProviderChecks(dependencies.health, context?.providers ?? []);
    if (providerChecks.length === 0 && base.checks.every((check) => check.provider === undefined)) return base;
    return { ...base, checks: [...base.checks.filter((check) => check.provider === undefined), ...providerChecks] };
  };
  const { auth, projects: projectService, tasks: taskService, taskTemplates: templateService, database } = dependencies;

  void app.register(pages, {
    readHealth,
    ...(auth ? { auth } : {}),
    ...(projectService ? { projects: projectService } : {}),
    config: dependencies.config,
    ...(dependencies.frontendDevelopment ? { transformHtml: dependencies.frontendDevelopment.transformIndexHtml } : {}),
  });
  void app.register(discovery, dependencies.oauth ? { oauth: dependencies.oauth } : {});
  void app.register(health, { readHealth, ...(auth ? { auth } : {}), config: dependencies.config, ...(dependencies.profiles ? { profiles: dependencies.profiles } : {}), ...(projectService ? { projects: projectService } : {}), ...(dependencies.healthNow ? { now: dependencies.healthNow } : {}) });
  if (auth) {
    void app.register(authRoutes, { auth, config: dependencies.config, prefix: "/api/auth" });
    if (dependencies.externalAgent) void app.register(agentPairing, { externalAgent: dependencies.externalAgent });
    if (dependencies.oauth && projectService) void app.register(oauthRoutes, { oauth: dependencies.oauth, auth, projects: projectService, config: dependencies.config });
    if (dependencies.oauth && taskService) registerMcpRoutes(app, { oauth: dependencies.oauth, config: dependencies.config, tasks: taskService, agentDelivery: Boolean(dependencies.agentDelivery), ...(dependencies.host ? { host: dependencies.host } : {}), ...(dependencies.agentApiGithub ? { github: dependencies.agentApiGithub } : {}) });
    if (dependencies.externalAgent && taskService) registerAgentApiTaskRoutes(app, { externalAgent: dependencies.externalAgent, tasks: taskService, ...(dependencies.host ? { host: dependencies.host } : {}), ...(dependencies.agentApiGithub ? { github: dependencies.agentApiGithub } : {}), ...(dependencies.agentDelivery ? { agentDelivery: dependencies.agentDelivery } : {}) });
    void app.register(authenticated, { auth, ...(dependencies.systemEvents ? { systemEvents: dependencies.systemEvents } : {}), ...(dependencies.profiles ? { profiles: dependencies.profiles } : {}), ...(dependencies.providerInstances ? { providerInstances: dependencies.providerInstances } : {}), ...(dependencies.readProviderInstanceReadiness ? { readProviderInstanceReadiness: dependencies.readProviderInstanceReadiness } : {}), config: dependencies.config, ...(dependencies.readProviders ? { readProviders: dependencies.readProviders } : {}), ...(dependencies.providerLoginHerdr ? { providerLoginHerdr: dependencies.providerLoginHerdr } : {}), ...(dependencies.readUpdate ? { readUpdate: dependencies.readUpdate } : {}), ...(dependencies.requestUpdateRestart ? { requestUpdateRestart: dependencies.requestUpdateRestart } : {}), ...(dependencies.instanceId ? { instanceId: dependencies.instanceId } : {}), ...(projectService ? { projects: projectService } : {}), ...(taskService ? { tasks: taskService } : {}), ...(dependencies.host ? { host: dependencies.host } : {}), ...(database ? { database } : {}), ...(dependencies.externalAgent ? { externalAgent: dependencies.externalAgent } : {}) });
    if (templateService) void app.register(taskTemplates, { auth, config: dependencies.config, templates: templateService });
    if (dependencies.workflows) void app.register(workflowRoutes, { auth, config: dependencies.config, workflows: dependencies.workflows });
    if (dependencies.githubTriggers) void app.register(githubTriggerRoutes, { auth, config: dependencies.config, triggers: dependencies.githubTriggers });
  }
  if (!dependencies.frontendDevelopment) void app.register(assets, { prefix: "/assets" });
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = createAppServer({ ...dependencies, fullApp: true });
  registerAppRoutes(app, dependencies);
  return app;
}

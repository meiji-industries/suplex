import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";

import type { AuthService, AuthUser } from "./auth.js";
import type { ForgeDatabase } from "./database.js";
import type { ForgeConfig } from "./config.js";
import type { TaskHost } from "./task-host.js";
import type { HermesAgentService } from "./hermes-agents.js";
import type { ReadProviders } from "./provider-catalog.js";
import { inspectHostHealth, type HealthSnapshot, type HostHealthDependencies } from "./health.js";
import { inspectUpdateAvailability, type UpdateAvailability } from "./update.js";
import type { UpdateObservation } from "./self-update.js";
import type { UpdateRestartResponse } from "./http/contracts/update.js";
import type { AgentProfileService } from "./agent-profiles.js";
import type { ProjectService } from "./projects.js";
import type { TaskService } from "./tasks.js";
import type { TaskTemplateService } from "./task-templates.js";
import type { WorkflowRecordService } from "./workflow-records.js";
import type { GithubTriggerService } from "./github-triggers.js";
import { HealthSnapshotSchema } from "./schemas.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "./auth-identifiers.js";
import { installHttpErrorHandlers } from "./http/errors.js";
import { isLoopbackHost } from "./http/session.js";
import authRoutes from "./http/routes/auth.js";
import authenticated from "./http/routes/authenticated.js";
import assets from "./http/routes/assets.js";
import health from "./http/routes/health.js";
import pages from "./http/routes/pages.js";
import hermesPairing from "./http/routes/hermes-pairing.js";
import { registerHermesTaskRoutes } from "./http/routes/hermes-tasks.js";
import taskTemplates from "./http/routes/task-templates.js";
import workflowRoutes from "./http/routes/workflows.js";
import githubTriggerRoutes from "./http/routes/github-triggers.js";

export interface AppDependencies {
  fullApp?: boolean;
  config: ForgeConfig;
  health: HostHealthDependencies;
  getHealth?: () => Promise<HealthSnapshot>;
  healthNow?: () => number;
  auth?: AuthService;
  projects?: ProjectService;
  profiles?: AgentProfileService;
  tasks?: TaskService;
  taskTemplates?: TaskTemplateService;
  workflows?: WorkflowRecordService;
  githubTriggers?: GithubTriggerService;
  host?: Pick<TaskHost, "recover">;
  database?: ForgeDatabase;
  logger?: Logger | false;
  hermes?: HermesAgentService;
  readProviders?: ReadProviders;
  readUpdate?: (user: AuthUser) => Promise<UpdateAvailability | UpdateObservation>;
  requestUpdateRestart?: (revision: string) => Promise<UpdateRestartResponse>;
  launchUpdateRestart?: (operationId: string) => Promise<void>;
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
  const readUpdate = dependencies.readUpdate ?? (() => inspectUpdateAvailability());
  const readHealth = async (): Promise<HealthSnapshot> => HealthSnapshotSchema.parse(await getHealth());
  const { auth, projects: projectService, tasks: taskService, taskTemplates: templateService, database } = dependencies;

  void app.register(pages, {
    readHealth,
    ...(auth ? { auth } : {}),
    config: dependencies.config,
    ...(dependencies.frontendDevelopment ? { transformHtml: dependencies.frontendDevelopment.transformIndexHtml } : {}),
  });
  void app.register(health, { readHealth, ...(auth ? { auth } : {}), config: dependencies.config, ...(dependencies.healthNow ? { now: dependencies.healthNow } : {}) });
  if (auth) {
    void app.register(authRoutes, { auth, config: dependencies.config, prefix: "/api/auth" });
    if (dependencies.hermes) void app.register(hermesPairing, { hermes: dependencies.hermes });
    if (dependencies.hermes && taskService) registerHermesTaskRoutes(app, { hermes: dependencies.hermes, tasks: taskService });
    void app.register(authenticated, { auth, ...(dependencies.profiles ? { profiles: dependencies.profiles } : {}), config: dependencies.config, ...(dependencies.readProviders ? { readProviders: dependencies.readProviders } : {}), readUpdate, ...(dependencies.requestUpdateRestart ? { requestUpdateRestart: dependencies.requestUpdateRestart } : {}), ...(dependencies.launchUpdateRestart ? { launchUpdateRestart: dependencies.launchUpdateRestart } : {}), ...(dependencies.instanceId ? { instanceId: dependencies.instanceId } : {}), ...(projectService ? { projects: projectService } : {}), ...(taskService ? { tasks: taskService } : {}), ...(dependencies.host ? { host: dependencies.host } : {}), ...(database ? { database } : {}), ...(dependencies.hermes ? { hermes: dependencies.hermes } : {}) });
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

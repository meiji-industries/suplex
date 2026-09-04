import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";

import type { AuthService } from "./auth.js";
import type { AttentionService } from "./attention.js";
import type { AcceptanceService } from "./acceptance.js";
import type { CiService } from "./ci.js";
import type { ReleaseService } from "./github-release.js";
import type { ForgeDatabase } from "./database.js";
import type { ForgeConfig } from "./config.js";
import type { CapacityManager } from "./capacity.js";
import type { HermesAgentService } from "./hermes-agents.js";
import { inspectHostHealth, type HealthSnapshot, type HostHealthDependencies } from "./health.js";
import type { ProjectService } from "./projects.js";
import type { TaskService } from "./tasks.js";
import type { TaskTemplateService } from "./task-templates.js";
import type { ProjectionRebuildService } from "./projection-rebuild.js";
import { HealthSnapshotSchema } from "./schemas.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "./auth-identifiers.js";
import { installHttpErrorHandlers } from "./http/errors.js";
import authRoutes from "./http/routes/auth.js";
import authenticated from "./http/routes/authenticated.js";
import assets from "./http/routes/assets.js";
import health from "./http/routes/health.js";
import pages from "./http/routes/pages.js";
import hermesPairing from "./http/routes/hermes-pairing.js";
import { registerHermesTaskRoutes } from "./http/routes/hermes-tasks.js";
import prompts from "./http/routes/prompts.js";
import taskPrompts from "./http/routes/task-prompts.js";
import taskTemplates from "./http/routes/task-templates.js";

export interface AppDependencies {
  fullApp?: boolean;
  config: ForgeConfig;
  health: HostHealthDependencies;
  getHealth?: () => Promise<HealthSnapshot>;
  healthNow?: () => number;
  auth?: AuthService;
  projects?: ProjectService;
  tasks?: TaskService;
  taskTemplates?: TaskTemplateService;
  attention?: AttentionService;
  release?: ReleaseService;
  ci?: CiService;
  acceptance?: AcceptanceService;
  database?: ForgeDatabase;
  rebuild?: ProjectionRebuildService;
  logger?: Logger | false;
  capacity?: CapacityManager;
  hermes?: HermesAgentService;
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
  const developmentOrigins = new Set([`http://localhost:${dependencies.config.port}`, `http://127.0.0.1:${dependencies.config.port}`, `http://[::1]:${dependencies.config.port}`]);
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const hasSession = [SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME].some((name) => typeof request.cookies[name] === "string" && request.cookies[name] !== "");
    if (!hasSession) return;
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (typeof origin === "string" && origin === configuredOrigin) return;
    if (dependencies.config.developmentAutoLogin && typeof origin === "string" && developmentOrigins.has(origin)) return;
    const token = Array.isArray(request.headers[CSRF_HEADER_NAME]) ? request.headers[CSRF_HEADER_NAME][0] : request.headers[CSRF_HEADER_NAME];
    const cookieToken = request.cookies[CSRF_COOKIE_NAME];
    if (typeof token === "string" && token === cookieToken && token.length >= 32) return;
    return reply.code(403).send({ error: "request_origin_invalid" });
  });

  return app;
}

export function registerAppRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  const getHealth = dependencies.getHealth ?? (() => inspectHostHealth(dependencies.config, dependencies.health));
  const readHealth = async (): Promise<HealthSnapshot> => HealthSnapshotSchema.parse(await getHealth());
  const { auth, projects: projectService, tasks: taskService, taskTemplates: templateService, attention: attentionService, release: releaseService, database, rebuild } = dependencies;

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
    void app.register(authenticated, { auth, config: dependencies.config, ...(projectService ? { projects: projectService } : {}), ...(taskService ? { tasks: taskService } : {}), ...(releaseService ? { release: releaseService } : {}), ...(attentionService ? { attention: attentionService } : {}), ...(database ? { database } : {}), ...(rebuild ? { rebuild } : {}), ...(dependencies.capacity ? { capacity: dependencies.capacity } : {}), ...(dependencies.hermes ? { hermes: dependencies.hermes } : {}) });
    if (projectService && database) void app.register(prompts, { auth, config: dependencies.config, database, projects: projectService });
    if (taskService && database) void app.register(taskPrompts, { auth, config: dependencies.config, database, tasks: taskService });
    if (templateService) void app.register(taskTemplates, { auth, config: dependencies.config, templates: templateService });
  }
  if (!dependencies.frontendDevelopment) void app.register(assets, { prefix: "/assets" });
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = createAppServer({ ...dependencies, fullApp: true });
  registerAppRoutes(app, dependencies);
  return app;
}

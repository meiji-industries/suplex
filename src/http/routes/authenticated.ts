import type { FastifyPluginAsync } from "fastify";

import type { AuthService, AuthUser } from "../../identity/auth.js";
import type { SuplexConfig } from "../../platform/config.js";
import type { SuplexDatabase } from "../../platform/database.js";
import type { AgentProfileService } from "../../profiles/agent-profiles.js";
import type { ProviderInstanceService } from "../../profiles/provider-instances.js";
import { AvatarService } from "../../identity/avatars.js";
import type { ProjectService } from "../../projects/projects.js";
import type { TaskService } from "../../tasks/tasks.js";
import type { TaskHost } from "../../tasks/host.js";
import type { ExternalAgentService } from "../../identity/external-agents.js";
import type { ReadProviders } from "../../profiles/provider-catalog.js";
import type { ProviderLoginPort } from "../../profiles/provider-login.js";
import type { UpdateResponse, UpdateRestartResponse } from "../contracts/update.js";
import { sessionUser } from "../session.js";
import administration from "./administration.js";
import avatars from "./avatars.js";
import { authMe } from "./auth.js";
import companies from "./companies.js";
import projects from "./projects.js";
import providerLogin from "./provider-login.js";
import tasks from "./tasks.js";
import taskPane from "./task-pane.js";
import taskWorktree from "./task-worktree.js";
import update from "./update.js";

import externalAgentAdministration from "./external-agent-administration.js";
import { ClientLifecycleSchema } from "../contracts/system-events.js";
import { systemEvent, type EventSink } from "../../platform/system-events.js";

export interface AuthenticatedRoutesOptions {
  auth: AuthService;
  config?: SuplexConfig;
  projects?: ProjectService;
  profiles?: AgentProfileService;
  providerInstances?: ProviderInstanceService;
  readProviderInstanceReadiness?: (homeDirectory: string) => Promise<{ status: "healthy" | "warning" | "unhealthy"; summary: string }>;
  tasks?: TaskService;
  host?: Pick<TaskHost, "recover">;
  database?: SuplexDatabase;
  externalAgent?: ExternalAgentService;
  readProviders?: ReadProviders;
  providerLoginHerdr?: ProviderLoginPort;
  readUpdate?: (check: boolean, user: AuthUser) => Promise<UpdateResponse>;
  requestUpdateRestart?: (user: AuthUser) => Promise<UpdateRestartResponse>;
  instanceId?: string;
  systemEvents?: EventSink;
}

const authenticated: FastifyPluginAsync<AuthenticatedRoutesOptions> = async (app, options) => {
  app.decorateRequest("suplexUser", undefined as unknown as AuthUser);
  app.addHook("preHandler", async (request, reply) => {
    const user = await sessionUser(options.auth, request, reply, options.config);
    if (!user) {
      reply.code(401).send({ error: "Authentication required" });
      return;
    }
    request.suplexUser = user;
  });

  await app.register(authMe, { prefix: "/api/auth", auth: options.auth });
  if (options.systemEvents) app.post("/api/system/client-lifecycle", { bodyLimit: 1024, schema: { body: ClientLifecycleSchema } }, async (request, reply) => {
    const parsed = ClientLifecycleSchema.parse(request.body);
    systemEvent({ type: "client_lifecycle", ...parsed });
    return reply.code(204).send();
  });
  await app.register(companies, { auth: options.auth });
  await app.register(administration, { auth: options.auth, ...(options.profiles ? { profiles: options.profiles } : {}), ...(options.providerInstances ? { providerInstances: options.providerInstances } : {}), ...(options.readProviderInstanceReadiness ? { readProviderInstanceReadiness: options.readProviderInstanceReadiness } : {}), ...(options.readProviders ? { readProviders: options.readProviders } : {}), ...(options.config ? { config: options.config } : {}), ...(options.projects ? { projects: options.projects } : {}), ...(options.database ? { database: options.database } : {}) });
  if (options.externalAgent) await app.register(externalAgentAdministration, { externalAgent: options.externalAgent });
  await app.register(providerLogin, { auth: options.auth, ...(options.providerInstances ? { providerInstances: options.providerInstances } : {}), ...(options.config ? { config: options.config } : {}), ...(options.providerLoginHerdr ? { herdr: options.providerLoginHerdr } : {}) });
  if (options.database) await app.register(avatars, { avatars: new AvatarService(options.database, options.auth), ...(options.projects ? { projects: options.projects } : {}) });
  if (options.projects) await app.register(projects, { projects: options.projects });
  if (options.tasks) await app.register(tasks, { tasks: options.tasks, ...(options.config ? { config: options.config } : {}), ...(options.host ? { host: options.host } : {}), ...(options.systemEvents ? { systemEvents: options.systemEvents } : {}) });
  if (options.tasks) await app.register(taskPane, { tasks: options.tasks, ...(options.config ? { config: options.config } : {}) });
  if (options.tasks && options.database) await app.register(taskWorktree, { tasks: options.tasks, database: options.database, ...(options.config ? { config: options.config } : {}) });
  if (options.readUpdate) await app.register(update, { readUpdate: options.readUpdate, ...(options.requestUpdateRestart ? { requestRestart: options.requestUpdateRestart } : {}), ...(options.instanceId ? { instanceId: options.instanceId } : {}) });
};

export default authenticated;

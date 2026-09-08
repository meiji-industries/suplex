import type { FastifyPluginAsync } from "fastify";

import type { AuthService, AuthUser } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import type { AgentProfileService } from "../../agent-profiles.js";
import { AvatarService } from "../../avatars.js";
import type { ProjectService } from "../../projects.js";
import type { TaskService } from "../../tasks.js";
import type { TaskHost } from "../../task-host.js";
import type { HermesAgentService } from "../../hermes-agents.js";
import type { ReadProviders } from "../../provider-catalog.js";
import type { UpdateObservation } from "../../self-update.js";
import type { UpdateAvailability } from "../../update.js";
import type { UpdateRestartResponse } from "../contracts/update.js";
import { sessionUser } from "../session.js";
import administration from "./administration.js";
import avatars from "./avatars.js";
import { authMe } from "./auth.js";
import companies from "./companies.js";
import projects from "./projects.js";
import tasks from "./tasks.js";
import taskPane from "./task-pane.js";
import taskWorktree from "./task-worktree.js";
import update from "./update.js";

import hermesAdministration from "./hermes-administration.js";

export interface AuthenticatedRoutesOptions {
  auth: AuthService;
  config?: ForgeConfig;
  projects?: ProjectService;
  profiles?: AgentProfileService;
  tasks?: TaskService;
  host?: Pick<TaskHost, "recover">;
  database?: ForgeDatabase;
  hermes?: HermesAgentService;
  readProviders?: ReadProviders;
  readUpdate?: (user: AuthUser) => Promise<UpdateAvailability | UpdateObservation>;
  requestUpdateRestart?: (revision: string) => Promise<UpdateRestartResponse>;
  launchUpdateRestart?: (operationId: string) => Promise<void>;
  instanceId?: string;
}

const authenticated: FastifyPluginAsync<AuthenticatedRoutesOptions> = async (app, options) => {
  app.decorateRequest("forgeUser", undefined as unknown as AuthUser);
  app.addHook("preHandler", async (request, reply) => {
    const user = await sessionUser(options.auth, request, reply, options.config);
    if (!user) {
      reply.code(401).send({ error: "Authentication required" });
      return;
    }
    request.forgeUser = user;
  });

  await app.register(authMe, { prefix: "/api/auth", auth: options.auth });
  await app.register(companies, { auth: options.auth });
  await app.register(administration, { auth: options.auth, ...(options.profiles ? { profiles: options.profiles } : {}), ...(options.readProviders ? { readProviders: options.readProviders } : {}), ...(options.config ? { config: options.config } : {}), ...(options.projects ? { projects: options.projects } : {}), ...(options.database ? { database: options.database } : {}) });
  if (options.hermes) await app.register(hermesAdministration, { hermes: options.hermes });
  if (options.database) await app.register(avatars, { avatars: new AvatarService(options.database, options.auth), ...(options.projects ? { projects: options.projects } : {}) });
  if (options.projects) await app.register(projects, { projects: options.projects });
  if (options.tasks) await app.register(tasks, { tasks: options.tasks, ...(options.config ? { config: options.config } : {}), ...(options.host ? { host: options.host } : {}) });
  if (options.tasks) await app.register(taskPane, { tasks: options.tasks, ...(options.config ? { config: options.config } : {}) });
  if (options.tasks && options.database) await app.register(taskWorktree, { tasks: options.tasks, database: options.database, ...(options.config ? { config: options.config } : {}) });
  if (options.readUpdate) await app.register(update, { readUpdate: options.readUpdate, ...(options.requestUpdateRestart ? { requestRestart: options.requestUpdateRestart } : {}), ...(options.launchUpdateRestart ? { launchRestart: options.launchUpdateRestart } : {}), ...(options.instanceId ? { instanceId: options.instanceId } : {}) });
};

export default authenticated;

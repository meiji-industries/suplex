import type { FastifyPluginAsync } from "fastify";

import type { AttentionService } from "../../attention.js";
import type { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import type { ProjectService } from "../../projects.js";
import type { TaskService } from "../../tasks.js";
import type { ReleaseService } from "../../github-release.js";
import type { CapacityManager } from "../../capacity.js";
import type { HermesAgentService } from "../../hermes-agents.js";
import { sessionUser } from "../session.js";
import administration from "./administration.js";
import { authMe } from "./auth.js";
import companies from "./companies.js";
import attention from "./attention.js";
import agentEvents from "./agent-events.js";
import projects from "./projects.js";
import tasks from "./tasks.js";
import hermesAdministration from "./hermes-administration.js";

export interface AuthenticatedRoutesOptions {
  auth: AuthService;
  config?: ForgeConfig;
  projects?: ProjectService;
  tasks?: TaskService;
  release?: ReleaseService;
  attention?: AttentionService;
  database?: ForgeDatabase;
  capacity?: CapacityManager;
  hermes?: HermesAgentService;
}

const authenticated: FastifyPluginAsync<AuthenticatedRoutesOptions> = async (app, options) => {
  app.decorateRequest("forgeUser", undefined as unknown as import("../../auth.js").AuthUser);
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
  await app.register(administration, { auth: options.auth, ...(options.config ? { config: options.config } : {}), ...(options.projects ? { projects: options.projects } : {}), ...(options.attention ? { attention: options.attention } : {}), ...(options.database ? { database: options.database } : {}), ...(options.capacity ? { capacity: options.capacity } : {}) });
  if (options.hermes) await app.register(hermesAdministration, { hermes: options.hermes });
  if (options.projects) await app.register(projects, { projects: options.projects });
  if (options.tasks) await app.register(tasks, { tasks: options.tasks, ...(options.release ? { release: options.release } : {}), ...(options.database ? { database: options.database } : {}), ...(options.config ? { config: options.config } : {}) });
  if (options.tasks) await app.register(agentEvents, { tasks: options.tasks });
  if (options.attention) await app.register(attention, { attention: options.attention });
};

export default authenticated;

import cookie from "@fastify/cookie";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";

import { AuthService } from "./auth.js";
import type { AttentionService } from "./attention.js";
import type { AcceptanceService } from "./acceptance.js";
import type { CiService } from "./ci.js";
import type { ReleaseService } from "./github-release.js";
import type { ForgeDatabase } from "./database.js";
import type { ForgeConfig } from "./config.js";
import { inspectHostHealth, type HealthSnapshot, type HostHealthDependencies } from "./health.js";
import { ProjectService } from "./projects.js";
import { TaskService } from "./tasks.js";
import { HealthSnapshotSchema } from "./schemas.js";
import { installHttpErrorHandlers } from "./http/errors.js";
import authRoutes from "./http/routes/auth.js";
import authenticated from "./http/routes/authenticated.js";
import assets from "./http/routes/assets.js";
import health from "./http/routes/health.js";
import pages from "./http/routes/pages.js";

export interface AppDependencies {
  config: ForgeConfig;
  health: HostHealthDependencies;
  getHealth?: () => Promise<HealthSnapshot>;
  auth?: AuthService;
  projects?: ProjectService;
  tasks?: TaskService;
  attention?: AttentionService;
  release?: ReleaseService;
  ci?: CiService;
  acceptance?: AcceptanceService;
  database?: ForgeDatabase;
  logger?: Logger | false;
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = (dependencies.logger === undefined || dependencies.logger === false
    ? Fastify({ logger: false })
    : Fastify({ loggerInstance: dependencies.logger })) as unknown as FastifyInstance;
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  void app.register(cookie);
  installHttpErrorHandlers(app);

  const getHealth = dependencies.getHealth ?? (() => inspectHostHealth(dependencies.config, dependencies.health));
  const readHealth = async (): Promise<HealthSnapshot> => HealthSnapshotSchema.parse(await getHealth());
  const { auth, projects: projectService, tasks: taskService, attention: attentionService, database } = dependencies;

  void app.register(pages, { readHealth, ...(auth ? { auth } : {}) });
  void app.register(health, { readHealth, ...(auth ? { auth } : {}) });
  if (auth) {
    void app.register(authRoutes, { auth, config: dependencies.config, prefix: "/api/auth" });
    void app.register(authenticated, { auth, ...(projectService ? { projects: projectService } : {}), ...(taskService ? { tasks: taskService } : {}), ...(attentionService ? { attention: attentionService } : {}), ...(database ? { database } : {}) });
  }
  void app.register(assets, { prefix: "/assets" });

  return app;
}

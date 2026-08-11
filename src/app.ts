import Fastify, { type FastifyInstance } from "fastify";

import type { ForgeConfig } from "./config.js";
import { inspectHostHealth, type HealthSnapshot, type HostHealthDependencies } from "./health.js";
import { renderHealthPage } from "./ui.js";

export interface AppDependencies {
  config: ForgeConfig;
  health: HostHealthDependencies;
  getHealth?: () => Promise<HealthSnapshot>;
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const getHealth = dependencies.getHealth ?? (() => inspectHostHealth(dependencies.config, dependencies.health));

  app.get("/", async (_request, reply) => reply.redirect("/health"));
  app.get("/health", async (_request, reply) => {
    const snapshot = await getHealth();
    return reply.type("text/html; charset=utf-8").send(renderHealthPage(snapshot));
  });
  app.get("/api/health", async (_request, reply) => reply.send(await getHealth()));

  return app;
}

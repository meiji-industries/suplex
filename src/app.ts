import { readFile } from "node:fs/promises";

import Fastify, { type FastifyInstance } from "fastify";

import type { ForgeConfig } from "./config.js";
import { inspectHostHealth, type HealthSnapshot, type HostHealthDependencies } from "./health.js";
import { HealthSnapshotSchema } from "./schemas.js";
import { renderHealthPage } from "./ui.js";

async function readFrontendAsset(filename: string): Promise<Buffer> {
  const locations = [
    new URL(`../web/${filename}`, import.meta.url),
    new URL(`../dist/web/${filename}`, import.meta.url),
  ];
  for (const location of locations) {
    try {
      return Buffer.from(await readFile(location));
    } catch {
      // Try the source-tree location when running through tsx, then the compiled location.
    }
  }
  throw new Error(`Frontend asset is not built: ${filename}`);
}

export interface AppDependencies {
  config: ForgeConfig;
  health: HostHealthDependencies;
  getHealth?: () => Promise<HealthSnapshot>;
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const getHealth = dependencies.getHealth ?? (() => inspectHostHealth(dependencies.config, dependencies.health));
  const readHealth = async (): Promise<HealthSnapshot> => HealthSnapshotSchema.parse(await getHealth());

  app.get("/", async (_request, reply) => reply.redirect("/health"));
  app.get("/health", async (_request, reply) => {
    const snapshot = await readHealth();
    return reply.type("text/html; charset=utf-8").send(renderHealthPage(snapshot));
  });
  app.get("/api/health", async (_request, reply) => reply.send(await readHealth()));
  app.get("/assets/forge-ui.js", async (_request, reply) => {
    try {
      return reply.type("text/javascript; charset=utf-8").send(await readFrontendAsset("forge-ui.js"));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Forge UI asset is not built");
    }
  });
  app.get("/assets/forge-ui.css", async (_request, reply) => {
    try {
      return reply.type("text/css; charset=utf-8").send(await readFrontendAsset("forge-ui.css"));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Forge UI asset is not built");
    }
  });

  return app;
}

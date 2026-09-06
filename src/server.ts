import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import { AuthService } from "./auth.js";
import { loadConfig, type ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { seedDevelopmentData } from "./development.js";
import { createHostHealthDependencies } from "./host-health.js";
import { TaskTemplateService } from "./task-templates.js";
import { createFastifyLogger, StructuredLogger } from "./logging.js";
import { AgentProfileService } from "./agent-profiles.js";
import { ProjectService } from "./projects.js";
import { TaskService } from "./tasks.js";
import { HermesAgentService } from "./hermes-agents.js";
import { TaskHost } from "./task-host.js";
import { inspectUpdateAvailability } from "./update.js";
import { TaskAnalyticsStore } from "./task-analytics-store.js";
import { AnalyticsHistoryReader, TaskAnalyticsCollector } from "./task-analytics-collector.js";

export interface ForgeServer {
  app: FastifyInstance;
  database: ForgeDatabase;
  host: TaskHost;
}

export async function createForgeServer(config: ForgeConfig = loadConfig(), options: { logSink?: (line: string) => void } = {}): Promise<ForgeServer> {
  await mkdir(config.artifactRoot, { recursive: true });
  await mkdir(config.worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  const host = new TaskHost(database, { artifactRoot: config.artifactRoot });
  const auth = new AuthService(database, config);
  const hermes = new HermesAgentService(database, auth);
  const projects = new ProjectService(database, auth, config);
  await seedDevelopmentData(auth, config);
  const profiles = new AgentProfileService(database, auth);
  const tasks = new TaskService(database, auth, projects, config);
  const taskTemplates = new TaskTemplateService(database, auth, tasks);
  const dependencies = {
    config,
    health: createHostHealthDependencies(config, database),
    auth,
    hermes,
    projects,
    profiles,
    tasks,
    taskTemplates,
    database,
    host,
    logger: createFastifyLogger(options.logSink),
    readUpdate: () => inspectUpdateAvailability({ cwd: process.cwd() }),
  } satisfies Parameters<typeof createApp>[0];
  let app: FastifyInstance;
  try {
    if (process.env.FORGE_FRONTEND_DEV_SERVER === "1") {
      const { createDevelopmentApp } = await import("./frontend-development.js");
      app = (await createDevelopmentApp(dependencies)).app;
    } else {
      app = createApp(dependencies);
    }
  } catch (error) {
    database.close();
    throw error;
  }
  const history = new AnalyticsHistoryReader(join(dirname(config.databasePath), "runtime", "analytics"));
  const analytics = new TaskAnalyticsCollector(tasks.repository, new TaskAnalyticsStore(database), id => history.read(id), error => app.log.warn({ err: error }, "Analytics observation failed"), () => history.readPricing());
  app.addHook("onClose", async () => { await analytics.stop(); await history.close(); });
  analytics.start();
  host.start();
  return { app, database, host };
}

export async function startServer(config: ForgeConfig = loadConfig()): Promise<void> {
  const server = await createForgeServer(config);
  let closed = false;
  try {
    await server.app.listen({ host: config.bindAddress, port: config.port });
    await new Promise<void>((resolve) => {
      const shutdown = async (): Promise<void> => {
        if (closed) {
          return;
        }
        closed = true;
        await server.app.close();
        await server.host.stop();
        server.database.close();
        resolve();
      };
      process.once("SIGTERM", () => void shutdown());
      process.once("SIGINT", () => void shutdown());
    });
  } finally {
    if (!closed) {
      closed = true;
      await server.app.close().catch(() => undefined);
      await server.host.stop();
      server.database.close();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch((error: unknown) => {
    new StructuredLogger().error("Forge API stopped", {}, { error: error instanceof Error ? error.message : "unknown error" });
    process.exitCode = 1;
  });
}

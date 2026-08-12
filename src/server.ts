import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import { AttentionService } from "./attention.js";
import { ArtifactStore } from "./artifacts.js";
import { AcceptanceService } from "./acceptance.js";
import { CiService, createGithubCiProvider } from "./ci.js";
import { AuthService } from "./auth.js";
import { loadConfig, type ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { seedDevelopmentData } from "./development.js";
import { createHostHealthDependencies } from "./host-health.js";
import { createFastifyLogger, StructuredLogger } from "./logging.js";
import { ProjectService } from "./projects.js";
import { TaskService } from "./tasks.js";
import { createGithubReleasePort, ReleaseService } from "./github-release.js";

export interface ForgeServer {
  app: FastifyInstance;
  database: ForgeDatabase;
}

export async function createForgeServer(config: ForgeConfig = loadConfig()): Promise<ForgeServer> {
  await mkdir(config.artifactRoot, { recursive: true });
  await mkdir(config.worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, auth, config);
  await seedDevelopmentData(auth, projects, config);
  const tasks = new TaskService(database, auth, projects, config);
  const attention = new AttentionService(database, auth);
  const githubRelease = createGithubReleasePort();
  const release = new ReleaseService(database, new ArtifactStore(config.artifactRoot), githubRelease);
  const ci = new CiService(database, createGithubCiProvider());
  const acceptance = new AcceptanceService(database, githubRelease);
  const dependencies = {
    config,
    health: createHostHealthDependencies(config, database),
    auth,
    projects,
    tasks,
    attention,
    database,
    release,
    ci,
    acceptance,
    logger: createFastifyLogger(),
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
  return { app, database };
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

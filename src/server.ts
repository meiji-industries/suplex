import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import { AuthService } from "./identity/auth.js";
import { loadConfig, type ForgeConfig } from "./platform/config.js";
import { ForgeDatabase } from "./platform/database.js";
import { seedDevelopmentData } from "./platform/development.js";
import { createHostHealthDependencies } from "./platform/host-health.js";
import { TaskTemplateService } from "./tasks/templates.js";
import { WorkflowRecordService } from "./coordination/workflow-records.js";
import { createFastifyLogger, StructuredLogger } from "./platform/logging.js";
import { AgentProfileService } from "./profiles/agent-profiles.js";
import { ProviderInstanceService } from "./profiles/provider-instances.js";
import { ProjectService } from "./projects/projects.js";
import { TaskService } from "./tasks/tasks.js";
import { HermesAgentService } from "./identity/hermes-agents.js";
import { AgentDeliveryService } from "./delivery/agent-delivery.js";
import { DeliveryOperations } from "./delivery/operations.js";
import { TaskHost } from "./tasks/host.js";
import { createSelfUpdateService } from "./platform/updates/self-update.js";
import { TaskAnalyticsStore } from "./tasks/analytics/store.js";
import { GithubTriggerService } from "./integrations/github/triggers.js";
import { GithubTriggerPoller } from "./integrations/github/trigger-poller.js";
import { createGithubReleasePort } from "./integrations/github/delivery.js";
import { AnalyticsHistoryReader, TaskAnalyticsCollector } from "./tasks/analytics/collector.js";

export interface ForgeServer {
  app: FastifyInstance;
  database: ForgeDatabase;
  host: TaskHost;
  instanceId: string;
}

export async function createForgeServer(config: ForgeConfig = loadConfig(), options: { logSink?: (line: string) => void } = {}): Promise<ForgeServer> {
  await mkdir(config.artifactRoot, { recursive: true });
  await mkdir(config.worktreeRoot, { recursive: true });
  await mkdir(config.runtimeRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  const host = new TaskHost(database, { artifactRoot: config.artifactRoot });
  const auth = new AuthService(database, config);
  const hermes = new HermesAgentService(database, auth);
  const projects = new ProjectService(database, auth, config);
  await seedDevelopmentData(auth, config);
  const profiles = new AgentProfileService(database, auth);
  const providerInstances = new ProviderInstanceService(database, auth);
  const tasks = new TaskService(database, auth, projects, config);
  const agentDelivery = new AgentDeliveryService({ database, tasks, store: tasks.repository.controls, delivery: new DeliveryOperations(tasks.repository.controls), auth });
  const taskTemplates = new TaskTemplateService(database, auth, tasks);
  const workflows = new WorkflowRecordService(database, auth);
  const githubTriggers = new GithubTriggerService(database, auth, projects, workflows, createGithubReleasePort(), tasks);
  const instanceId = randomUUID();
  const selfUpdate = createSelfUpdateService({ config, instanceId, workingDirectory: process.cwd() });
  await selfUpdate.initialize();
  const dependencies = {
    config,
    health: createHostHealthDependencies(config, database),
    auth,
    hermes,
    agentDelivery,
    projects,
    profiles,
    providerInstances,
    tasks,
    taskTemplates,
    workflows,
    githubTriggers,
    database,
    host,
    logger: createFastifyLogger(options.logSink),
    readUpdate: () => selfUpdate.readUpdate(),
    requestUpdateRestart: (revision: string) => selfUpdate.acceptRestart(revision),
    launchUpdateRestart: (operationId: string) => selfUpdate.launchRestart(operationId),
    instanceId,
  } satisfies Parameters<typeof createApp>[0];
  let app: FastifyInstance;
  try {
    if (process.env.FORGE_FRONTEND_DEV_SERVER === "1") {
      const { createDevelopmentApp } = await import("./platform/frontend-development.js");
      app = (await createDevelopmentApp(dependencies)).app;
    } else {
      app = createApp(dependencies);
    }
  } catch (error) {
    database.close();
    throw error;
  }
  const history = new AnalyticsHistoryReader(config.databasePath, join(dirname(config.databasePath), "runtime", "analytics"));
  const analytics = new TaskAnalyticsCollector(tasks.repository, new TaskAnalyticsStore(database), (session, pricing) => history.read(session, pricing), error => app.log.warn({ err: error }, "Analytics observation failed"), () => history.readPricing());
  const triggerPoller = new GithubTriggerPoller(() => githubTriggers.processEnabledRules(), error => app.log.warn({ err: error }, "GitHub trigger poll failed"));
  app.addHook("onReady", async () => { triggerPoller.start(); });
  app.addHook("onClose", async () => { await triggerPoller.stop(); await analytics.stop(); await history.close(); });
  analytics.start();
  host.start();
  return { app, database, host, instanceId };
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

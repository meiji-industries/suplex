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
import { ExternalAgentService } from "./identity/external-agents.js";
import { OAuthService } from "./identity/oauth.js";
import { AgentDeliveryService } from "./delivery/agent-delivery.js";
import { DeliveryOperations } from "./delivery/operations.js";
import { TaskHost } from "./tasks/host.js";
import { SupervisorUpdateClient } from "./platform/updates/update-client.js";
import { TaskAnalyticsStore } from "./tasks/analytics/store.js";
import { GithubTriggerService } from "./integrations/github/triggers.js";
import { GithubTriggerPoller } from "./integrations/github/trigger-poller.js";
import { createGithubReleasePort } from "./integrations/github/delivery.js";
import { AnalyticsHistoryReader, TaskAnalyticsCollector } from "./tasks/analytics/collector.js";
import { createSystemEventWriter, runWithSystemEvents, systemEvent, systemLogDirectory, type EventSink } from "./platform/system-events.js";
import { startSystemEventReceiver } from "./platform/system-event-transport.js";

export interface ForgeServer {
  app: FastifyInstance;
  database: ForgeDatabase;
  host: TaskHost;
  instanceId: string;
}

export async function createForgeServer(config: ForgeConfig = loadConfig(), options: { logSink?: (line: string) => void; systemEvents?: EventSink } = {}): Promise<ForgeServer> {
  await mkdir(config.artifactRoot, { recursive: true });
  await mkdir(config.worktreeRoot, { recursive: true });
  await mkdir(config.runtimeRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  const systemEvents = options.systemEvents ?? createSystemEventWriter({ directory: systemLogDirectory(config.dataRoot) });
  const host = new TaskHost(database, { artifactRoot: config.artifactRoot, systemEvents });
  const auth = new AuthService(database, config);
  const externalAgent = new ExternalAgentService(database, auth);
  const oauth = new OAuthService(database, auth, externalAgent, config.reachableAddress);
  const projects = new ProjectService(database, auth, config);
  await seedDevelopmentData(auth, config);
  const profiles = new AgentProfileService(database, auth);
  const providerInstances = new ProviderInstanceService(database, auth);
  const tasks = new TaskService(database, auth, projects, config);
  const agentDelivery = new AgentDeliveryService({ database, tasks, store: tasks.repository.controls, delivery: new DeliveryOperations(tasks.repository.controls, undefined, config.artifactRoot), auth });
  const taskTemplates = new TaskTemplateService(database, auth, tasks);
  const workflows = new WorkflowRecordService(database, auth);
  const githubTriggers = new GithubTriggerService(database, auth, projects, workflows, createGithubReleasePort(), tasks);
  const instanceId = randomUUID();
  const updates = new SupervisorUpdateClient();
  const dependencies = {
    config,
    health: createHostHealthDependencies(config, database),
    auth,
    externalAgent,
    oauth,
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
    systemEvents,
    readUpdate: (check: boolean) => updates.read(check),
    requestUpdateRestart: () => updates.apply(),
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
  const stopSystemEventReceiver = await startSystemEventReceiver(config.databasePath, systemEvents);
  let receiverStopped = false;
  const stopReceiver = async (): Promise<void> => { if (receiverStopped) return; receiverStopped = true; await stopSystemEventReceiver(); };
  try {
    const analytics = new TaskAnalyticsCollector(tasks.repository, new TaskAnalyticsStore(database), (session, pricing) => history.read(session, pricing), error => app.log.warn({ err: error }, "Analytics observation failed"), () => history.readPricing());
    const triggerPoller = new GithubTriggerPoller(() => githubTriggers.processEnabledRules(), error => app.log.warn({ err: error }, "GitHub trigger poll failed"));
    app.addHook("onReady", async () => { triggerPoller.start(); });
    app.addHook("onClose", async () => { await stopReceiver(); updates.close(); await triggerPoller.stop(); await analytics.stop(); await history.close(); });
    analytics.start();
    runWithSystemEvents(systemEvents, { source: "startup", trigger: "startup recovery" }, () => {
      systemEvent({ type: "server", state: "starting" });
      host.start();
    });
  } catch (error) {
    await stopReceiver();
    await app.close().catch(() => undefined);
    database.close();
    throw error;
  }
  return { app, database, host, instanceId };
}

export async function startServer(config: ForgeConfig = loadConfig()): Promise<void> {
  const server = await createForgeServer(config);
  const events = server.host.systemEvents;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    await server.app.listen({ host: config.bindAddress, port: config.port });
    runWithSystemEvents(events, { source: "server" }, () => systemEvent({ type: "server", state: "listening" }));
    let lastWall = Date.now();
    let lastMono = process.hrtime.bigint();
    heartbeat = setInterval(() => runWithSystemEvents(events, { source: "server", trigger: "heartbeat" }, () => {
      const wall = Date.now(); const mono = process.hrtime.bigint();
      const wallElapsedMs = wall - lastWall; const monotonicElapsedMs = Number((mono - lastMono) / 1_000_000n);
      if (wallElapsedMs > 90_000 || monotonicElapsedMs > 90_000 || Math.abs(wallElapsedMs - monotonicElapsedMs) > 30_000) systemEvent({ type: "server", state: "clock_gap", wallElapsedMs, monotonicElapsedMs });
      systemEvent({ type: "server", state: "heartbeat", wallElapsedMs, monotonicElapsedMs });
      lastWall = wall; lastMono = mono;
    }), 60_000);
    heartbeat.unref();
    process.send?.({ kind: "ready", instanceId: server.instanceId });
    await new Promise<void>((resolve) => {
      const messageHandler = (message: unknown): void => {
        if (message && typeof message === "object" && "kind" in message && message.kind === "shutdown") void shutdown("ipc");
      };
      const disconnectHandler = (): void => { void shutdown("disconnect"); };
      const shutdown = async (reason: string): Promise<void> => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        runWithSystemEvents(events, { source: "server", trigger: reason }, () => systemEvent({ type: "server", state: "shutdown_requested", reason }));
        process.off("message", messageHandler);
        process.off("disconnect", disconnectHandler);
        await server.app.close();
        await server.host.stop();
        server.database.close();
        runWithSystemEvents(events, { source: "server", trigger: reason }, () => systemEvent({ type: "server", state: "stopped", reason }));
        resolve();
      };
      process.once("SIGTERM", () => void shutdown("SIGTERM"));
      process.once("SIGINT", () => void shutdown("SIGINT"));
      process.on("message", messageHandler);
      process.once("disconnect", disconnectHandler);
    });
  } finally {
    if (!closed) {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
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

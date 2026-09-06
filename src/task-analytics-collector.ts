import type { OpenCodeMessageEnvelope } from "./opencode-contracts.js";
import type { ModelPricingCatalog } from "./model-pricing.js";
import { ModelsDevCatalogReader, type ModelPricingReader } from "./models-dev-catalog.js";
import { resolveOpenCodeExecutable } from "./opencode-executable.js";
import { ensureOpenCodeServer, openCodeServerClient, readOpenCodeServer, stopOpenCodeServer } from "./opencode-server.js";
import type { TaskRepository } from "./task-repository.js";
import type { TaskAnalyticsStore } from "./task-analytics-store.js";
import { taskUsage } from "./task-usage.js";

export class TaskAnalyticsCollector {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly repository: TaskRepository, private readonly store: TaskAnalyticsStore,
    private readonly readMessages: (sessionId: string) => Promise<OpenCodeMessageEnvelope[]>,
    private readonly reportError: (error: unknown) => void,
    private readonly readPricing?: () => Promise<ModelPricingCatalog | undefined>) {}

  start(): void {
    const tick = (): void => {
      if (this.stopped) return;
      this.pending = this.collect().catch(this.reportError).finally(() => {
        if (!this.stopped) { this.timer = setTimeout(tick, 30_000); this.timer.unref(); }
      });
    };
    tick();
  }

  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.pending; }

  async collect(): Promise<void> {
    let pricing: ModelPricingCatalog | undefined;
    let pricingAttempted = false;
    const optionalPricing = async (): Promise<ModelPricingCatalog | undefined> => {
      if (pricingAttempted || !this.readPricing) return pricing;
      pricingAttempted = true;
      try { pricing = await this.readPricing(); } catch { pricing = undefined; }
      return pricing;
    };
    for (const row of this.repository.rows()) {
      if (this.stopped) return;
      try {
        const task = this.repository.task(row);
        this.store.observe(task);
        const observations = this.store.sessionObservations(task.id);
        for (const session of this.repository.controls.sessions(task.id)) {
          if (this.stopped) return;
          if (!session.nativeSessionId) continue;
          const previous = observations.find(value => value.sessionId === session.id);
          const lastAttempt = previous?.errorAt ?? previous?.observedAt;
          const changedSinceObservation = previous?.observedAt && task.updatedAt > previous.observedAt;
          const refreshMs = previous?.errorAt ? 300_000 : !changedSinceObservation && (task.archivedAt || !["active", "waiting_human"].includes(task.status)) ? 900_000 : 0;
          if (lastAttempt && Date.now() - Date.parse(lastAttempt) < refreshMs) continue;
          try {
            const readStartedAt = new Date().toISOString();
            const messages = await this.readMessages(session.nativeSessionId);
            this.store.record(task.id, session.id, taskUsage(messages, session.kind, await optionalPricing()), readStartedAt);
          } catch (error) {
            this.store.failed(task.id, session.id);
            this.reportError(error);
          }
        }
      } catch (error) { this.reportError(error); }
    }
  }
}

/** This server reads shared OpenCode history; it never prompts or resumes a session. */
export class AnalyticsHistoryReader {
  constructor(private readonly directory: string, private readonly pricing: ModelPricingReader = new ModelsDevCatalogReader()) {}
  async read(sessionId: string): Promise<OpenCodeMessageEnvelope[]> {
    const server = await ensureOpenCodeServer({ runtimeDirectory: this.directory, executable: await resolveOpenCodeExecutable(), directory: process.cwd(), config: {} });
    return openCodeServerClient(server).getMessages(sessionId);
  }
  async readPricing(): Promise<ModelPricingCatalog | undefined> { return this.pricing.read(); }
  async close(): Promise<void> {
    const server = await readOpenCodeServer(this.directory);
    if (server) await stopOpenCodeServer(server);
  }
}

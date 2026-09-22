import { claudeConfigDirectory, claudeUsage, readClaudeTranscript } from "../../runtimes/claude-code/transcript.js";
import type { ModelPricingCatalog } from "../../profiles/model-pricing.js";
import { ModelsDevCatalogReader, type ModelPricingReader } from "../../profiles/models-dev-catalog.js";
import { resolveOpenCodeExecutable } from "../../platform/executable-resolver.js";
import { ensureOpenCodeServer, openCodeServerClient, readOpenCodeServer, stopOpenCodeServer } from "../../runtimes/opencode/server.js";
import type { TaskSession } from "../control.js";
import { sessionHarness } from "../../runtimes/task-harness.js";
import { CodexSessionReader } from "../../runtimes/codex/session-reader.js";
import { DevinSessionReader } from "../../runtimes/devin/session-reader.js";
import { OpenCodeFailure } from "../../runtimes/opencode/client.js";
import type { TaskRepository } from "../repository.js";
import type { TaskAnalyticsStore } from "./store.js";
import { taskUsage, type TaskUsage } from "../usage.js";

export class TaskAnalyticsCollector {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  private firstCollection = true;
  constructor(private readonly repository: TaskRepository, private readonly store: TaskAnalyticsStore,
    private readonly readUsage: (session: TaskSession, pricing: ModelPricingCatalog | undefined) => Promise<TaskUsage[]>,
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
    const startup = this.firstCollection;
    this.firstCollection = false;
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
          const refreshMs = startup && sessionHarness(session.nativeSessionId) === "codex" ? 0 : previous?.errorAt ? 300_000 : !changedSinceObservation && (task.archivedAt || !["active", "waiting_human"].includes(task.status)) ? 900_000 : 0;
          if (lastAttempt && Date.now() - Date.parse(lastAttempt) < refreshMs) continue;
          try {
            const readStartedAt = new Date().toISOString();
            this.store.record(task.id, session.id, await this.readUsage(session, await optionalPricing()), readStartedAt);
          } catch (error) {
            this.store.failed(task.id, session.id);
            if (!(error instanceof OpenCodeFailure && error.code === "not_found")) this.reportError(error);
          }
        }
      } catch (error) { this.reportError(error); }
    }
  }
}

/** Reads shared native history: the OpenCode server here never prompts or resumes a session, and Claude Code transcripts are read as files. */
export class AnalyticsHistoryReader {
  constructor(private readonly databasePath: string, private readonly directory: string, private readonly pricing: ModelPricingReader = new ModelsDevCatalogReader()) {}
  async read(session: Pick<TaskSession, "id" | "nativeSessionId" | "kind" | "profile">, pricing?: ModelPricingCatalog): Promise<TaskUsage[]> {
    const sessionId = session.nativeSessionId;
    if (!sessionId) throw new Error("Session is not available");
    if (sessionHarness(sessionId) === "claude-code") return claudeUsage(await readClaudeTranscript(sessionId, session.profile?.instanceHomeDirectory ?? claudeConfigDirectory()), sessionId, session.kind, pricing);
    if (sessionHarness(sessionId) === "devin") return (await new DevinSessionReader(this.databasePath).timeline(session, pricing)).usage;
    if (sessionHarness(sessionId) === "codex") return (await new CodexSessionReader(this.databasePath).timeline(session, pricing)).usage;
    const server = await ensureOpenCodeServer({ runtimeDirectory: this.directory, executable: await resolveOpenCodeExecutable(), directory: process.cwd(), config: {} });
    return taskUsage(await openCodeServerClient(server).getMessages(sessionId), session.kind, pricing);
  }
  async readPricing(): Promise<ModelPricingCatalog | undefined> { return this.pricing.read(); }
  async close(): Promise<void> {
    const server = await readOpenCodeServer(this.directory);
    if (server) await stopOpenCodeServer(server);
  }
}

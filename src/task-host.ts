import { z } from "zod";
import { dirname, join } from "node:path";
import { ArtifactStore } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import { DeliveryOperations } from "./delivery-operations.js";
import { CliHerdrClient } from "./herdr-client.js";
import { StructuredLogger } from "./logging.js";
import { OpenCodeTaskRuntime } from "./opencode-task-runtime.js";
import { RootController } from "./root-controller.js";
import { TaskControlStore } from "./root-session-store.js";
import { prepareTaskWorktree } from "./task-worktree.js";

type Controller = Pick<RootController, "prepareRoot" | "recover">;

export class TaskHost {
  private readonly store: TaskControlStore;
  private readonly controller: Controller;
  private readonly delivery: Pick<DeliveryOperations, "observe">;
  private readonly worktree: typeof prepareTaskWorktree;
  private readonly running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly database: ForgeDatabase, options: { artifactRoot?: string; controller?: Controller; delivery?: Pick<DeliveryOperations, "observe">; worktree?: typeof prepareTaskWorktree } = {}) {
    this.store = new TaskControlStore(database);
    this.delivery = options.delivery ?? new DeliveryOperations(this.store);
    const artifactRoot = options.artifactRoot ?? join(dirname(database.filename()), "artifacts");
    this.controller = options.controller ?? new RootController(this.store, new OpenCodeTaskRuntime(database.filename(), new CliHerdrClient(), { artifactRoot }), undefined, new ArtifactStore(artifactRoot));
    this.worktree = options.worktree ?? prepareTaskWorktree;
  }

  start(): void {
    if (this.timer || this.stopping) return;
    this.tickSafely();
    this.timer = setInterval(() => this.tickSafely(), 1_000);
    this.timer.unref();
  }

  private tickSafely(): void {
    try { this.tick(); }
    catch (error) { new StructuredLogger().warn("Task scheduling will be retried", {}, { error: error instanceof Error ? error.message : String(error) }); }
  }

  private tick(): void {
    if (this.stopping) return;
    const ids = this.database.authQuery(db => z.array(z.object({ task_id: z.string() })).parse(db.prepare("SELECT c.task_id FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id WHERE (t.archived_at IS NULL AND c.status IN ('active', 'waiting_human') AND (c.wake_at IS NULL OR c.wake_at <= ?)) OR EXISTS (SELECT 1 FROM forge_task_sessions s WHERE s.task_id = c.task_id AND s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL) ORDER BY COALESCE(c.wake_at, c.created_at)").all(new Date().toISOString())));
    for (const row of ids) {
      if (this.running.has(row.task_id)) continue;
      if (this.running.size >= 4) break;
      void this.recover(row.task_id).catch(error => new StructuredLogger().warn("Task recovery will be retried", { taskId: row.task_id }, { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  recover(taskId: string): Promise<void> {
    const current = this.running.get(taskId);
    if (current) return current;
    if (this.stopping) return Promise.reject(new Error("Task host is stopping"));
    const operation = this.recoverOne(taskId).finally(() => this.running.delete(taskId));
    this.running.set(taskId, operation);
    return operation;
  }

  private async recoverOne(taskId: string): Promise<void> {
    let observationError: unknown;
    try { await this.delivery.observe(taskId); } catch (error) { observationError = error; }
    if (this.store.get(taskId).status === "active") {
      try {
        this.controller.prepareRoot(taskId);
        const configuration = this.store.context(taskId).configuration;
        const worktree = await this.worktree({ taskId, repositoryPath: configuration.repositoryPath, worktreeRoot: configuration.worktreeRoot, branch: configuration.branch, startingSha: configuration.startingSha });
        if (this.store.get(taskId).status === "active") this.store.setWorktree(taskId, worktree);
      } catch (error) {
        if (this.store.get(taskId).status === "active") this.store.askHuman(taskId, `Forge could not prepare this task. ${error instanceof Error ? error.message : "Worktree preparation failed"}. Resolve the problem, then answer to retry.`);
      }
    }
    try { await this.controller.recover(taskId); }
    catch (error) {
      if (this.store.get(taskId).status !== "active") throw error;
      new StructuredLogger().warn("OpenCode recovery will be retried from native state", { taskId }, { error: error instanceof Error ? error.message : String(error) });
    }
    const status = this.store.get(taskId).status;
    if (status === "active" || status === "waiting_human") this.store.scheduleWake(taskId, new Date(Date.now() + 15_000).toISOString());
    if (observationError) throw observationError;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.running.values());
  }
}

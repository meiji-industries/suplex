import { CompletedPullRequests } from "../delivery/completed-pull-requests.js";
import { z } from "zod";
import { dirname, join } from "node:path";
import { ArtifactStore } from "../platform/artifacts.js";
import type { ForgeDatabase } from "../platform/database.js";
import { DeliveryOperations } from "../delivery/operations.js";
import { CliHerdrClient } from "../integrations/herdr/client.js";
import { StructuredLogger } from "../platform/logging.js";
import { RootController } from "../coordination/root-controller.js";
import { TaskControlStore } from "../coordination/root-session-store.js";
import { createTaskHarness, nativeSessionReader } from "../runtimes/task-harness-registry.js";
import { prepareTaskWorktree } from "./worktree.js";
import { taskEvidenceRoot } from "../coordination/workflow-evidence.js";
import { prepareProjectWorkspace } from "./preparation.js";
import { hasStartedNativeWork, prepareIssueContext } from "./issue-context.js";
import { ProjectExecutionSchema } from "../projects/execution-configuration.js";
import { projectCredentialEnvironmentKeys } from "../runtimes/project-environment.js";
import { MissingIntegrationCredential } from "../projects/integration-configuration.js";
import { IssueTrackerScopeFailure } from "../integrations/issue-tracker.js";
import { ProviderHttpFailure } from "../integrations/provider-http.js";
import { createGithubReleasePort, type GithubReleasePort } from "../integrations/github/delivery.js";
import { updatePullRequestDependencyInTransaction, type PullRequestDependency } from "./pull-request-dependencies.js";

type Controller = Pick<RootController, "prepareRoot" | "recover">;

export class TaskHost {
  private readonly store: TaskControlStore;
  private readonly controller: Controller;
  private readonly delivery: Pick<DeliveryOperations, "observe"> & Partial<Pick<DeliveryOperations, "observeDeliveryWait">>;
  private readonly worktree: typeof prepareTaskWorktree;
  private readonly artifactRoot: string;
  private readonly running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly completedPullRequests: Pick<CompletedPullRequests, "refresh">;
  private completedRefresh: Promise<void> | undefined;
  private nextCompletedRefresh = 0;
  private readonly pullRequestObserver: Pick<Required<GithubReleasePort>, "observePullRequest">;
  private prerequisiteRefresh: Promise<void> | undefined;
  private nextPrerequisiteRefresh = 0;

  constructor(private readonly database: ForgeDatabase, options: { completedPullRequests?: Pick<CompletedPullRequests, "refresh">; artifactRoot?: string; controller?: Controller; delivery?: Pick<DeliveryOperations, "observe"> & Partial<Pick<DeliveryOperations, "observeDeliveryWait">>; worktree?: typeof prepareTaskWorktree; pullRequestObserver?: Pick<Required<GithubReleasePort>, "observePullRequest"> } = {}) {
    this.store = new TaskControlStore(database);
    this.completedPullRequests = options.completedPullRequests ?? new CompletedPullRequests(database);
    const artifactRoot = this.artifactRoot = options.artifactRoot ?? join(dirname(database.filename()), "artifacts");
    const nativeDelivery = new DeliveryOperations(this.store, undefined, artifactRoot);
    this.delivery = options.delivery ?? nativeDelivery;
    this.controller = options.controller ?? new RootController(this.store, createTaskHarness(database.filename(), new CliHerdrClient(), { artifactRoot }), nativeDelivery, new ArtifactStore(artifactRoot), { root: taskEvidenceRoot(database.filename()) }, session => nativeSessionReader(database.filename(), session));
    this.worktree = options.worktree ?? prepareTaskWorktree;
    this.pullRequestObserver = options.pullRequestObserver ?? createGithubReleasePort();
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
    if (!this.completedRefresh && Date.now() >= this.nextCompletedRefresh) {
      this.nextCompletedRefresh = Date.now() + 60_000;
      this.completedRefresh = this.completedPullRequests.refresh()
        .catch(error => new StructuredLogger().warn("Completed pull request refresh will be retried", {}, { error: error instanceof Error ? error.message : String(error) }))
        .finally(() => { this.completedRefresh = undefined; });
    }
    // The queue sweep runs every tick. GitHub refresh is slower and single-flight, but a completed refresh gets its own admission pass.
    this.store.admitQueued();
    if (!this.prerequisiteRefresh && Date.now() >= this.nextPrerequisiteRefresh) {
      this.nextPrerequisiteRefresh = Date.now() + 60_000;
      this.prerequisiteRefresh = this.refreshPullRequestPrerequisites()
        .catch(error => new StructuredLogger().warn("Pull request prerequisite refresh will be retried", {}, { error: error instanceof Error ? error.message : String(error) }))
        .then(() => { this.store.admitQueued(); })
        .finally(() => { this.prerequisiteRefresh = undefined; });
    }
    const ids = this.database.authQuery(db => z.array(z.object({ task_id: z.string() })).parse(db.prepare("SELECT c.task_id FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id WHERE (t.archived_at IS NULL AND c.status IN ('active', 'waiting_human') AND (c.wake_at IS NULL OR c.wake_at <= ?)) OR EXISTS (SELECT 1 FROM forge_task_sessions s WHERE s.task_id = c.task_id AND s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL) ORDER BY COALESCE(c.wake_at, c.created_at)").all(new Date().toISOString())));
    for (const row of ids) {
      if (this.running.has(row.task_id)) continue;
      if (this.running.size >= 4) break;
      void this.recover(row.task_id).catch(error => new StructuredLogger().warn("Task recovery will be retried", { taskId: row.task_id }, { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async refreshPullRequestPrerequisites(): Promise<void> {
    const rows = this.database.authQuery(db => db.prepare("SELECT d.task_id AS taskId, d.pull_request_number AS number, d.state, d.title, d.url, d.observed_at AS observedAt, json_extract(t.configuration_json, '$.repository') AS repository FROM forge_task_pull_request_dependencies d JOIN forge_tasks t ON t.id = d.task_id JOIN forge_task_controls c ON c.task_id = t.id WHERE t.archived_at IS NULL AND c.status = 'queued' ORDER BY d.task_id, d.pull_request_number").all() as Array<PullRequestDependency & { taskId: string; repository: string }>);
    for (const row of rows) {
      try {
        const observed = await this.pullRequestObserver.observePullRequest({ repository: row.repository, branch: "", pullRequestNumber: row.number });
        if (!observed.exists || !observed.state || !observed.url) continue;
        const state = observed.state; const url = observed.url;
        this.database.authImmediateTransaction(db => updatePullRequestDependencyInTransaction(db, row.taskId, { number: row.number, state, title: observed.title ?? row.title, url, observedAt: new Date().toISOString() }));
      } catch (error) {
        new StructuredLogger().warn("Pull request prerequisite observation will be retried", { taskId: row.taskId }, { error: error instanceof Error ? error.message : String(error) });
      }
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
    if (this.store.get(taskId).status === "delivered") {
      try { await this.completedPullRequests.refresh(); }
      finally { await this.controller.recover(taskId); }
      return;
    }
    let observationError: unknown;
    try { await this.delivery.observe(taskId); } catch (error) { observationError = error; }
    if (this.store.get(taskId).status === "active") {
      try {
        const configuration = this.store.context(taskId).configuration;
        const worktree = await this.worktree({ taskId, repositoryPath: configuration.repositoryPath, worktreeRoot: configuration.worktreeRoot, branch: configuration.branch, startingSha: configuration.startingSha });
        if (this.store.get(taskId).status === "active") this.store.setWorktree(taskId, worktree);
        if (!hasStartedNativeWork(this.database, taskId)) {
          try { await prepareIssueContext(this.database, taskId, undefined, this.artifactRoot); }
          catch (error) {
            if (error instanceof MissingIntegrationCredential || error instanceof IssueTrackerScopeFailure || error instanceof ProviderHttpFailure && [401, 403, 404].includes(error.status)) {
              if (this.store.get(taskId).status === "active") this.store.askHuman(taskId, `Forge cannot read the linked issue. ${error.message}. Check the issue and tracker access, then answer to retry.`);
              return;
            }
            new StructuredLogger().warn("Issue context intake will be retried", { taskId }, { error: error instanceof Error ? error.message : String(error) });
            this.store.scheduleWake(taskId, new Date(Date.now() + 15_000).toISOString());
            return;
          }
          if (configuration.execution || configuration.integration || this.store.context(taskId).issueContext) await prepareProjectWorkspace({ databasePath: this.database.filename(), taskId, directory: worktree.path, execution: configuration.execution ?? ProjectExecutionSchema.parse({}), setupCommand: configuration.setupCommand, excludedEnvironmentKeys: projectCredentialEnvironmentKeys(configuration.integration, configuration.execution?.mcp) });
        }
        this.controller.prepareRoot(taskId);
      } catch (error) {
        this.controller.prepareRoot(taskId);
        if (this.store.get(taskId).status === "active") this.store.askHuman(taskId, `Forge could not prepare this task. ${error instanceof Error ? error.message : "Worktree preparation failed"}. Resolve the problem, then answer to retry.`);
      }
    }
    // A delivery wait re-observes GitHub at its own interval; unchanged state schedules only the next observation.
    if (this.store.get(taskId).status === "active" && this.store.get(taskId).workflowState.deliveryWait && this.delivery.observeDeliveryWait) {
      try { await this.delivery.observeDeliveryWait(taskId); }
      catch (error) { new StructuredLogger().warn("Delivery wait observation will be retried", { taskId }, { error: error instanceof Error ? error.message : String(error) }); }
    }
    try { await this.controller.recover(taskId); }
    catch (error) {
      if (this.store.get(taskId).status !== "active") throw error;
      new StructuredLogger().warn("Agent recovery will be retried from native state", { taskId }, { error: error instanceof Error ? error.message : String(error) });
    }
    const control = this.store.get(taskId);
    if (control.status === "active" || control.status === "waiting_human") this.store.scheduleWake(taskId, new Date(Date.now() + (control.workflowState.deliveryWait ? 30_000 : 15_000)).toISOString());
    if (observationError) throw observationError;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.running.values(), ...(this.completedRefresh ? [this.completedRefresh] : [])]);
  }
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestConfig, type ForgeConfig } from "../../src/config.js";
import { ForgeDatabase } from "../../src/database.js";
import { loadIssueRuns } from "../../src/engine/host.js";
import { installIssueEngine } from "../../src/engine/index.js";
import { buildInitialIssueWorkflowState, IssueContinuationStateSchema, IssueWorkflowInputSchema, IssueWorkflowStateSchema, type IssueActivities, type IssueWorkflowInput, type IssueWorkflowState } from "../../src/engine/issue-contracts.js";
import { IssueEngine, type EngineClock } from "../../src/engine/runs.js";
import { runtimeIdentifiers } from "../../src/runtime-identifiers.js";
import { isBlocked } from "../../src/issue-phases.js";

export const engineFixture = { companyId: "issue-company", projectId: "issue-project", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", actorUserId: "issue-admin", sha256: "a".repeat(64), base: "a".repeat(40), commit: "b".repeat(40), tree: "c".repeat(40), roleProfiles: { planner: "profile", builder: "profile" } };

export class ImmediateClock implements EngineClock {
  private milliseconds = Date.parse("2026-08-29T00:00:00.000Z");
  now(): number { return this.milliseconds; }
  async wait(milliseconds: number, signal: AbortSignal): Promise<void> { if (signal.aborted) throw signal.reason; this.milliseconds += Math.max(0, milliseconds); await Promise.resolve(); }
}

export interface EngineHarness {
  root: string; config: ForgeConfig; database: ForgeDatabase; engine: IssueEngine; clock: ImmediateClock;
  activities: Partial<IssueActivities>; calls: Map<string, number>;
  workflowId(issueId: string): string;
  seedTask(issueId: string, options?: { autoApprovePlan?: boolean; pullRequestMode?: "draft" | "ready" | "auto_merge"; deliveryTarget?: "local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged" }): void;
  seedContinuation(issueId: string, continuationState: NonNullable<IssueWorkflowInput["continuationState"]>): IssueWorkflowState;
  startContinuation(issueId: string, continuationState: NonNullable<IssueWorkflowInput["continuationState"]>, extra?: Partial<IssueWorkflowInput>): Promise<{ workflowId: string; runId: string }>;
  restart(): Promise<IssueEngine>;
  settle(workflowId: string, predicate: (state: IssueWorkflowState) => boolean): Promise<IssueWorkflowState>;
  stop(): Promise<void>;
}

function seedFoundation(database: ForgeDatabase, root: string): void {
  const now = "2026-08-29T00:00:00.000Z";
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES (?, 'Issue Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(engineFixture.actorUserId, now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, 'Issue Company', 'active', ?)").run(engineFixture.companyId, now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile', 'Integration profile', 'codex', 'gpt-5.6-sol', 'medium', 'standard', 4, ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES (?, ?, 'Issue Project', ?, ?, 'acme/forge', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(engineFixture.projectId, engineFixture.companyId, join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief.bin', ?)").run(engineFixture.briefArtifactId, engineFixture.companyId, engineFixture.sha256, now);
  });
}

export async function createEngineHarness(overrides: Partial<IssueActivities> = {}, suppliedClock?: ImmediateClock): Promise<EngineHarness> {
  const root = await mkdtemp(join(tmpdir(), "forge-engine-")); const config = createTestConfig(root); const clock = suppliedClock ?? new ImmediateClock(); const calls = new Map<string, number>(); const activities: Partial<IssueActivities> = {
    claimDeliveryOwner: async () => ({ outcome: "owned", wakeAt: new Date(clock.now() + 60_000).toISOString() }),
    recordDeliveryOwnerReceipt: async () => true,
    cancelDeliveryOwner: async () => true,
    readHerdrTurn: async () => ({ type: "owner.live" }),
    inspectTaskWorktree: async (input) => ({
      present: true,
      owned: true,
      dirtyFileCount: 0,
      branch: input.expectedBranch ?? null,
      activeExecution: false,
      revision: {
        proven: true,
        head: input.expectedCommit ?? null,
        headTree: input.expectedTree ?? null,
        branch: input.expectedBranch ?? null,
        clean: true,
      },
    }),
    ...overrides,
  };
  let database = new ForgeDatabase(config.databasePath); seedFoundation(database, root);
  const activityProxy = new Proxy({}, { get: (_target, property) => async (...args: unknown[]) => {
    const name = String(property);
    calls.set(name, (calls.get(name) ?? 0) + 1);
    const activity = activities[name as keyof IssueActivities] as ((...values: unknown[]) => unknown) | undefined;
    if (name === "projectIssueState") {
      const event = args[0] as Parameters<IssueActivities["projectIssueState"]>[0];
      database.projectIssueEvent(event);
      return activity ? activity(...args) : event.state;
    }
    if (!activity) throw new Error(`Activity function ${name} is not registered`);
    return activity(...args);
  } });
  let engine = new IssueEngine(config, database, { activities: activityProxy, clock }); installIssueEngine(config, engine);
  const harness: EngineHarness = {
    root, config, clock, activities, calls,
    get database() { return database; }, get engine() { return engine; },
    workflowId: (issueId) => `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-${issueId}`,
    seedTask(issueId, options = {}) { const now = new Date(clock.now()).toISOString(); database.authQuery((db) => db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, auto_approve_plan, pull_request_mode, delivery_target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)").run(issueId, engineFixture.companyId, engineFixture.projectId, issueId, engineFixture.briefArtifactId, JSON.stringify(engineFixture.roleProfiles), harness.workflowId(issueId), engineFixture.projectRevisionId, `${issueId}-key`, options.autoApprovePlan ? 1 : 0, options.pullRequestMode ?? "ready", options.deliveryTarget ?? "pull_request_ready", now, now)); },
    seedContinuation(issueId, continuationState) {
      const workflowId = harness.workflowId(issueId);
      const continuation = IssueContinuationStateSchema.parse(continuationState);
      const finalState = IssueWorkflowStateSchema.parse({
        ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
        ...continuation,
      });
      for (let revision = 0; revision <= finalState.revision; revision += 1) {
        const state = revision === finalState.revision ? finalState : IssueWorkflowStateSchema.parse({ ...finalState, revision, lastEventId: `${workflowId}:${revision}` });
        database.projectIssueEvent({ schemaVersion: 1, runId: `seed-${issueId}`, eventId: state.lastEventId, state });
      }
      return finalState;
    },
    async startContinuation(issueId, continuationState, extra = {}) {
      const workflowId = harness.workflowId(issueId);
      harness.seedContinuation(issueId, continuationState);
      const run = await engine.create(IssueWorkflowInputSchema.parse({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2, continuationState, ...extra }));
      return { workflowId, runId: run.runId };
    },
    async restart() { engine.dispose(); database.close(); database = new ForgeDatabase(config.databasePath); engine = new IssueEngine(config, database, { activities: activityProxy, clock }); installIssueEngine(config, engine); await loadIssueRuns(engine); return engine; },
    async settle(workflowId, predicate) { let last!: IssueWorkflowState; for (let attempt = 0; attempt < 2_000; attempt += 1) { const run = engine.run(workflowId); last = run.state; if (predicate(last)) return last; if (run.error) throw run.error; await Promise.resolve(); } throw new Error(`Engine run ${workflowId} did not settle from ${last.phase}/${last.step}${isBlocked(last) ? " (blocked)" : ""}: ${JSON.stringify(last.lastHandlerError)}`); },
    async stop() { engine.dispose(); database.close(); await rm(root, { recursive: true, force: true }); },
  };
  return harness;
}

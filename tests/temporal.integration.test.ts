import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";

import { Connection } from "@temporalio/client";
import proto from "@temporalio/proto";
import { NativeConnection, Worker } from "@temporalio/worker";

import { createTestConfig, loadConfig } from "../src/config.js";
import { createForgeServer, type ForgeServer } from "../src/server.js";
import { ForgeDatabase } from "../src/database.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { createActivities } from "../src/temporal/activities.js";
import { approveIssuePlan, connectTemporal, ensureTemporalFoundation, queryIssueWorkflow, queryProbeWorkflow, rejectIssuePlan, startIssuePlanning, startIssueWorkflow, startProbeWorkflow } from "../src/temporal/service.js";

const execFileAsync = promisify(execFile);
const replayDurationKeys = new Set(["firstWorkflowTaskBackoff", "workflowTaskTimeout", "startToCloseTimeout", "scheduleToCloseTimeout", "scheduleToStartTimeout", "heartbeatTimeout", "initialInterval", "maximumInterval"]);

function sanitizeReplayValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeReplayValue(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (replayDurationKeys.has(key ?? "") && Object.keys(record).length === 0) return "0s";
  if ((typeof record.seconds === "string" || typeof record.seconds === "number") && (record.nanos === undefined || typeof record.nanos === "number")) {
    const nanos = typeof record.nanos === "number" ? record.nanos : 0;
    if (key === "eventTime") return new Date(Number(record.seconds) * 1000 + nanos / 1_000_000).toISOString();
    const fraction = nanos === 0 ? "" : `.${String(nanos).padStart(9, "0").replace(/0+$/, "")}`;
    return `${record.seconds}${fraction}s`;
  }
  return Object.fromEntries(Object.entries(record).map(([entryKey, entryValue]) => [entryKey, sanitizeReplayValue(entryValue, entryKey)]));
}

async function containerId(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("docker", ["inspect", "--format", "{{.Id}}", name]);
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function publishedTemporalPort(name: string): Promise<number> {
  const result = await execFileAsync("docker", ["port", name, "7233/tcp"]);
  const match = /:(\d+)\s*$/.exec(result.stdout.trim());
  if (!match) {
    throw new Error(`Docker did not publish a host port for ${name}`);
  }
  return Number(match[1]);
}

async function containerStatus(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("docker", ["inspect", "--format", "{{.State.Status}}", name]);
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

test("starts, persists, restarts, and queries a probe Workflow without touching the live Forge container", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-temporal-test-"));
  const containerName = `temporal-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const liveForgeContainerId = await containerId("forge-temporal");
  if (!liveForgeContainerId) {
    await rm(root, { recursive: true, force: true });
    throw new Error("The live Forge Temporal container is required for the non-disruptive integration proof");
  }
  expect(await containerStatus("forge-temporal")).toBe("running");
  expect(await publishedTemporalPort("forge-temporal")).toBe(7233);
  const liveConfig = loadConfig();
  const liveNeutralContainerName = runtimeIdentifiers(liveConfig.installationId).temporalContainerName;
  const liveNeutralContainerId = await containerId(liveNeutralContainerName);
  if (!liveNeutralContainerId) {
    await rm(root, { recursive: true, force: true });
    throw new Error("The migrated neutral Forge Temporal container is required for the non-disruptive integration proof");
  }
  expect(await containerStatus(liveNeutralContainerName)).toBe("running");
  expect(await publishedTemporalPort(liveNeutralContainerName)).toBeGreaterThan(0);
  let config = createTestConfig(root, { taskQueue: `tasks-test-${process.pid}-${randomUUID().slice(0, 8)}` });
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let workerConnection: NativeConnection | undefined;
  let database: ForgeDatabase | undefined;
  let api: ForgeServer | undefined;
  let workflowId = "";

  try {
    await execFileAsync("docker", [
      "run", "--detach", "--name", containerName,
      "--publish", "127.0.0.1::7233",
      "temporalio/temporal:latest", "server", "start-dev", "--ip", "0.0.0.0", "--namespace", config.temporalNamespace,
    ]);
    config = createTestConfig(root, {
      taskQueue: config.taskQueue,
      temporalAddress: `127.0.0.1:${await publishedTemporalPort(containerName)}`,
    });
    let temporalConnection: Connection | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        temporalConnection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    expect(temporalConnection).toBeDefined();
    if (!temporalConnection) {
      throw new Error("Temporal connection was not established");
    }
    await ensureTemporalFoundation(temporalConnection, config);
    temporalConnection.close();

    database = new ForgeDatabase(config.databasePath);
    const integrationAgent = { runLeadPlanning: async () => ({ leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: "artifact_integration_evidence", leadOutputArtifactId: "artifact_integration_output", leadOutputKind: "plan" as const, leadSummary: "Integration plan", materialCategories: ["security_permissions" as const], material: true }) };
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection: workerConnection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
      activities: createActivities(database, config, { agent: integrationAgent }),
    });
    workerRun = worker.run();
    api = await createForgeServer(config);
    expect((await api.app.inject({ method: "GET", url: "/api/auth/status" })).statusCode).toBe(200);

    const started = await startProbeWorkflow(config, { probeId: "probe-restart", companyId: "company-1" });
    workflowId = started.workflowId;
    let state = await queryProbeWorkflow(config, workflowId, started.runId);
    for (let attempt = 0; attempt < 20 && state.status !== "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await queryProbeWorkflow(config, workflowId, started.runId);
    }
    expect(state.status).toBe("running");
    expect(database.getProbe("probe-restart")).toEqual({
      workflowId,
      probeId: "probe-restart",
      companyId: "company-1",
      status: "running",
    });

    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('issue-admin', 'Issue Admin', 'issue-admin@forge.local', 'admin', 'active', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('issue-company', 'Issue Company', 'active', ?)").run(new Date().toISOString());
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('issue-project', 'issue-company', 'Issue Project', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[\"Tests / unit\"]', '[]', '{}', 'active', 'issue-revision', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, actor_user_id, created_at) VALUES ('issue-revision', 'issue-project', 1, 'issue-identity', '{}', 'issue-admin', ?)").run(new Date().toISOString());
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('issue-brief', 'issue-company', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'issue-company/issue-brief.bin', ?)").run("0".repeat(64), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-restart', 'issue-company', 'issue-project', 'Restart issue', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-restart-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-restart`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-continuation', 'issue-company', 'issue-project', 'Continue issue', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-continuation-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-continuation`, new Date().toISOString(), new Date().toISOString());
    });
    const startedIssue = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false });
    let issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    for (let attempt = 0; attempt < 20 && issueState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    }
    expect(issueState).toMatchObject({ issueId: "issue-restart", phase: "backlog", revision: 0, allowedCommands: ["start_planning"] });
    const plannedIssue = await startIssuePlanning(config, startedIssue.workflowId, { expectedRevision: 0, actorUserId: "issue-admin" });
    expect(plannedIssue).toMatchObject({ phase: "approval", revision: 1, owner: "human", planMaterial: true, materialCategories: ["security_permissions"] });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-restart'").get())).toEqual({ revision: 1, phase: "approval" });
    const revisionRequested = await rejectIssuePlan(config, startedIssue.workflowId, { expectedRevision: 1, actorUserId: "issue-admin", note: "Please address the security boundary" });
    expect(revisionRequested).toMatchObject({ phase: "planning", revision: 2, allowedCommands: ["start_planning"], planRevision: null, planMaterial: null });
    const replannedIssue = await startIssuePlanning(config, startedIssue.workflowId, { expectedRevision: 2, actorUserId: "issue-admin" });
    expect(replannedIssue).toMatchObject({ phase: "approval", revision: 3, planRevision: 3, planMaterial: true });

    const startedContinuation = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, continueAsNewAfter: 2 });
    let continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
    for (let attempt = 0; attempt < 20 && continuationState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
    }
    expect(continuationState).toMatchObject({ phase: "backlog", revision: 0, continuationCount: 0 });
    await startIssuePlanning(config, startedContinuation.workflowId, { expectedRevision: 0, actorUserId: "issue-admin" });
    const progressState = await approveIssuePlan(config, startedContinuation.workflowId, { expectedRevision: 1, actorUserId: "issue-admin", note: "Approved for development" });
    expect(progressState).toMatchObject({ phase: "ready_for_development", revision: 2, continuationCount: 0 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
      if (continuationState.continuationCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(continuationState).toMatchObject({ workflowId: startedContinuation.workflowId, companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", phase: "ready_for_development", revision: 2, owner: "lead", allowedCommands: [], pendingAction: null, lastEventId: `${startedContinuation.workflowId}:2`, continuationCount: 1, lastSummaryHash: null, leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: "artifact_integration_evidence", leadOutputArtifactId: "artifact_integration_output", leadOutputKind: "plan", leadSummary: "Integration plan", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false });
    expect(continuationState.decisionId).toMatch(/^decision_/);
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get())).toEqual({ revision: 2, phase: "ready_for_development" });
    expect(database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = 'issue-continuation' ORDER BY revision").all())).toEqual([{ revision: 0 }, { revision: 1 }, { revision: 2 }]);
    if (process.env.FORGE_REPLAY_CAPTURE_PATH) {
      const replayClient = await connectTemporal(config);
      try {
        const history = await replayClient.client.workflow.getHandle(startedIssue.workflowId).fetchHistory();
        const replayHistory = proto.temporal.api.history.v1.History.create(history);
        const replayJson = proto.temporal.api.history.v1.History.toObject(replayHistory, { longs: String, enums: String, bytes: String, defaults: false, arrays: true, objects: true });
        await writeFile(process.env.FORGE_REPLAY_CAPTURE_PATH, JSON.stringify(sanitizeReplayValue(replayJson), null, 2));
      } finally {
        replayClient.connection.close();
      }
    }

    worker.shutdown();
    await workerRun;
    workerRun = undefined;
    worker = undefined;
    await workerConnection.close();
    workerConnection = undefined;
    database.close();
    database = undefined;
    await api.app.close();
    api.database.close();
    api = undefined;

    const reopenedDatabase = new ForgeDatabase(config.databasePath);
    database = reopenedDatabase;
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection: workerConnection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
      activities: createActivities(reopenedDatabase, config, { agent: integrationAgent }),
    });
    workerRun = worker.run();
    api = await createForgeServer(config);
    expect((await api.app.inject({ method: "GET", url: "/api/auth/status" })).statusCode).toBe(200);
    const afterRestart = await queryProbeWorkflow(config, workflowId, started.runId);
    expect(afterRestart.status).toBe("running");
    expect(reopenedDatabase.getProbe("probe-restart")?.workflowId).toBe(workflowId);
    worker.shutdown();
    await workerRun;
    workerRun = undefined;
    worker = undefined;
    await workerConnection.close();
    workerConnection = undefined;
    database.close();
    database = undefined;
    await api.app.close();
    api.database.close();
    api = undefined;
  } finally {
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await workerConnection?.close();
    database?.close();
    if (api) {
      await api.app.close().catch(() => undefined);
      api.database.close();
    }
    await execFileAsync("docker", ["rm", "--force", containerName]).catch(() => undefined);
    expect(await containerId("forge-temporal")).toBe(liveForgeContainerId);
    expect(await containerStatus("forge-temporal")).toBe("running");
    expect(await publishedTemporalPort("forge-temporal")).toBe(7233);
    expect(await containerId(liveNeutralContainerName)).toBe(liveNeutralContainerId);
    expect(await containerStatus(liveNeutralContainerName)).toBe("running");
    expect(await publishedTemporalPort(liveNeutralContainerName)).toBeGreaterThan(0);
    await rm(root, { recursive: true, force: true });
  }
});

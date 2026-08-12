import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { Client, Connection } from "@temporalio/client";
import { expect, test } from "vitest";

import { createTestConfig, type ForgeConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { DeveloperExecutionLeaseRepository, deriveDeveloperExecutionId } from "../src/developer-execution-leases.js";
import { cancelDeveloperExecution } from "../src/developer-recovery.js";
import { requestDeveloperSupervisor, spawnDeveloperSupervisor } from "../src/developer-supervisor.js";
import { DeveloperSupervisorInvocationSchema } from "../src/developer-supervisor-protocol.js";
import { defaultProcessController } from "../src/process-manager.js";
import { issueStateQuery, issueWorkflow, startDevelopmentUpdate, startPlanningUpdate, approvePlanUpdate } from "../src/temporal/workflows.js";
import type { IssueWorkflowInput } from "../src/temporal/issue-contracts.js";

interface ProofInput {
  executionId: string;
  companyId: string;
  taskId: string;
  workflowId: string;
  planRevision: number;
  developerAttempt: number;
  turnKind: "implementation";
  canonicalWorktreePath: string;
  worktreeIdentityHash: string;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Temporal proof port unavailable"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Developer worker-loss proof state");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startWorker(config: ForgeConfig, fixturePath: string, outputPath: string, launchCountPath: string, input: ProofInput): Promise<ChildProcess> {
  const workerPath = fileURLToPath(new URL("./fixtures/developer-worker-loss-worker.ts", import.meta.url));
  const payload = JSON.stringify({ dataRoot: config.dataRoot, temporalAddress: config.temporalAddress, temporalNamespace: config.temporalNamespace, taskQueue: config.taskQueue, installationId: config.installationId, externalTurnCapacity: config.externalTurnCapacity, fixturePath, outputPath, launchCountPath, canonicalWorktreePath: input.canonicalWorktreePath, worktreeIdentityHash: input.worktreeIdentityHash });
  const child = spawn(process.execPath, ["--import", "tsx", workerPath, payload], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await waitFor(async () => {
    if (stdout.includes("WORKER_READY")) return child;
    if (child.exitCode !== null) throw new Error(`Developer proof worker exited before ready: ${stderr}`);
    return undefined;
  }, 20_000);
  return child;
}

function seed(database: ForgeDatabase, config: ForgeConfig, input: ProofInput): void {
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, 'Proof Company', 'active', ?)").run(input.companyId, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, created_at, updated_at) VALUES ('proof-project', ?, 'Proof Project', ?, ?, 'acme/forge', 'main', 'main', '', '', '[]', '[]', '{}', 'active', ?, ?)").run(input.companyId, config.repositoryRoot, config.worktreeRoot, now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('proof-brief', ?, 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'proof/brief.bin', ?), ('proof-delivery', ?, 'developer-delivery', 'delivery.json', 'application/json', 0, ?, 'proof/delivery.bin', ?), ('proof-evidence', ?, 'agent-evidence', 'evidence.jsonl', 'application/x-ndjson', 0, ?, 'proof/evidence.bin', ?)").run(input.companyId, "0".repeat(64), now, input.companyId, "1".repeat(64), now, input.companyId, "2".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, ?, 'proof-project', 'Worker loss proof', 'proof-brief', '[]', '{}', 0, ?, 'proof-revision', 'proof-key', ?, ?)").run(input.taskId, input.companyId, input.workflowId, now, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 1, 1, 'starting', 'forge/proof', ?, ?, ?, ?)").run(input.executionId, input.taskId, input.companyId, input.workflowId, input.canonicalWorktreePath, "a".repeat(40), now, now);
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('proof-user', 'Proof User', 'proof-user', 'admin', 'active', ?, ?)").run(now, now);
  });
}

function processIdentity(value: { pid: number; processGroup: number; startTime: string; executable: string; argv: string[]; ownerUid: number | null }) {
  return value;
}

test("INV-03/INV-07/INV-10/INV-11/INV-13/INV-14 Phase 12 real worker-loss and cancellation proof", async () => {
  const root = await mkdtemp(join("/tmp", "fg-proof-"));
  const temporalPort = await availablePort();
  const installationId = `proof-${randomUUID().slice(0, 8)}`;
  const config = createTestConfig(root, { temporalAddress: `127.0.0.1:${temporalPort}`, temporalNamespace: `${installationId}-namespace`, taskQueue: `${installationId}-queue`, installationId, externalTurnCapacity: 1 });
    const fixturePath = fileURLToPath(new URL("./fixtures/developer-turn-child.mjs", import.meta.url));
  const workflowId = `${installationId}-workflow`;
  const taskId = `${installationId}-task`;
  const executionId = deriveDeveloperExecutionId(workflowId, 1, 1, "implementation");
  const outputPath = join(root, "controlled-output.jsonl");
  const launchCountPath = join(root, "launch-count.log");
    const input: ProofInput = { executionId, companyId: `${installationId}-company`, taskId, workflowId, planRevision: 1, developerAttempt: 1, turnKind: "implementation", canonicalWorktreePath: join(root, "worktree"), worktreeIdentityHash: "w".repeat(64) };
    const workflowInput: IssueWorkflowInput = { workflowId, companyId: input.companyId, projectId: "proof-project", issueId: taskId, projectRevisionId: "proof-revision", briefArtifactId: "proof-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 };
  let temporalProcess: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let restartedWorker: ChildProcess | undefined;
  let database: ForgeDatabase | undefined;
  let connection: Connection | undefined;
  try {
    temporalProcess = spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(temporalPort), "--db-filename", join(root, "temporal.db"), "--namespace", config.temporalNamespace], { stdio: "ignore" });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { connection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    expect(connection).toBeDefined();
    if (!connection) throw new Error("Temporal proof server did not start");
    database = new ForgeDatabase(config.databasePath);
    seed(database, config, input);
    worker = await startWorker(config, fixturePath, outputPath, launchCountPath, input);
    const client = new Client({ connection, namespace: config.temporalNamespace });
    const handle = await client.workflow.start(issueWorkflow, { args: [workflowInput], taskQueue: config.taskQueue, workflowId });
    const planned = await handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: 0, actorUserId: "proof-user" }] });
    await handle.startUpdate(approvePlanUpdate, { args: [{ expectedRevision: planned.revision, actorUserId: "proof-user", note: "Approve production worker-loss proof plan" }], waitForStage: "ACCEPTED" });
    const ready = await waitFor(async () => {
      try {
        const state = await handle.query(issueStateQuery);
        return state.phase === "ready_for_development" ? state : undefined;
      } catch { return undefined; }
    });
    await handle.startUpdate(startDevelopmentUpdate, { args: [{ expectedRevision: ready.revision, actorUserId: "proof-user" }], waitForStage: "ACCEPTED" });
    const lease = await waitFor(async () => {
      const row = database?.authQuery((db) => db.prepare("SELECT supervisor_pid, child_pid, execution_root, lease_token_hash, status FROM forge_developer_execution_leases WHERE execution_id = ?").get(executionId) as { supervisor_pid: number | null; child_pid: number | null; execution_root: string; lease_token_hash: string; status: string } | undefined);
      return row?.supervisor_pid && row.child_pid && row.status === "running" ? row : undefined;
    });
    const rootPath = lease.execution_root;
    const resultPath = join(rootPath, "result.json");
    const eventsPath = join(rootPath, "events.jsonl");
    const beforeEvents = (await stat(eventsPath)).size;
    const supervisorPid = lease.supervisor_pid ?? undefined;
    const childPid = lease.child_pid ?? undefined;
    worker.kill("SIGKILL");
    await new Promise<void>((resolve) => worker?.once("exit", () => resolve()));
    worker = undefined;
    const supervisorSurvived = alive(supervisorPid);
    const childSurvived = alive(childPid);
    expect(supervisorSurvived).toBe(true);
    expect(childSurvived).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await stat(eventsPath)).size).toBeGreaterThan(beforeEvents);
    await waitFor(async () => { try { return JSON.parse(await readFile(resultPath, "utf8")); } catch { return undefined; } }, 15_000);
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_result_claims WHERE execution_id = ?").get(executionId))).toEqual({ count: 0 });
    expect((await readFile(launchCountPath, "utf8")).trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_capacity_requests WHERE task_id = ? AND status = 'active'").get(taskId))).toEqual({ count: 1 });
    restartedWorker = await startWorker(config, fixturePath, outputPath, launchCountPath, input);
    const workflowState = await waitFor(async () => {
      try {
        const state = await handle.query(issueStateQuery);
        return state.phase === "delivery_ready" ? state : undefined;
      } catch { return undefined; }
    }, 20_000);
    expect(workflowState).toMatchObject({ revision: 5, phase: "delivery_ready" });
    const projectedState = await waitFor(async () => {
      const row = database?.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = ?").get(taskId) as { revision: number; phase: string } | undefined);
      return row?.revision === 5 && row.phase === "delivery_ready" ? row : undefined;
    });
    expect(projectedState).toEqual({ revision: 5, phase: "delivery_ready" });
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_result_claims WHERE execution_id = ?").get(executionId))).toEqual({ count: 1 });
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_capacity_requests WHERE task_id = ? AND status = 'released'").get(taskId))).toEqual({ count: 1 });
    database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ? WHERE id = ?").run(new Date().toISOString(), executionId));

    const cancellationId = deriveDeveloperExecutionId(workflowId, 1, 2, "implementation");
    const cancellationRoot = join(config.runtimeRoot, "developer-executions", cancellationId);
    const cancellationWorktree = join(root, "cancel-worktree");
    const preservedWorkPath = join(cancellationWorktree, "preserved.txt");
    await mkdir(cancellationWorktree, { recursive: true });
    await writeFile(preservedWorkPath, "preserved dirty work\n");
    database.authTransaction((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 1, 2, 'starting', 'forge/proof-cancel', ?, ?, ?, ?)").run(cancellationId, taskId, input.companyId, workflowId, cancellationWorktree, "a".repeat(40), new Date().toISOString(), new Date().toISOString()));
    const cancellationRepository = new DeveloperExecutionLeaseRepository(database, config.runtimeRoot);
    const reservation = cancellationRepository.reserve({ executionId: cancellationId, companyId: input.companyId, taskId, workflowId, attempt: 2, turnKind: "implementation", canonicalWorktreePath: cancellationWorktree, worktreeIdentityHash: "c".repeat(64) });
    const cancellationToken = reservation.leaseToken;
    if (!cancellationToken) throw new Error("Cancellation proof lease token was not created");
    await cancellationRepository.ensureExecutionRoot(cancellationId);
    const cancellationInvocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId: cancellationId, command: process.execPath, args: [fixturePath, "--duration", "60000", "--ignore-term", "true", "--ignore-term-duration", "60000", "--fork-child", "true", "--fork-duration", "60000", "--output", join(root, "cancel-output.jsonl")], cwd: root, env: { PATH: process.env.PATH ?? "" } });
    await writeFile(join(cancellationRoot, "lease-token"), `${cancellationToken}\n`, { mode: 0o600 });
    await writeFile(join(cancellationRoot, "invocation.json"), `${JSON.stringify(cancellationInvocation)}\n`);
    await writeFile(join(cancellationRoot, "events.jsonl"), "", { mode: 0o600 });
    cancellationRepository.markSupervisorStarting(cancellationId);
    const cancellationSupervisor = spawnDeveloperSupervisor(cancellationRoot, cancellationToken, cancellationInvocation);
    const cancellationSupervisorInspection = await waitFor(async () => cancellationSupervisor.pid ? await defaultProcessController.inspect(cancellationSupervisor.pid) : undefined);
    cancellationRepository.setSupervisorIdentity(cancellationId, processIdentity({ pid: cancellationSupervisorInspection.pid, processGroup: cancellationSupervisorInspection.processGroup, startTime: cancellationSupervisorInspection.startTime, executable: cancellationSupervisorInspection.executable, argv: cancellationSupervisorInspection.argv, ownerUid: cancellationSupervisorInspection.ownerUid ?? null }));
    await waitFor(async () => {
      const response = await requestDeveloperSupervisor(cancellationRoot, { version: 1, command: "status", executionId: cancellationId, leaseToken: cancellationToken }).catch(() => null);
      if (!response || !("child" in response) || !response.child) return undefined;
      cancellationRepository.setChildIdentity(cancellationId, response.child);
      return true;
    });
    const cancellationStatus = await requestDeveloperSupervisor(cancellationRoot, { version: 1, command: "status", executionId: cancellationId, leaseToken: cancellationToken });
    if (!cancellationStatus) throw new Error("Cancellation proof supervisor status was unavailable before cancel");
    if (!("child" in cancellationStatus) || !cancellationStatus.child) throw new Error("Cancellation proof child status was unavailable before cancel");
    if (cancellationStatus.supervisor.processGroup === cancellationStatus.child.processGroup) throw new Error(`Cancellation proof supervisor and child share process group ${cancellationStatus.child.processGroup}`);
    const unrelated = spawn(process.execPath, [fixturePath, "--duration", "60000", "--ignore-term", "true"], { stdio: "ignore" });
    const cancellation = await cancelDeveloperExecution(database, cancellationId);
    if (cancellation.status !== "cancelled_confirmed") throw new Error(`Cancellation proof returned ${JSON.stringify(cancellation)}; supervisor=${await readFile(join(cancellationRoot, "supervisor.json"), "utf8").catch(() => "missing")}; result=${await readFile(join(cancellationRoot, "result.json"), "utf8").catch(() => "missing")}`);
    const unrelatedAliveAfterCancel = alive(unrelated.pid);
    expect(unrelatedAliveAfterCancel).toBe(true);
    const cancellationEvidence = cancellationRepository.get(cancellationId);
    expect(cancellationEvidence?.termSentAt).toBeTruthy();
    if (!cancellationEvidence?.killSentAt) throw new Error(`Cancellation supervisor evidence lacked kill timestamp: ${await readFile(join(cancellationRoot, "supervisor.json"), "utf8").catch(() => "missing")}`);
    expect(cancellationEvidence?.killSentAt).toBeTruthy();
    expect(cancellationEvidence?.confirmedExitAt).toBeTruthy();
    expect(await readFile(preservedWorkPath, "utf8")).toBe("preserved dirty work\n");
    unrelated.kill("SIGKILL");

    const proofDirectory = join(process.cwd(), ".scratch", "forge-mvp", "proof");
    await mkdir(proofDirectory, { recursive: true });
    await writeFile(join(proofDirectory, "developer-worker-kill.md"), [
      "# Ticket 09 real worker-loss proof",
      "",
      `- Node: ${process.versions.node}`,
      "- pnpm: 11.0.6",
      "- Temporal TypeScript SDK: 1.22.0 (workflow/worker/proto packages)",
      `- Workflow ID: ${workflowId}`,
      "- Production issueWorkflow revisions: 0 -> 1 -> 2 -> 3 -> 4 -> 5",
      `- Execution ID: ${executionId}`,
      `- Lease token hash: ${lease.lease_token_hash}`,
      `- Supervisor PID identity survived worker SIGKILL: ${supervisorPid} / ${supervisorSurvived}`,
      `- Child PID identity survived worker SIGKILL: ${childPid} / ${childSurvived}`,
      `- Child launch count after retry: ${(await readFile(launchCountPath, "utf8")).trim().split(/\r?\n/).filter(Boolean).length}`,
      `- Result claim count: ${database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_developer_result_claims WHERE execution_id = ?").get(executionId) as { count: number }).count)}`,
      `- Capacity release count: ${database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_capacity_requests WHERE task_id = ? AND status = 'released'").get(taskId) as { count: number }).count)}`,
      `- Cancellation term/kill/confirmed evidence: ${Boolean(cancellationEvidence?.termSentAt)} / ${Boolean(cancellationEvidence?.killSentAt)} / ${Boolean(cancellationEvidence?.confirmedExitAt)}`,
      `- Unrelated matching-looking process alive after cancellation: ${unrelatedAliveAfterCancel}`,
      "",
      "No lease token, prompt, command content, or credential was written to this proof artifact.",
      "",
    ].join("\n"));
  } finally {
    worker?.kill("SIGKILL");
    restartedWorker?.kill("SIGTERM");
    if (restartedWorker?.exitCode === null) await new Promise<void>((resolve) => restartedWorker?.once("exit", () => resolve()));
    connection?.close();
    database?.close();
    temporalProcess?.kill("SIGTERM");
    if (temporalProcess && temporalProcess.exitCode === null) await new Promise<void>((resolve) => temporalProcess?.once("exit", () => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
  }
}, 120_000);

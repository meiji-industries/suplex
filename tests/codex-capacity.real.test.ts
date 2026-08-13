import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";
import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { ArtifactStore } from "../src/artifacts.js";
import { CapacityManager } from "../src/capacity.js";
import { createTestConfig } from "../src/config.js";
import { DeveloperService } from "../src/codex-developer.js";
import { ForgeDatabase } from "../src/database.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { createActivities } from "../src/temporal/activities.js";
import { ensureTemporalFoundation, executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";

const execFileAsync = promisify(execFile);
const runReal = process.env.FORGE_RUN_REAL_CODEX_CAPACITY === "1";
const model = process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-luna";

function hashRef(value: string | null | undefined): string | null {
  return value == null ? null : createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for the real capacity proof");
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a Temporal test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test.skipIf(!runReal)("real Codex capacity admits two independent turns and advances a queued third", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-real-capacity-"));
  const repositoryPath = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "capacity proof\n");
  await execFileAsync("git", ["init", "-q"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "forge-capacity@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Forge Capacity"], { cwd: repositoryPath });
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-q", "-m", "capacity fixture"], { cwd: repositoryPath });
  const targetSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
  const config = createTestConfig(root, { repositoryRoot: root, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime"), externalTurnCapacity: 2, externalTurnWaitLimitMs: 600_000 });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactRoot);
  const now = new Date().toISOString();
  const plan = await artifacts.put("company", "lead-plan", { filename: "approved.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Independent capacity proof", reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "Create the assigned proof marker, run `sleep 8`, then commit the change.", verification: "The proof marker is committed and the worktree is clean." }], compatibilityAnalysis: "The fixture is isolated.", operationalAnalysis: "No operational mutation is authorized.", verificationStrategy: "Inspect the exact commit.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
  const leadEvidence = await artifacts.put("company", "agent-evidence", { filename: "lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"fixture\"}\n") });
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Capacity Admin', 'capacity-admin', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Capacity Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile', 'Capacity profile', 'codex', ?, 'medium', 'standard', 2, ?, ?)").run(model, now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project', 'company', 'Capacity project', ?, ?, 'capacity/proof', 'main', 'main', 'pnpm install', 'pnpm test', '[]', '[\"profile\"]', '{\"developer\":\"profile\",\"lead\":\"profile\"}', 'active', 'revision', ?, ?)").run(repositoryPath, worktreeRoot, now, now);
    db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('revision', 'project', 1, 'capacity-revision', ?, ?, ?, 'admin', ?)").run(JSON.stringify({ repository: "capacity/proof", repositoryPath, worktreeRoot, baseBranch: "main", targetBranch: "main", baseSha: targetSha, targetSha }), targetSha, targetSha, now);
    for (const artifact of [plan, leadEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    for (const taskId of ["task-a", "task-b", "task-c", "task-d", "task-e", "task-f"]) {
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, 'company', 'project', ?, ?, '[]', '{\"developer\":\"profile\",\"lead\":\"profile\"}', 0, ?, 'revision', ?, ?, ?)").run(taskId, `Capacity ${taskId}`, plan.id, `workflow-${taskId}`, `key-${taskId}`, now, now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES (?, ?, 'company', ?, 'lead', 'completed', 1, ?, ?, ?, ?)").run(`lead-${taskId}`, taskId, `workflow-${taskId}`, `lead-session-${taskId}`, now, now, leadEvidence.id);
      db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES (?, ?, 'company', ?, ?, 1, 'plan', ?, ?, ?, 'capacity proof plan', ?)").run(`output-${taskId}`, taskId, `workflow-${taskId}`, `lead-${taskId}`, plan.id, leadEvidence.id, `lead-session-${taskId}`, now);
    }
  });
  try {
    const capacity = new CapacityManager(database, config);
    const developer = new DeveloperService(database, config);
    const requestBase = Date.now();
    const requests = ["task-a", "task-b", "task-c"].map((taskId, index) => capacity.request({ logicalTurnKey: `workflow-${taskId}:1:developer_execution`, companyId: "company", taskId, workflowId: `workflow-${taskId}`, projectRevisionId: "revision", workflowRevision: 1, operation: "developer_execution", role: "developer", profileId: "profile", requestedAt: new Date(requestBase + index).toISOString() }));
    expect(capacity.tryAcquire(requests[0]!.id, 1).status).toBe("active");
    expect(capacity.tryAcquire(requests[1]!.id, 1).status).toBe("active");
    expect(capacity.tryAcquire(requests[2]!.id, 1).status).toBe("queued");
    const run = (taskId: string, requestId: string) => developer.run({ taskId, companyId: "company", workflowId: `workflow-${taskId}`, projectId: "project", projectRevisionId: "revision", planRevision: 1, roleProfiles: { lead: "profile", developer: "profile" }, leadSessionRef: `lead-session-${taskId}`, leadOutputArtifactId: plan.id, capacityRequestId: requestId });
    const firstTwo = [run("task-a", requests[0]!.id), run("task-b", requests[1]!.id)];
    await waitFor(() => Number((database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_executions WHERE status = 'running' AND process_pid IS NOT NULL").get()) as { count: number }).count) === 2, 120_000);
    const overlapStartedAt = new Date().toISOString();
    const activeRows = database.authQuery((db) => db.prepare("SELECT id, capacity_request_id, session_ref, worktree_path, process_pid, process_group_id, process_start_identity FROM forge_developer_executions WHERE status = 'running'").all() as Array<{ id: string; capacity_request_id: string; session_ref: string | null; worktree_path: string; process_pid: number; process_group_id: number; process_start_identity: string }>);
    expect(activeRows).toHaveLength(2);
    expect(new Set(activeRows.map((row) => row.capacity_request_id)).size).toBe(2);
    for (const row of activeRows) {
      const process = await execFileAsync("ps", ["-p", String(row.process_pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart="], { maxBuffer: 8 * 1024 });
      expect(process.stdout.trim().split(/\s+/).slice(0, 2)).toEqual([String(row.process_pid), String(row.process_group_id)]);
      expect(process.stdout).toContain(row.process_start_identity.split(":").slice(1).join(":"));
    }
    const third = (async () => {
      for (;;) {
        const admission = capacity.tryAcquire(requests[2]!.id, 1);
        if (admission.status === "active") return new Date().toISOString();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    const firstSettled = await Promise.allSettled(firstTwo);
    for (const [index, result] of firstSettled.entries()) {
      const request = requests[index]!;
      if (result.status === "fulfilled") capacity.finalize(request.id, result.value.developerExecutionId, "completed");
      else {
        const executionId = capacity.inspect(request.id).executionId;
        if (!executionId) throw new Error("A failed real turn did not retain its exact execution owner");
        capacity.finalize(request.id, executionId, "process_failed");
      }
    }
    const thirdAcquiredAt = await third;
    capacity.finalize(requests[2]!.id, requests[2]!.id, "failed_before_start");

    const secondBase = Date.now();
    const secondRequests = ["task-d", "task-e", "task-f"].map((taskId, index) => capacity.request({ logicalTurnKey: `workflow-${taskId}:1:developer_execution`, companyId: "company", taskId, workflowId: `workflow-${taskId}`, projectRevisionId: "revision", workflowRevision: 1, operation: "developer_execution", role: "developer", profileId: "profile", requestedAt: new Date(secondBase + index).toISOString() }));
    expect(capacity.tryAcquire(secondRequests[0]!.id, 1).status).toBe("active");
    expect(capacity.tryAcquire(secondRequests[1]!.id, 1).status).toBe("active");
    expect(capacity.tryAcquire(secondRequests[2]!.id, 1).status).toBe("queued");
    const secondRun = (taskId: string, requestId: string) => developer.run({ taskId, companyId: "company", workflowId: `workflow-${taskId}`, projectId: "project", projectRevisionId: "revision", planRevision: 1, roleProfiles: { lead: "profile", developer: "profile" }, leadSessionRef: `lead-session-${taskId}`, leadOutputArtifactId: plan.id, capacityRequestId: requestId });
    const secondFirstTwo = [secondRun("task-d", secondRequests[0]!.id), secondRun("task-e", secondRequests[1]!.id)];
    const secondSettledPromise = Promise.allSettled(secondFirstTwo);
    await waitFor(() => Number((database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_executions WHERE status = 'running' AND process_pid IS NOT NULL AND task_id IN ('task-d', 'task-e')").get()) as { count: number }).count) === 2, 120_000);
    const cancellationRow = database.authQuery((db) => db.prepare("SELECT id, capacity_request_id FROM forge_developer_executions WHERE status = 'running' AND task_id IN ('task-d', 'task-e') ORDER BY id LIMIT 1").get() as { id: string; capacity_request_id: string } | undefined);
    expect(cancellationRow).toBeDefined();
    if (!cancellationRow) throw new Error("No verified active execution was available for cancellation proof");
    const cancellation = await (await import("../src/developer-recovery.js")).cancelDeveloperExecution(database, cancellationRow.id);
    expect(cancellation.status).toBe("cancelled");
    capacity.finalize(cancellationRow.capacity_request_id, cancellationRow.id, "cancelled");
    const secondThird = (async () => {
      for (;;) {
        const admission = capacity.tryAcquire(secondRequests[2]!.id, 1);
        if (admission.status === "active") return new Date().toISOString();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    const secondThirdAcquiredAt = await secondThird;
    const secondSettled = await secondSettledPromise;
    expect(secondSettled.some((result) => result.status === "rejected")).toBe(true);
    for (const [index, result] of secondSettled.entries()) {
      const request = secondRequests[index]!;
      if (result.status === "fulfilled") capacity.finalize(request.id, result.value.developerExecutionId, "completed");
      else if (capacity.inspect(request.id).status === "active") {
        const executionId = capacity.inspect(request.id).executionId;
        if (!executionId) throw new Error("A failed real turn did not retain its exact execution owner");
        capacity.finalize(request.id, executionId, "process_failed");
      }
    }
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_executions WHERE task_id = 'task-f'").get())).toEqual({ count: 0 });
    capacity.finalize(secondRequests[2]!.id, secondRequests[2]!.id, "failed_before_start");

    const ledger = database.authQuery((db) => db.prepare("SELECT c.task_id, c.id AS request_id, c.requested_at, c.acquired_at, c.released_at, c.status, c.terminal_reason, d.id AS execution_id, d.session_ref, d.worktree_path FROM forge_capacity_requests c LEFT JOIN forge_developer_executions d ON d.id = c.execution_id ORDER BY c.requested_at, c.id").all() as Array<{ task_id: string; request_id: string; requested_at: string; acquired_at: string; released_at: string; status: string; terminal_reason: string; execution_id: string; session_ref: string; worktree_path: string }>);
    const references = ledger.map((row) => ({ task: hashRef(row.task_id), request: hashRef(row.request_id), execution: hashRef(row.execution_id), session: hashRef(row.session_ref), worktree: hashRef(row.worktree_path), requestedAt: row.requested_at, acquiredAt: row.acquired_at, releasedAt: row.released_at, status: row.status, terminalReason: row.terminal_reason }));
    const firstRelease = ledger.filter((row) => [requests[0]!.id, requests[1]!.id].includes(row.request_id)).map((row) => row.released_at).sort()[0]!;
    const cancelledRelease = ledger.find((row) => row.request_id === cancellationRow.capacity_request_id)?.released_at;
    const receipt = { testTimestamp: new Date().toISOString(), forgeCommit: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim(), workingTreeDirty: Boolean((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: process.cwd() })).stdout.trim()), profileId: hashRef("profile"), lane: hashRef("codex:profile"), effectiveCapacity: 2, references, completionProof: { overlapStartedAt, firstReleasedAt: firstRelease, queuedAcquiredAt: thirdAcquiredAt, queuedAcquiredAfterRelease: Date.parse(thirdAcquiredAt) >= Date.parse(firstRelease), statuses: requests.map((request) => capacity.inspect(request.id).status) }, cancellationProof: { cancelledExecution: hashRef(cancellationRow.id), cancelledRequest: hashRef(cancellationRow.capacity_request_id), cancelledReleasedAt: cancelledRelease, queuedAcquiredAt: secondThirdAcquiredAt, acquiredAfterTerminalCancellation: Boolean(cancelledRelease && Date.parse(secondThirdAcquiredAt) >= Date.parse(cancelledRelease)), statuses: secondRequests.map((request) => capacity.inspect(request.id).status) }, verification: { command: "FORGE_RUN_REAL_CODEX_CAPACITY=1 pnpm exec vitest run tests/codex-capacity.real.test.ts", twoRealProcessesObserved: true, independentExecutions: true, exactProcessIdentityVerified: true } };
    await mkdir(join(process.cwd(), ".scratch/forge-mvp/evidence"), { recursive: true });
    await writeFile(join(process.cwd(), ".scratch/forge-mvp/evidence/ticket-16-capacity-concurrency.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);

test.skipIf(!runReal)("real Temporal Workflow/Activity path runs two authenticated turns and advances a queued third", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-real-workflow-capacity-"));
  const repositoryPath = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "workflow capacity proof\n");
  await execFileAsync("git", ["init", "-q"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "forge-capacity@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Forge Capacity"], { cwd: repositoryPath });
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-q", "-m", "workflow capacity fixture"], { cwd: repositoryPath });
  const targetSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
  const port = await availablePort();
  let config = createTestConfig(root, { repositoryRoot: root, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime"), externalTurnCapacity: 2, taskQueue: `forge-capacity-${process.pid}` });
  let temporalProcess: ChildProcess | undefined;
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let workerConnection: NativeConnection | undefined;
  let temporalConnection: Connection | undefined;
  let database: ForgeDatabase | undefined;
  try {
    temporalProcess = spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(port), "--db-filename", join(root, "temporal.db"), "--namespace", config.temporalNamespace, "--search-attribute", "CompanyId=Keyword", "--search-attribute", "ProjectId=Keyword", "--search-attribute", "IssueId=Keyword"], { stdio: "ignore" });
    config = createTestConfig(root, { repositoryRoot: root, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime"), externalTurnCapacity: 2, taskQueue: config.taskQueue, temporalAddress: `127.0.0.1:${port}` });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { temporalConnection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    expect(temporalConnection).toBeDefined();
    if (!temporalConnection) throw new Error("Temporal connection was not established");
    await ensureTemporalFoundation(temporalConnection, config);
    database = new ForgeDatabase(config.databasePath);
    const artifacts = new ArtifactStore(config.artifactRoot);
    const now = new Date().toISOString();
    const plan = await artifacts.put("workflow-company", "lead-plan", { filename: "approved.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Workflow capacity proof", reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "Create a proof marker named for the task title, run `sleep 8`, and commit the marker.", verification: "The marker is committed and the worktree is clean." }], compatibilityAnalysis: "The fixture is isolated.", operationalAnalysis: "No external mutation is authorized.", verificationStrategy: "Inspect the exact commit and clean worktree.", unresolvedTechnicalQuestions: [], materialCategories: [] })) });
    const leadEvidence = await artifacts.put("workflow-company", "agent-evidence", { filename: "lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"fixture\"}\n") });
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('workflow-admin', 'Workflow Admin', 'workflow-admin', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('workflow-company', 'Workflow Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('workflow-profile', 'Workflow profile', 'codex', ?, 'medium', 'standard', 2, ?, ?)").run(model, now, now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('workflow-project', 'workflow-company', 'Workflow project', ?, ?, 'capacity/workflow', 'main', 'main', 'true', 'true', '[]', '[\"workflow-profile\"]', '{\"lead\":\"workflow-profile\",\"developer\":\"workflow-profile\"}', 'active', 'workflow-revision', ?, ?)").run(repositoryPath, worktreeRoot, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('workflow-revision', 'workflow-project', 1, 'workflow-capacity', ?, ?, ?, 'workflow-admin', ?)").run(JSON.stringify({ repository: "capacity/workflow", repositoryPath, worktreeRoot, baseBranch: "main", targetBranch: "main", baseSha: targetSha, targetSha }), targetSha, targetSha, now);
      for (const artifact of [plan, leadEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      for (const taskId of ["workflow-a", "workflow-b", "workflow-c"]) {
        const workflowId = `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-${taskId}`;
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, 'workflow-company', 'workflow-project', ?, ?, '[]', '{\"lead\":\"workflow-profile\",\"developer\":\"workflow-profile\"}', 0, ?, 'workflow-revision', ?, ?, ?)").run(taskId, taskId, plan.id, workflowId, `${taskId}-key`, now, now);
        db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES (?, ?, 'workflow-company', ?, 'lead', 'completed', 1, ?, ?, ?, ?)").run(`lead-${taskId}`, taskId, workflowId, `lead-session-${taskId}`, now, now, leadEvidence.id);
        db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES (?, ?, 'workflow-company', ?, ?, 1, 'plan', ?, ?, ?, 'workflow capacity proof', ?)").run(`output-${taskId}`, taskId, workflowId, `lead-${taskId}`, plan.id, leadEvidence.id, `lead-session-${taskId}`, now);
      }
    });
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({ connection: workerConnection, namespace: config.temporalNamespace, taskQueue: config.taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: createActivities(database, config) });
    workerRun = worker.run();
    const continuationState = (workflowId: string, issueId: string) => ({ phase: "ready_for_development" as const, revision: 0, owner: "lead" as const, allowedCommands: ["start_development", "cancel_issue"] as ("start_development" | "cancel_issue")[], pendingAction: "Start development", lastEventId: `${workflowId}:0`, continuationCount: 0, lastSummaryHash: null, planRevision: 1, planMaterial: true, leadSessionRef: `lead-session-${issueId}`, leadOutputArtifactId: plan.id });
    const workflows = await Promise.all(["workflow-a", "workflow-b", "workflow-c"].map((issueId) => startIssueWorkflow(config, { companyId: "workflow-company", projectId: "workflow-project", issueId, projectRevisionId: "workflow-revision", briefArtifactId: plan.id, briefSha256: plan.sha256, imageArtifactIds: [], roleProfiles: { lead: "workflow-profile", developer: "workflow-profile" }, supplementalReview: false, continuationState: continuationState(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-${issueId}`, issueId) })));
    const startedAt = new Date().toISOString();
    const development = workflows.map((workflow) => executeIssueCommand(config, workflow.workflowId, "start_development", { expectedRevision: 1, actorUserId: "workflow-admin" }));
    const settledDevelopment = Promise.allSettled(development);
    let states = await Promise.all(workflows.map((workflow) => queryIssueWorkflow(config, workflow.workflowId)));
    for (let attempt = 0; attempt < 120 && !(states.filter((state) => state.capacity?.status === "active").length === 2 && states.some((state) => state.capacity?.status === "queued")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      states = await Promise.all(workflows.map((workflow) => queryIssueWorkflow(config, workflow.workflowId)));
    }
    expect(states.filter((state) => state.capacity?.status === "active")).toHaveLength(2);
    expect(states.filter((state) => state.capacity?.status === "queued")).toHaveLength(1);
    await waitFor(() => Number(database!.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_developer_executions WHERE status = 'running' AND process_pid IS NOT NULL AND session_ref IS NOT NULL").get() as { count: number }).count)) === 2, 120_000);
    const activeRows = database.authQuery((db) => db.prepare("SELECT capacity_request_id, session_ref, worktree_path, process_pid FROM forge_developer_executions WHERE status = 'running' AND process_pid IS NOT NULL ORDER BY task_id").all() as Array<{ capacity_request_id: string; session_ref: string; worktree_path: string; process_pid: number }>);
    expect(activeRows).toHaveLength(2);
    expect(new Set(activeRows.map((row) => row.capacity_request_id))).toHaveLength(2);
    expect(new Set(activeRows.map((row) => row.session_ref))).toHaveLength(2);
    expect(new Set(activeRows.map((row) => row.worktree_path))).toHaveLength(2);
    const settled = await settledDevelopment;
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(0);
    const finalStates = await Promise.all(workflows.map((workflow) => queryIssueWorkflow(config, workflow.workflowId)));
    expect(finalStates.filter((state) => state.phase === "delivery_ready")).toHaveLength(3);
    await mkdir(join(process.cwd(), ".scratch/forge-mvp/evidence"), { recursive: true });
    const ledger = database.authQuery((db) => db.prepare("SELECT c.task_id, c.id AS request_id, c.requested_at, c.acquired_at, c.released_at, c.status, d.id AS execution_id, d.session_ref, d.worktree_path FROM forge_capacity_requests c LEFT JOIN forge_developer_executions d ON d.id = c.execution_id WHERE c.task_id IN ('workflow-a', 'workflow-b', 'workflow-c') ORDER BY c.requested_at, c.id").all() as Array<{ task_id: string; request_id: string; requested_at: string; acquired_at: string; released_at: string; status: string; execution_id: string; session_ref: string; worktree_path: string }>);
    await writeFile(join(process.cwd(), ".scratch/forge-mvp/evidence/ticket-16-capacity-workflow.json"), `${JSON.stringify({ testTimestamp: new Date().toISOString(), lane: hashRef("codex:workflow-profile"), effectiveCapacity: 2, requestedAt: startedAt, acquired: { activeTurns: 2, queuedTurnAdvancedAfterRelease: true }, terminal: { completedTurns: 3 }, references: ledger.map((row) => ({ task: hashRef(row.task_id), request: hashRef(row.request_id), execution: hashRef(row.execution_id), session: hashRef(row.session_ref), worktree: hashRef(row.worktree_path), requestedAt: row.requested_at, acquiredAt: row.acquired_at, releasedAt: row.released_at, status: row.status })), verification: { temporalWorkflow: true, activityPath: true, realAuthenticatedCodex: true, concurrentUpdates: 3, distinctProcessOwnersObserved: true } }, null, 2)}\n`);
  } finally {
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await workerConnection?.close();
    database?.close();
    temporalConnection?.close();
    temporalProcess?.kill("SIGTERM");
    if (temporalProcess && temporalProcess.exitCode === null) await new Promise((resolve) => temporalProcess!.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);

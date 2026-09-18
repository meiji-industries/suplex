import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, test } from "vitest";
import { Ajv, type AnySchema } from "ajv";
import SwaggerParser from "@apidevtools/swagger-parser";

import { AuthService } from "../src/identity/auth.js";
import { mapGithubPullRequestObservation, type GithubPullRequestObservation } from "../src/integrations/github/delivery.js";
import { GithubReleaseFailure } from "../src/integrations/github/failure.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import type { ForgeConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import type { GithubAdapter } from "../src/integrations/github/client.js";
import { HermesAgentService } from "../src/identity/hermes-agents.js";
import { SESSION_COOKIE_NAME } from "../src/identity/auth-identifiers.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects/projects.js";
import { TaskService } from "../src/tasks/tasks.js";
import { AgentDeliveryService } from "../src/delivery/agent-delivery.js";
import { DeliveryOperations } from "../src/delivery/operations.js";
import type { WorktreeReference } from "../src/tasks/control.js";
import type { ProjectAgentTaskPolicy } from "../src/http/contracts/projects.js";
import { TaskInputSchema } from "../src/tasks/contracts.js";
import { taskRequestHash } from "../src/tasks/repository.js";
import { normalizeWorkflowInput } from "../src/coordination/workflows.js";
import { MAX_TASK_IMAGES, MAX_TASK_IMAGE_BASE64_LENGTH, MAX_TASK_IMAGE_BYTES } from "../src/tasks/limits/attachment-limits.js";
import { decodeTaskImage } from "../src/tasks/images.js";

const execFileAsync = promisify(execFile);
let inspectionGate: Promise<void> | undefined;
let inspectionStarted: (() => void) | undefined;
let inspectionError: Error | undefined;

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

const localRepository: LocalRepositoryAdapter = {
  async inspect(input) {
    if (inspectionError) throw inspectionError;
    if (input.repositoryPath.endsWith("project1") && inspectionGate) {
      inspectionStarted?.();
      await inspectionGate;
    }
    return {
      canonicalPath: input.repositoryPath,
      remoteRepository: input.repositoryPath.includes("project2") ? "meiji/other-test" : input.repositoryPath.includes("project3") ? "meiji/hermes-cross-company-test" : input.repositoryPath.includes("project4") ? "meiji/human-after-archive" : "meiji/hermes-test",
      clean: true,
      baseSha: "a".repeat(40),
      targetSha: "b".repeat(40),
    };
  },
};
const github: GithubAdapter = {
  async checkAuthentication() {},
  async getRepository(input) {
    return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` };
  },
};

let root: string;
let config: ForgeConfig;
let database: ForgeDatabase;
let auth: AuthService;
let projects: ProjectService;
let tasks: TaskService;
let hermes: HermesAgentService;
let app: ReturnType<typeof createApp>;
let adminId: string;
let companyId: string;
let projectId: string;
let otherProjectId: string;
let crossCompanyProjectId: string;
let crossCompanyId: string;
let agentCredential: string;
let agentId: string;
let recoveryWakes: number;
let observations: Map<string, GithubPullRequestObservation | Error>;

const ABSENT: GithubPullRequestObservation = { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, mergeStateStatus: null, checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, autoMergeEnabled: null, reviewDecision: null };

/** A realistic `gh pr view --json` payload, mapped through the production mapper so fixtures cannot drift from the provider shape. */
function ghPullRequest(input: { number: number; state: "OPEN" | "CLOSED" | "MERGED"; headSha: string; mergeable?: string; mergeStateStatus?: string; reviewDecision?: string | null; checks?: Array<{ name: string; status: string; conclusion: string | null }> }): GithubPullRequestObservation {
  return mapGithubPullRequestObservation({
    number: input.number,
    url: `https://github.com/meiji/hermes-test/pull/${input.number}`,
    state: input.state,
    isDraft: false,
    headRefOid: input.headSha,
    baseRefOid: "c".repeat(40),
    mergeable: input.mergeable ?? "MERGEABLE",
    mergeStateStatus: input.mergeStateStatus ?? "CLEAN",
    autoMergeRequest: null,
    reviewDecision: input.reviewDecision === undefined ? "APPROVED" : input.reviewDecision,
    author: { login: "forge-bot", avatarUrl: "https://avatars.githubusercontent.com/forge-bot" },
    changedFiles: 3,
    additions: 40,
    deletions: 2,
    statusCheckRollup: (input.checks ?? [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }]).map(check => ({ ...check, detailsUrl: "https://github.com/meiji/hermes-test/actions/runs/1" })),
  });
}

async function createHermesTask(title: string, idempotencyKey: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title, idempotencyKey } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

/** Drives a task to delivered with a recorded pull request, and registers what GitHub answers for its branch. */
async function deliverTask(title: string, idempotencyKey: string, pullRequestNumber: number, answer: GithubPullRequestObservation | Error, recordedHeadSha = "d".repeat(40)): Promise<string> {
  const taskId = await createHermesTask(title, idempotencyKey);
  tasks.startTask(adminId, taskId);
  tasks.repository.controls.setPullRequest(taskId, { repository: "meiji/hermes-test", number: pullRequestNumber, url: `https://github.com/meiji/hermes-test/pull/${pullRequestNumber}`, headSha: recordedHeadSha, state: "open", mergedAt: null });
  tasks.repository.controls.markDelivered(taskId);
  observations.set(tasks.getTask(adminId, taskId).configuration.branch, answer);
  return taskId;
}

/** Repoints a task at an upstream task's head branch, the way a source selection would. */
function branchFrom(taskId: string, upstreamTaskId: string): void {
  const configuration = { ...tasks.getTask(adminId, taskId).configuration, source: { kind: "branch", branch: tasks.getTask(adminId, upstreamTaskId).configuration.branch } };
  database.authTransaction(db => db.prepare("UPDATE forge_tasks SET configuration_json = ? WHERE id = ?").run(JSON.stringify(configuration), taskId));
}

const listTasks = async (query = "") => app.inject({ method: "GET", url: `/api/hermes/tasks${query}`, headers: { Authorization: `Bearer ${agentCredential}` } });
const readTask = async (taskId: string) => app.inject({ method: "GET", url: `/api/hermes/tasks/${taskId}`, headers: { Authorization: `Bearer ${agentCredential}` } });

async function updateProjectPolicy(agentTaskPolicy: ProjectAgentTaskPolicy): Promise<void> {
  const current = projects.getProject(adminId, projectId);
  await projects.updateProject(adminId, projectId, { name: current.name, repositoryPath: current.repositoryPath, worktreeRoot: current.worktreeRoot, repository: current.repository!, baseBranch: current.baseBranch, setupCommand: current.setupCommand, verificationCommand: current.verificationCommand, rootProfileId: current.rootProfileId, workerProfileId: current.workerProfileId, agentTaskPolicy });
}

function validateDocumentSchema(value: unknown, schema: unknown): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema as AnySchema);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function runtimeCounts(): Record<string, number> {
  return Object.fromEntries([
    "forge_task_controls", "forge_tasks", "forge_artifacts", "forge_task_turns", "forge_task_sessions",
  ].map((table) => [table, database.authQuery((db) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]).concat([["task_created_audits", database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action = 'task_created'").get() as { count: number }).count)], ["recovery_wakes", recoveryWakes]]));
}

type CreateOperationDocument = {
  post: {
    requestBody: {
      content: {
        "application/json": {
          schema: { required: string[]; properties: { description: { default: string } } };
        };
      };
    };
    responses: {
      "201": {
        content: {
          "application/json": {
            schema: { properties: { status: { enum: string[] } } };
          };
        };
      };
    };
  };
};

beforeEach(async () => {
  inspectionGate = undefined;
  inspectionStarted = undefined;
  inspectionError = undefined;
  root = await mkdtemp(join(tmpdir(), "forge-hermes-tasks-api-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "project1");
  const otherRepoPath = join(repositoryRoot, "project2");
  const crossRepoPath = join(repositoryRoot, "project3");
  const project1Worktrees = join(worktreeRoot, "project1");
  const otherWorktrees = join(worktreeRoot, "project2");
  const crossWorktrees = join(worktreeRoot, "project3");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(otherRepoPath, { recursive: true });
  await mkdir(crossRepoPath, { recursive: true });
  await mkdir(project1Worktrees, { recursive: true });
  await mkdir(otherWorktrees, { recursive: true });
  await mkdir(crossWorktrees, { recursive: true });

  await git(["init", "-b", "main"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await git(["config", "commit.gpgsign", "false"], repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "base\n");
  await git(["add", "README.md"], repositoryPath);
  await git(["commit", "-m", "base"], repositoryPath);

  await git(["init", "-b", "main"], otherRepoPath);
  await git(["config", "user.name", "Forge Test"], otherRepoPath);
  await git(["config", "user.email", "forge-test@example.invalid"], otherRepoPath);
  await git(["config", "commit.gpgsign", "false"], otherRepoPath);
  await writeFile(join(otherRepoPath, "README.md"), "base\n");
  await git(["add", "README.md"], otherRepoPath);
  await git(["commit", "-m", "base"], otherRepoPath);

  await git(["init", "-b", "main"], crossRepoPath);
  await git(["config", "user.name", "Forge Test"], crossRepoPath);
  await git(["config", "user.email", "forge-test@example.invalid"], crossRepoPath);
  await git(["config", "commit.gpgsign", "false"], crossRepoPath);
  await writeFile(join(crossRepoPath, "README.md"), "base\n");
  await git(["add", "README.md"], crossRepoPath);
  await git(["commit", "-m", "base"], crossRepoPath);

  database = new ForgeDatabase(join(root, "forge.sqlite"));
  config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111", developmentAutoLogin: true });
  auth = new AuthService(database, config);
  adminId = auth.ensureDevelopmentUser().id;

  projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany(adminId, "Hermes Machine Company");
  companyId = company.id;
  auth.setCompanyIssueCode(adminId, companyId, "hmc");

  const project = await projects.createProject(adminId, companyId, {
    name: "Hermes Project",
    repositoryPath,
    worktreeRoot: project1Worktrees,
    repository: "meiji/hermes-test",
    baseBranch: "main",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    rootProfileId: "profile_native_root",
    workerProfileId: "profile_native_worker",
  });
  projectId = project.id;

  const otherProj = await projects.createProject(adminId, companyId, {
    name: "Other Project",
    repositoryPath: otherRepoPath,
    worktreeRoot: otherWorktrees,
    repository: "meiji/other-test",
    baseBranch: "main",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    rootProfileId: "profile_native_root",
    workerProfileId: "profile_native_worker",
  });
  otherProjectId = otherProj.id;

  const crossCompany = auth.createCompany(adminId, "Hermes Other Company");
  crossCompanyId = crossCompany.id;
  const crossProject = await projects.createProject(adminId, crossCompany.id, {
    name: "Cross Company Project",
    repositoryPath: crossRepoPath,
    worktreeRoot: crossWorktrees,
    repository: "meiji/hermes-cross-company-test",
    baseBranch: "main",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    rootProfileId: "profile_native_root",
    workerProfileId: "profile_native_worker",
  });
  crossCompanyProjectId = crossProject.id;

  recoveryWakes = 0;
  observations = new Map();
  tasks = new TaskService(database, auth, projects, config);
  hermes = new HermesAgentService(database, auth);

  // Create and pair Hermes agent with access only to projectId
  const issued = hermes.create(adminId, { name: "Hermes Bot", companyId, projectIds: [projectId] });
  agentId = issued.agent.id;
  const paired = hermes.exchange({ pairingCode: issued.pairingCode, profileId: "profile-bot" });
  agentCredential = paired.credential;

  app = createApp({
    config,
    auth,
    projects,
    tasks,
    hermes,
    hermesGithub: {
      async observePullRequest(input) {
        const answer = observations.get(input.branch) ?? ABSENT;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    host: { async recover() { recoveryWakes++; } },
    health: {
      database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
      artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
      ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
    },
  });
});

afterEach(async () => {
  await app?.close();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("authenticated runtime contract uses the live task schemas and states its authority boundary", async () => {
  const unauthenticated = await app.inject({ method: "GET", url: "/api/hermes/openapi.json" });
  expect(unauthenticated.statusCode).toBe(401);
  expect(unauthenticated.json()).toEqual({ error: "Authentication failed", code: "credential_invalid" });

  const documentResponse = await app.inject({
    method: "GET",
    url: "/api/hermes/openapi.json",
    headers: { Authorization: `Bearer ${agentCredential}` },
  });
  expect(documentResponse.statusCode).toBe(200);
  expect(documentResponse.headers["cache-control"]).toBe("private, no-store");
  const document = documentResponse.json() as { openapi: string; info: { version: string }; paths: Record<string, unknown>; components: Record<string, unknown> };
  expect(document.openapi).toBe("3.0.3");
  expect(document.info.version).toBe("v1");
  expect(Object.keys(document.paths).sort()).toEqual(["/api/hermes/capabilities", "/api/hermes/openapi.json", "/api/hermes/templates", "/api/hermes/workflows", "/api/hermes/tasks", "/api/hermes/tasks/{taskId}", "/api/hermes/tasks/{taskId}/commands", "/api/hermes/tasks/{taskId}/dependencies"].sort());
  const dependenciesOperation = (document.paths["/api/hermes/tasks/{taskId}/dependencies"] as { put: { requestBody: { content: { "application/json": { schema: { required: string[]; additionalProperties: boolean } } } }; responses: Record<string, { content: { "application/json": { schema: { properties: Record<string, unknown> } } } }> } }).put;
  expect(dependenciesOperation.requestBody.content["application/json"].schema).toMatchObject({ required: ["dependsOn"], additionalProperties: false });
  expect(Object.keys(dependenciesOperation.responses["200"]!.content["application/json"].schema.properties)).toEqual(expect.arrayContaining(["dependsOn", "blockedBy"]));
  expect(JSON.stringify(document)).not.toMatch(/pairingCode|credentialCreatedAt|credential_hash|board session/i);
  const createOperation = (document.paths["/api/hermes/tasks"] as CreateOperationDocument).post;
  expect(createOperation.requestBody.content["application/json"].schema.required).toEqual(expect.arrayContaining(["projectId", "title", "idempotencyKey"]));
  expect(createOperation.requestBody.content["application/json"].schema.properties.description.default).toBe("");
  expect(createOperation.responses["201"].content["application/json"].schema.properties.status.enum).toContain("waiting_human");
  expect(Object.keys((createOperation.responses["201"].content["application/json"].schema as unknown as { properties: Record<string, unknown> }).properties)).toEqual(expect.arrayContaining(["dependsOn", "blockedBy"]));

  const capabilities = await app.inject({ method: "GET", url: "/api/hermes/capabilities", headers: { Authorization: `Bearer ${agentCredential}` } });
  expect(capabilities.statusCode).toBe(200);
  expect(capabilities.json()).toMatchObject({
    apiVersion: "v1",
    capabilities: { read: { task: true, workflows: true, templates: true }, create: { backlogTask: true, deliveryTargets: ["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"] }, taskControl: true, delivery: false, merge: false, humanDecisions: false },
    pagination: { supported: false, cursor: false },
  });
  expect(capabilities.json().unavailableCommands).toEqual(["answer_human_question", "deliver_task", "merge_pull_request"]);
  expect(capabilities.json().autonomousCommands).not.toContain("read_merge_train");

  const invalid = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: { Authorization: `Bearer ${agentCredential}` },
    payload: { projectId, title: "Missing idempotency key" },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ error: "Invalid request", code: "request_invalid" });

  const created = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: { Authorization: `Bearer ${agentCredential}` },
    payload: { projectId, title: "Contract response", idempotencyKey: "contract-schema-001" },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().status).toBe("backlog");
  expect(created.json().description).toBeUndefined();
});

test("board sessions and development login cannot substitute for paired bearer authority", async () => {
  const boardSession = auth.developmentSignIn();
  const boardOnly = await app.inject({
    method: "GET",
    url: "/api/hermes/capabilities",
    headers: { cookie: `${SESSION_COOKIE_NAME}=${boardSession.sessionToken}` },
  });
  expect(boardOnly.statusCode).toBe(401);
  expect(boardOnly.json()).toEqual({ error: "Authentication failed", code: "credential_invalid" });

  const before = database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_tasks").get() as { count: number }).count);
  const deniedCreate = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: { cookie: `${SESSION_COOKIE_NAME}=${boardSession.sessionToken}` },
    payload: { projectId, title: "Board session cannot create", idempotencyKey: "board-session-001" },
  });
  expect(deniedCreate.statusCode).toBe(401);
  expect(database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_tasks").get() as { count: number }).count)).toBe(before);
});

test("runtime error responses are serialized against the documented status schemas", async () => {
  const document = (await app.inject({ method: "GET", url: "/api/hermes/openapi.json", headers: { Authorization: `Bearer ${agentCredential}` } })).json() as { paths: Record<string, { post?: { responses: Record<string, { content: { "application/json": { schema: unknown } } }> }; get?: { responses: Record<string, { content: { "application/json": { schema: unknown } } }> } }> };
  await expect(SwaggerParser.validate(document as never)).resolves.toMatchObject({ openapi: "3.0.3" });
  const createSchemas = document.paths["/api/hermes/tasks"]!.post!.responses;
  const cases = await Promise.all([
    app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}`, "content-type": "application/json" }, payload: "{" }),
    app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}`, "content-type": "application/xml" }, payload: "<task />" }),
    app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}`, "content-type": "application/json" }, payload: "x".repeat(1_100_000) }),
  ]);
  for (const response of cases) {
    const schemas = createSchemas;
    const documented = schemas[String(response.statusCode)];
    expect(documented, `${response.statusCode}: ${response.body}`).toBeDefined();
    validateDocumentSchema(response.json(), documented!.content["application/json"].schema);
  }
  expect(cases.map(response => response.statusCode)).toEqual([400, 415, 413]);
  expect(cases.map(response => response.json().code)).toEqual(["request_invalid", "unsupported_media_type", "payload_too_large"]);

  const created = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Schema response", idempotencyKey: "schema-response-001" } });
  const capability = await app.inject({ method: "GET", url: "/api/hermes/capabilities", headers: { Authorization: `Bearer ${agentCredential}` } });
  validateDocumentSchema(created.json(), createSchemas["201"]!.content["application/json"].schema);
  validateDocumentSchema(capability.json(), document.paths["/api/hermes/capabilities"]!.get!.responses["200"]!.content["application/json"].schema);

  const taskSchema = createSchemas["201"]!.content["application/json"].schema;
  const validTask = created.json() as Record<string, unknown>;
  for (const invalid of [
    { ...validTask, id: 1 },
    { ...validTask, unexpected: true },
    { ...validTask, status: "not-a-state" },
    (() => { const withoutTitle = { ...validTask }; delete withoutTitle.title; return withoutTitle; })(),
  ]) {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(taskSchema as AnySchema);
    expect(validate(invalid)).toBe(false);
  }
  const capabilitySchema = document.paths["/api/hermes/capabilities"]!.get!.responses["200"]!.content["application/json"].schema;
  const invalidCapability = { ...capability.json(), unavailableCommands: ["start_task", 1] };
  expect(new Ajv({ allErrors: true, strict: false }).compile(capabilitySchema as AnySchema)(invalidCapability)).toBe(false);
  const conflictSchema = createSchemas["409"]!.content["application/json"].schema;
  expect(new Ajv({ allErrors: true, strict: false }).compile(conflictSchema as AnySchema)({ error: "Conflict", code: "credential_invalid" })).toBe(false);
});

test("router-level long and unmatched URLs stay outside the authenticated runtime envelope", async () => {
  const long = await app.inject({ method: "GET", url: `/api/hermes/tasks/${"a".repeat(101)}`, headers: { Authorization: `Bearer ${agentCredential}` } });
  const unmatched = await app.inject({ method: "GET", url: "/api/hermes/unknown" });
  expect(long.statusCode).toBe(414);
  expect(long.json().code).toBe("FST_ERR_MAX_PARAM_LENGTH");
  expect(unmatched.statusCode).toBe(404);
  expect(unmatched.json()).toEqual({ error: "Not found" });
});

test("all rejected credential states cannot discover or mutate runtime state", async () => {
  const pending = hermes.create(adminId, { name: "Unpaired Hermes", companyId, projectIds: [projectId] });
  const rotation = hermes.rotate(adminId, agentId);
  const replacement = hermes.exchange({ pairingCode: rotation.pairingCode, profileId: "profile-bot" }).credential;
  hermes.revoke(adminId, agentId);
  const credentials = [undefined, "not-a-credential", pending.pairingCode, agentCredential, replacement];
  const before = database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_tasks").get() as { count: number }).count);
  for (const credential of credentials) {
    const headers = credential ? { Authorization: `Bearer ${credential}` } : {};
    for (const request of [
      app.inject({ method: "GET", url: "/api/hermes/openapi.json", headers }),
      app.inject({ method: "GET", url: "/api/hermes/capabilities", headers }),
      app.inject({ method: "GET", url: `/api/hermes/workflows?projectId=${projectId}`, headers }),
      app.inject({ method: "GET", url: `/api/hermes/templates?projectId=${projectId}`, headers }),
      app.inject({ method: "GET", url: "/api/hermes/tasks/task_unknown", headers }),
      app.inject({ method: "POST", url: "/api/hermes/tasks", headers, payload: { projectId, title: "Denied", idempotencyKey: `denied-${credential ?? "missing"}` } }),
    ]) expect((await request).statusCode).toBe(401);
  }
  expect(database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_tasks").get() as { count: number }).count)).toBe(before);
});

test("current persisted grants are rechecked before asynchronous creation persists", async () => {
  let releaseInspection!: () => void;
  inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
  const reachedInspection = new Promise<void>((resolve) => { inspectionStarted = resolve; });
  const request = app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Grant changes during creation", idempotencyKey: "grant-race-001" } });
  await reachedInspection;
  hermes.replaceProjects(adminId, agentId, []);
  releaseInspection();
  const response = await request;
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "Not found", code: "not_found" });
  expect(runtimeCounts()).toEqual({ forge_task_controls: 0, forge_tasks: 0, forge_artifacts: 0, forge_task_turns: 0, forge_task_sessions: 0, task_created_audits: 0, recovery_wakes: 0 });
  expect(new HermesAgentService(database, auth).authenticate(agentCredential).projectIds).toEqual([]);
});

test("agent revocation during asynchronous creation prevents all task side effects", async () => {
  let releaseInspection!: () => void;
  inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
  const reachedInspection = new Promise<void>((resolve) => { inspectionStarted = resolve; });
  const request = app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Agent revocation during creation", idempotencyKey: "agent-race-001" } });
  await reachedInspection;
  hermes.revoke(adminId, agentId);
  releaseInspection();
  const response = await request;
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "Not found", code: "not_found" });
  expect(runtimeCounts()).toEqual({ forge_task_controls: 0, forge_tasks: 0, forge_artifacts: 0, forge_task_turns: 0, forge_task_sessions: 0, task_created_audits: 0, recovery_wakes: 0 });
});

test("persisted paired authority has the same HTTP outcome after app recreation", async () => {
  const before = await app.inject({ method: "GET", url: "/api/hermes/capabilities", headers: { Authorization: `Bearer ${agentCredential}` } });
  await app.close();
  hermes = new HermesAgentService(database, auth);
  const config = createTestConfig(root, { repositoryRoot: join(root, "repositories"), worktreeRoot: join(root, "worktrees"), reachableAddress: "http://127.0.0.1:4111", developmentAutoLogin: true });
  app = createApp({ config, auth, projects, tasks, hermes, health: {
    database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
    artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
    ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
  } });
  const after = await app.inject({ method: "GET", url: "/api/hermes/capabilities", headers: { Authorization: `Bearer ${agentCredential}` } });
  expect(after.statusCode).toBe(before.statusCode);
  expect(after.json()).toEqual(before.json());
});

test("project capture and internal failures use documented safe runtime errors", async () => {
  inspectionError = new Error(`repository unavailable at ${join(root, "private-repository")}`);
  const projectFailure = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Unavailable project", idempotencyKey: "project-failure-001" } });
  expect(projectFailure.statusCode).toBe(422);
  expect(projectFailure.json()).toMatchObject({ error: "Project configuration could not be captured", code: "task_unavailable" });
  expect(projectFailure.body).not.toContain(root);

  inspectionError = undefined;
  projects.captureTaskConfiguration = async () => { throw new Error(`internal path ${join(root, "secret")}`); };
  const internalFailure = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Internal failure", idempotencyKey: "internal-failure-001" } });
  expect(internalFailure.statusCode).toBe(500);
  expect(internalFailure.json()).toEqual({ error: "Internal server error", code: "internal_error" });
  expect(internalFailure.body).not.toContain(root);
});

test("creation ignores caller-supplied authority and reports idempotency conflicts", async () => {
  const ignored = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Forged authority", idempotencyKey: "forged-001", companyId: "other", agentId: "other", startImmediately: true } });
  expect(ignored.statusCode).toBe(201);
  expect(ignored.json()).toMatchObject({ projectId, status: "backlog" });
  const payload = { projectId, title: "Idempotency", idempotencyKey: "conflict-001" };
  expect((await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload })).statusCode).toBe(201);
  const conflict = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { ...payload, title: "Different request" } });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().code).toBe("idempotency_conflict");
});

test("POST /api/hermes/tasks creates task with native status, private no-store headers, and records creator attribution", async () => {
  const payload = {
    projectId,
    title: "Hermes task creation",
    description: "Brief content from machine agent",
    idempotencyKey: "hermes-task-001",
  };

  const response = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: {
      Authorization: `Bearer ${agentCredential}`,
    },
    payload,
  });

  expect(response.statusCode).toBe(201);
  expect(response.headers["cache-control"]).toBe("private, no-store");

  const body = response.json();
  const expectedKeys = ["id", "issueKey", "projectId", "project", "title", "status", "queue", "dependsOn", "blockedBy", "archived", "revision", "permittedCommands", "humanQuestion", "blocker", "workflowStage", "workflow", "templateId", "deliveryTarget", "runProjectTests", "visualEvidence", "delivery", "createdAt", "updatedAt", "implementation", "integration", "actionRequired"].sort();
  expect(Object.keys(body).sort()).toEqual(expectedKeys);
  expect(body).toMatchObject({
    dependsOn: [],
    blockedBy: [],
    issueKey: "HMC-1",
    projectId,
    project: { id: projectId, name: "Hermes Project" },
    title: "Hermes task creation",
    status: "backlog",
    humanQuestion: null,
  });
  expect(JSON.stringify(body)).not.toMatch(/Brief content|repositoryPath|worktree|credential|prompt/i);

  // Verify creator_agent_id persisted on task and intent
  const taskRow = database.authQuery((db) => db.prepare("SELECT creator_agent_id FROM forge_tasks WHERE id = ?").get(body.id) as { creator_agent_id: string | null });
  expect(taskRow.creator_agent_id).toBe(agentId);

  // Replay with identical payload and idempotency key returns 200 with unchanged projection
  const replay = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: {
      Authorization: `Bearer ${agentCredential}`,
    },
    payload,
  });
  expect(replay.statusCode).toBe(200);
  expect(replay.headers["cache-control"]).toBe("private, no-store");
  // The projection carries a live observation timestamp, so compare everything except when GitHub was read.
  const withoutObservedAt = (value: Record<string, any>) => ({ ...value, integration: { ...value.integration, observedAt: "" } });
  expect(withoutObservedAt(replay.json())).toEqual(withoutObservedAt(body));
  const count = (table: string, clause = ""): number => database.authQuery((db) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${clause}`).get() as { count: number }).count);
  expect(count("forge_tasks")).toBe(1);
  expect(count("forge_task_controls")).toBe(1);
  expect(count("forge_artifacts")).toBe(0);
  expect(count("forge_audit_events", "WHERE action = 'task_created'")).toBe(1);
  expect(recoveryWakes).toBe(0);
});

test("POST /api/hermes/tasks accepts a title without a description", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: { Authorization: `Bearer ${agentCredential}` },
    payload: { projectId, title: "Hermes title only", idempotencyKey: "hermes-title-only-001" },
  });
  expect(response.statusCode, response.body).toBe(201);
  const taskId = response.json().id as string;
  expect(database.authQuery(db => db.prepare("SELECT description FROM forge_tasks WHERE id = ?").get(taskId))).toEqual({ description: "" });
  expect(database.authQuery(db => db.prepare("SELECT objective FROM forge_task_controls WHERE task_id = ?").get(taskId))).toEqual({ objective: "Hermes title only" });
});

test("workflow and template discovery is project scoped and reports creation permission", async () => {
  const templateId = "template_hermes_discovery";
  database.authTransaction(db => {
    db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(templateId, projectId, "Discovery template", JSON.stringify({ name: "Discovery template", description: "A discovered template", workflow: "standard", advisorProfileIds: {} }), new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("template_hermes_disallowed", projectId, "Blocked template", JSON.stringify({ name: "Blocked template", description: "Not permitted", workflow: "standard", advisorProfileIds: {} }), new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE forge_workflows SET archived_at = ? WHERE id = 'workflow_native_refine_pull_request'").run(new Date().toISOString());
  });
  await updateProjectPolicy({ workflowIds: ["workflow_native_standard"], defaultWorkflowId: "workflow_native_standard", templateIds: [templateId], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });

  const headers = { Authorization: `Bearer ${agentCredential}` };
  const [workflows, templates] = await Promise.all([
    app.inject({ method: "GET", url: `/api/hermes/workflows?projectId=${projectId}`, headers }),
    app.inject({ method: "GET", url: `/api/hermes/templates?projectId=${projectId}`, headers }),
  ]);
  expect(workflows.statusCode).toBe(200);
  expect(workflows.json().workflows).toEqual(expect.arrayContaining([
    { id: "workflow_native_standard", name: "Standard", description: expect.any(String), permittedForAgentTaskCreation: true },
    { id: "workflow_native_direct_build", name: "Direct build", description: expect.any(String), permittedForAgentTaskCreation: false },
  ]));
  expect(workflows.json().workflows.map((workflow: { id: string }) => workflow.id)).not.toContain("workflow_native_refine_pull_request");
  expect(templates.statusCode).toBe(200);
  expect(templates.json()).toMatchObject({ templates: expect.arrayContaining([
    { id: templateId, name: "Discovery template", description: "A discovered template", permittedForAgentTaskCreation: true },
    { id: "template_hermes_disallowed", name: "Blocked template", description: "Not permitted", permittedForAgentTaskCreation: false },
  ]) });

  for (const url of ["/api/hermes/workflows", "/api/hermes/templates"]) expect((await app.inject({ method: "GET", url: `${url}?projectId=${projectId}` })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: `/api/hermes/workflows?projectId=${otherProjectId}`, headers })).statusCode).toBe(404);
});

test("POST /api/hermes/tasks resolves only project-authorized workflow, template, profiles, and attachments", async () => {
  const policy: ProjectAgentTaskPolicy = {
    workflowIds: ["workflow_native_standard", "workflow_native_direct_build"], defaultWorkflowId: "workflow_native_standard", templateIds: ["template_hermes_direct"],
    rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"],
    advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] },
    deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off",
  };
  database.authTransaction(db => {
    db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("template_hermes_direct", projectId, "Hermes direct", JSON.stringify({ name: "Hermes direct", description: "", workflow: "direct_build", advisorProfileIds: {} }), new Date().toISOString(), new Date().toISOString());
  });
  const current = projects.getProject(adminId, projectId);
  await projects.updateProject(adminId, projectId, { name: current.name, repositoryPath: current.repositoryPath, worktreeRoot: current.worktreeRoot, repository: current.repository!, baseBranch: current.baseBranch, setupCommand: current.setupCommand, verificationCommand: current.verificationCommand, rootProfileId: current.rootProfileId, workerProfileId: current.workerProfileId, agentTaskPolicy: policy });
  const other = projects.getProject(adminId, otherProjectId);
  await expect(projects.updateProject(adminId, otherProjectId, { name: other.name, repositoryPath: other.repositoryPath, worktreeRoot: other.worktreeRoot, repository: other.repository!, baseBranch: other.baseBranch, setupCommand: other.setupCommand, verificationCommand: other.verificationCommand, rootProfileId: other.rootProfileId, workerProfileId: other.workerProfileId, agentTaskPolicy: { ...policy, templateIds: ["template_hermes_direct"] } })).rejects.toMatchObject({ statusCode: 422 });
  const request = (payload: object) => app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload });
  const rich = await request({
    projectId, title: "Rich Hermes task", description: "# Markdown\n\nSupported content", idempotencyKey: "hermes-rich-001", workflowId: "workflow_native_direct_build",
    images: [{ filename: "proof.png", mimeType: "image/png", base64: "iVBORw0KGgo=" }], deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off",
  });
  expect(rich.statusCode, rich.body).toBe(201);
  expect(rich.json()).toMatchObject({ workflow: { id: "workflow_native_direct_build", engine: "direct_build", name: "Direct build" }, templateId: null, deliveryTarget: "pull_request_draft" });
  expect(database.authQuery(db => db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts").get())).toEqual({ count: 1 });

  // An omitted delivery configuration reports back the policy the project applied.
  const defaulted = await request({ projectId, title: "Policy default task", idempotencyKey: "hermes-policy-default-001" });
  expect(defaulted.statusCode, defaulted.body).toBe(201);
  expect(defaulted.json()).toMatchObject({ deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
  expect((await app.inject({ method: "GET", url: `/api/hermes/tasks/${defaulted.json().id}`, headers: { Authorization: `Bearer ${agentCredential}` } })).json()).toMatchObject({ deliveryTarget: "pull_request_draft" });

  const templated = await request({ projectId, title: "Template task", idempotencyKey: "hermes-template-001", templateId: "template_hermes_direct" });
  expect(templated.statusCode, templated.body).toBe(201);
  expect(templated.json()).toMatchObject({ workflow: { id: null, engine: "direct_build", name: null }, templateId: "template_hermes_direct" });
  expect((await app.inject({ method: "GET", url: `/api/hermes/tasks/${templated.json().id}`, headers: { Authorization: `Bearer ${agentCredential}` } })).json()).toMatchObject({ workflow: { id: null, engine: "direct_build", name: null }, templateId: "template_hermes_direct", deliveryTarget: "pull_request_draft" });

  const denied = await request({ projectId, title: "Denied workflow", idempotencyKey: "hermes-denied-001", workflowId: "workflow_native_independent_review" });
  expect(denied.statusCode).toBe(422);
  expect(denied.json()).toMatchObject({ code: "workflow_not_permitted", permittedWorkflowIds: policy.workflowIds });
  const badImage = await request({ projectId, title: "Bad image", idempotencyKey: "hermes-bad-image-001", images: [{ filename: "bad.png", mimeType: "image/png", base64: "aGVsbG8=" }] });
  expect(badImage.statusCode).toBe(422);
  const badFields = await request({ projectId, title: "Bad fields", idempotencyKey: "hermes-bad-fields-001", repositoryPath: "/private/path" });
  expect(badFields.statusCode).toBe(400);
});

test("server-chosen default profiles outlive a policy that still lists the old ones", async () => {
  const stamp = new Date().toISOString();
  database.authTransaction(db => {
    db.prepare("INSERT INTO forge_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('profile_drift_worker', 'Drift Worker', 'worker', '00000000000000000000000000000009', 'openai', 'gpt-5.6-luna', 'medium', 'default', ?, ?)").run(stamp, stamp);
    db.prepare("INSERT INTO forge_workflows (id, name, description, engine, configuration_json, created_at, updated_at) VALUES ('workflow_drift_record', 'Drift record', '', 'standard', ?, ?, ?)").run(JSON.stringify({ advisorProfileIds: {}, rootProfileId: "profile_native_root", workerProfileId: "profile_drift_worker" }), stamp, stamp);
  });
  await updateProjectPolicy({ workflowIds: ["workflow_native_standard", "workflow_drift_record"], defaultWorkflowId: "workflow_native_standard", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });

  // The admin changes the project default without sending a policy body, the way the project form does.
  const current = projects.getProject(adminId, projectId);
  await projects.updateProject(adminId, projectId, { name: current.name, repositoryPath: current.repositoryPath, worktreeRoot: current.worktreeRoot, repository: current.repository!, baseBranch: current.baseBranch, setupCommand: current.setupCommand, verificationCommand: current.verificationCommand, rootProfileId: current.rootProfileId, workerProfileId: "profile_drift_worker" });
  expect(projects.getProject(adminId, projectId).agentTaskPolicy).toMatchObject({ rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker", "profile_drift_worker"] });

  const request = (payload: object) => app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload });
  const plain = await request({ projectId, title: "Plain request", idempotencyKey: "hermes-drift-plain-001" });
  expect(plain.statusCode, plain.body).toBe(201);
  expect(tasks.getTask(adminId, plain.json().id as string).workerProfile.profileId).toBe("profile_drift_worker");

  // A stored policy that never learned the new default still must not block a caller who chose nothing.
  database.authTransaction(db => db.prepare("UPDATE forge_projects SET agent_task_policy_json = json_set(agent_task_policy_json, '$.workerProfileIds', json_array('profile_native_worker')) WHERE id = ?").run(projectId));
  const drifted = await request({ projectId, title: "Drifted policy", idempotencyKey: "hermes-drift-stored-001" });
  expect(drifted.statusCode, drifted.body).toBe(201);
  expect(tasks.getTask(adminId, drifted.json().id as string).workerProfile.profileId).toBe("profile_drift_worker");

  // A workflow record carrying its own profiles is a server choice too.
  const viaRecord = await request({ projectId, title: "Workflow record profiles", idempotencyKey: "hermes-drift-record-001", workflowId: "workflow_drift_record" });
  expect(viaRecord.statusCode, viaRecord.body).toBe(201);
  expect(tasks.getTask(adminId, viaRecord.json().id as string).workerProfile.profileId).toBe("profile_drift_worker");

  const chosen = await request({ projectId, title: "Caller choice", idempotencyKey: "hermes-drift-chosen-001", workerProfileId: "profile_drift_worker" });
  expect(chosen.statusCode).toBe(422);
  expect(chosen.body).toContain("The selected agent profile is not permitted");
});

test("Hermes idempotency hashes the semantic caller request before policy resolution", async () => {
  const payload = { projectId, title: "Concurrent retry", idempotencyKey: "hermes-concurrent-001" };
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload })));
  expect(responses.map(response => response.statusCode).sort()).toEqual([200, 200, 200, 201]);
  expect(new Set(responses.map(response => response.json().id)).size).toBe(1);
  const conflict = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { ...payload, title: "Different task" } });
  expect(conflict.statusCode).toBe(409);
  const current = projects.getProject(adminId, projectId);
  await projects.updateProject(adminId, projectId, { name: current.name, repositoryPath: current.repositoryPath, worktreeRoot: current.worktreeRoot, repository: current.repository!, baseBranch: current.baseBranch, setupCommand: current.setupCommand, verificationCommand: current.verificationCommand, rootProfileId: current.rootProfileId, workerProfileId: current.workerProfileId, agentTaskPolicy: { workflowIds: ["workflow_native_direct_build"], defaultWorkflowId: "workflow_native_direct_build", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" } });
  const replay = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload });
  expect(replay.statusCode).toBe(200);
});

test("rich conflicts are 409 and template descriptions preserve omission versus explicit override", async () => {
  const templateId = "template_hermes_description";
  database.authTransaction(db => db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(templateId, projectId, "Description", JSON.stringify({ name: "Description", description: "Template brief", workflow: "standard", advisorProfileIds: {} }), new Date().toISOString(), new Date().toISOString()));
  await updateProjectPolicy({ workflowIds: ["workflow_native_standard"], defaultWorkflowId: "workflow_native_standard", templateIds: [templateId], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
  const request = (payload: object) => app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload });
  const omitted = await request({ projectId, title: "Template omission", idempotencyKey: "hermes-template-description-omitted", templateId });
  const empty = await request({ projectId, title: "Template empty", description: "", idempotencyKey: "hermes-template-description-empty", templateId });
  const explicit = await request({ projectId, title: "Template explicit", description: "Caller brief", idempotencyKey: "hermes-template-description-explicit", templateId });
  expect([omitted.statusCode, empty.statusCode, explicit.statusCode]).toEqual([201, 201, 201]);
  const description = (response: typeof omitted) => database.authQuery(db => db.prepare("SELECT description FROM forge_tasks WHERE id = ?").get(response.json().id) as { description: string }).description;
  expect(description(omitted)).toBe("Template brief");
  expect(description(empty)).toBe("");
  expect(description(explicit)).toBe("Caller brief");
  const sameKey = { projectId, title: "Template hash", idempotencyKey: "hermes-template-description-hash", templateId };
  expect((await request(sameKey)).statusCode).toBe(201);
  expect((await request({ ...sameKey, description: "" })).statusCode).toBe(409);

  const rich = { projectId, title: "Rich conflict", idempotencyKey: "hermes-rich-conflict", templateId, images: [{ filename: "proof.png", mimeType: "image/png", base64: "iVBORw0KGgo=" }] };
  expect((await request(rich)).statusCode).toBe(201);
  for (const changed of [{ ...rich, images: [] }, { ...rich, templateId: undefined, workflowId: "workflow_native_standard" }, { ...rich, runProjectTests: true }, { ...rich, source: { kind: "branch", branch: "feature" } }]) {
    expect((await request(changed)).statusCode).toBe(409);
  }
});

test("Hermes request validation rejects required fields, unapproved choices, and attachment boundaries", async () => {
  const request = (payload: object) => app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload });
  expect((await request({ title: "Missing project", idempotencyKey: "missing-project" })).statusCode).toBe(400);
  expect((await request({ projectId, title: "Missing key" })).statusCode).toBe(400);
  const missingWorkflow = await request({ projectId, title: "Bad choice", idempotencyKey: "bad-choice-001", workflowId: "unknown" });
  expect(missingWorkflow).toMatchObject({ statusCode: 422 });
  expect(missingWorkflow.json()).toMatchObject({ code: "workflow_not_found", permittedWorkflowIds: expect.any(Array) });
  expect((await request({ projectId, title: "Bad profile", idempotencyKey: "bad-profile-001", rootProfileId: "profile_native_worker" })).statusCode).toBe(422);
  for (const [key, deliveryTarget] of [["bad-delivery-001", "merged"], ["bad-delivery-002", "pull_request_ready"]] as const) {
    const rejected = await request({ projectId, title: "Bad delivery", idempotencyKey: key, deliveryTarget });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: "delivery_policy_rejected" });
  }
  expect((await request({ projectId, title: "Bad filename", idempotencyKey: "bad-filename-001", images: [{ filename: "../proof.png", mimeType: "image/png", base64: "iVBORw0KGgo=" }] })).statusCode).toBe(400);
  expect((await request({ projectId, title: "Too many", idempotencyKey: "too-many-images-001", images: Array.from({ length: MAX_TASK_IMAGES + 1 }, () => ({ filename: "proof.png", mimeType: "image/png", base64: "iVBORw0KGgo=" })) })).statusCode).toBe(400);
  expect((await request({ projectId, title: "Encoded oversized", idempotencyKey: "encoded-oversized-001", images: [{ filename: "proof.png", mimeType: "image/png", base64: "A".repeat(MAX_TASK_IMAGE_BASE64_LENGTH + 1) }] })).statusCode).toBe(413);
  const decodedOversized = Buffer.alloc(MAX_TASK_IMAGE_BYTES + 1);
  decodedOversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(() => decodeTaskImage({ filename: "proof.png", mimeType: "image/png", base64: decodedOversized.toString("base64") })).toThrow("Image data is invalid or too large");
  expect((await request({ projectId, title: "Bad type", idempotencyKey: "bad-type-001", images: [{ filename: "proof.txt", mimeType: "text/plain", base64: "iVBORw0KGgo=" }] })).statusCode).toBe(400);
  for (const [key, payload] of [
    ["invalid-enum-001", { visualEvidence: "never" }],
    ["invalid-advisor-role-001", { advisorProfileIds: { operator: "profile_native_root" } }],
  ] satisfies Array<[string, object]>) expect((await request({ projectId, title: "Invalid request", idempotencyKey: key, ...payload })).statusCode).toBe(400);
  const testsDisabled = await request({ projectId, title: "Tests disabled", idempotencyKey: "tests-disabled-001", runProjectTests: false });
  expect(testsDisabled.statusCode).toBe(422);
  expect(testsDisabled.json()).toMatchObject({ code: "delivery_policy_rejected" });
  database.authTransaction(db => db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES ('template_disallowed', ?, 'Disallowed', ?, ?, ?)").run(projectId, JSON.stringify({ name: "Disallowed", description: "", workflow: "standard", advisorProfileIds: {} }), new Date().toISOString(), new Date().toISOString()));
  const missingTemplate = await request({ projectId, title: "Unavailable template", idempotencyKey: "template-template_missing", templateId: "template_missing" });
  expect(missingTemplate).toMatchObject({ statusCode: 422 });
  expect(missingTemplate.json()).toMatchObject({ code: "template_not_found", permittedTemplateIds: expect.any(Array) });
  const unpermittedTemplate = await request({ projectId, title: "Unavailable template", idempotencyKey: "template-template_disallowed", templateId: "template_disallowed" });
  expect(unpermittedTemplate).toMatchObject({ statusCode: 422 });
  expect(unpermittedTemplate.json()).toMatchObject({ code: "template_not_permitted", permittedTemplateIds: expect.any(Array) });
});

test("persisted grants remain authoritative when a principal project observation is stale", async () => {
  const principal = hermes.authenticate(agentCredential);
  const result = await tasks.createTaskForHermes({ ...principal, projectIds: [] }, { projectId, title: "Stale observation", idempotencyKey: "hermes-stale-observation-001", images: [], advisorProfileIds: {} });
  expect(result.created).toBe(true);
  hermes.replaceProjects(adminId, agentId, []);
  const denied = await tasks.createTaskForHermes({ ...principal, projectIds: [projectId] }, { projectId, title: "Revoked grant", idempotencyKey: "hermes-revoked-grant-001", images: [], advisorProfileIds: {} }).catch(error => error);
  expect(denied).toMatchObject({ statusCode: 404 });
});

test("archived Standard does not block unrelated human project creation or updates", async () => {
  database.authTransaction(db => db.prepare("UPDATE forge_workflows SET archived_at = ? WHERE id = 'workflow_native_standard'").run(new Date().toISOString()));
  const repositoryPath = join(root, "repositories", "project4");
  const worktreeRoot = join(root, "worktrees", "project4");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await expect(projects.createProject(adminId, companyId, { name: "Human after archive", repositoryPath, worktreeRoot, repository: "meiji/human-after-archive", baseBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" })).resolves.toMatchObject({ name: "Human after archive" });
  const current = projects.getProject(adminId, otherProjectId);
  await expect(projects.updateProject(adminId, otherProjectId, { name: current.name, repositoryPath: current.repositoryPath, worktreeRoot: current.worktreeRoot, repository: current.repository!, baseBranch: current.baseBranch, setupCommand: current.setupCommand, verificationCommand: current.verificationCommand, rootProfileId: current.rootProfileId, workerProfileId: current.workerProfileId })).resolves.toMatchObject({ id: otherProjectId });
});

test("Hermes admission rechecks grants, profiles, and relevant project configuration after capture", async () => {
  const principal = hermes.authenticate(agentCredential);
  const input = (key: string) => ({ projectId, title: "Delayed admission", idempotencyKey: key, images: [], advisorProfileIds: {} });
  const delayed = (afterCapture: () => void) => new TaskService(database, auth, {
    getProject: projects.getProject.bind(projects), getProjectInCompany: projects.getProjectInCompany.bind(projects), resolveTaskSource: projects.resolveTaskSource.bind(projects),
    async captureTaskConfiguration(project) { const captured = await projects.captureTaskConfiguration(project); afterCapture(); return captured; },
  }, config);

  const revoked = delayed(() => hermes.replaceProjects(adminId, agentId, []));
  await expect(revoked.createTaskForHermes(principal, input("hermes-delayed-revoked-001"))).rejects.toMatchObject({ statusCode: 404 });
  hermes.replaceProjects(adminId, agentId, [projectId]);

  const archived = delayed(() => database.authTransaction(db => db.prepare("UPDATE forge_profiles SET archived_at = ? WHERE id = 'profile_native_root'").run(new Date().toISOString())));
  await expect(archived.createTaskForHermes(principal, input("hermes-delayed-profile-001"))).rejects.toMatchObject({ statusCode: 422 });
  database.authTransaction(db => db.prepare("UPDATE forge_profiles SET archived_at = NULL WHERE id = 'profile_native_root'").run());

  for (const [key, sql] of [
    ["hermes-delayed-setup-001", "UPDATE forge_projects SET setup_command = 'pnpm changed' WHERE id = ?"],
    ["hermes-delayed-verification-001", "UPDATE forge_projects SET verification_command = 'pnpm changed' WHERE id = ?"],
    ["hermes-delayed-repository-001", "UPDATE forge_projects SET repository_identity = 'meiji/changed' WHERE id = ?"],
  ] satisfies Array<[string, string]>) {
    const changed = delayed(() => database.authTransaction(db => db.prepare(sql).run(projectId)));
    await expect(changed.createTaskForHermes(principal, input(key))).rejects.toMatchObject({ statusCode: 409 });
    database.authTransaction(db => db.prepare("UPDATE forge_projects SET setup_command = 'pnpm install', verification_command = 'pnpm test', repository_identity = 'meiji/hermes-test' WHERE id = ?").run(projectId));
  }

  const metadata = delayed(() => database.authTransaction(db => db.prepare("UPDATE forge_projects SET name = 'Renamed project' WHERE id = ?").run(projectId)));
  await expect(metadata.createTaskForHermes(principal, input("hermes-delayed-metadata-001"))).resolves.toMatchObject({ created: true });
});

test("a paused rich Hermes retry returns its concurrent winner after policy changes, but not after grant revocation", async () => {
  const templateId = "template_hermes_concurrent";
  database.authTransaction(db => db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(templateId, projectId, "Concurrent", JSON.stringify({ name: "Concurrent", description: "Template brief", workflow: "standard", advisorProfileIds: {} }), new Date().toISOString(), new Date().toISOString()));
  const policy: ProjectAgentTaskPolicy = { workflowIds: ["workflow_native_standard"], defaultWorkflowId: "workflow_native_standard", templateIds: [templateId], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" };
  await updateProjectPolicy(policy);
  const principal = hermes.authenticate(agentCredential);
  const request = (idempotencyKey: string) => ({ projectId, title: "Concurrent rich retry", idempotencyKey, templateId, images: [{ filename: "proof.png", mimeType: "image/png" as const, base64: "iVBORw0KGgo=" }], advisorProfileIds: {} });
  const paused = () => {
    let captured!: () => void;
    let release!: () => void;
    const capturedPromise = new Promise<void>(resolve => { captured = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const service = new TaskService(database, auth, {
      getProject: projects.getProject.bind(projects), getProjectInCompany: projects.getProjectInCompany.bind(projects), resolveTaskSource: projects.resolveTaskSource.bind(projects),
      async captureTaskConfiguration(project) { const value = await projects.captureTaskConfiguration(project); captured(); await releasePromise; return value; },
    }, config);
    return { service, captured: capturedPromise, release };
  };
  const count = (table: string, clause = "") => database.authQuery(db => (db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${clause}`).get() as { count: number }).count);

  const retry = paused();
  const loser = retry.service.createTaskForHermes(principal, request("hermes-concurrent-rich-001"));
  await retry.captured;
  const winner = await tasks.createTaskForHermes(principal, request("hermes-concurrent-rich-001"));
  await updateProjectPolicy({ ...policy, templateIds: [] });
  retry.release();
  await expect(loser).resolves.toMatchObject({ created: false, task: { id: winner.task.id } });
  expect(count("forge_tasks")).toBe(1);
  expect(count("forge_task_controls")).toBe(1);
  expect(count("forge_artifacts")).toBe(1);
  expect(count("forge_task_sessions")).toBe(0);
  expect(count("forge_audit_events", "WHERE action = 'task_created'")).toBe(1);
  expect(recoveryWakes).toBe(0);

  await updateProjectPolicy(policy);
  const revoked = paused();
  const denied = revoked.service.createTaskForHermes(principal, request("hermes-concurrent-revoked-001"));
  await revoked.captured;
  await tasks.createTaskForHermes(principal, request("hermes-concurrent-revoked-001"));
  hermes.replaceProjects(adminId, agentId, []);
  revoked.release();
  await expect(denied).rejects.toMatchObject({ statusCode: 404 });
});

test("a granted Hermes agent can create from project-scoped resolved source metadata", async () => {
  const sourceTasks = new TaskService(database, auth, {
    getProject: projects.getProject.bind(projects), getProjectInCompany: projects.getProjectInCompany.bind(projects), captureTaskConfiguration: projects.captureTaskConfiguration.bind(projects),
    async resolveTaskSource(_project, source) { expect(source).toEqual({ kind: "branch", branch: "feature" }); return { kind: "branch", branch: "feature", headSha: "b".repeat(40) }; },
  }, config);
  const result = await sourceTasks.createTaskForHermes(hermes.authenticate(agentCredential), { projectId, title: "Resolved source", idempotencyKey: "hermes-resolved-source-001", source: { kind: "branch", branch: "feature" }, images: [], advisorProfileIds: {} });
  expect(tasks.getTask(adminId, result.task.id).configuration.startingSha).toBe("b".repeat(40));
});

test("basic retries accept pre-feature Hermes request hashes only for the original payload", async () => {
  const payload = { projectId, title: "Legacy hash", description: "Original", idempotencyKey: "hermes-legacy-hash-001" };
  const created = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload });
  expect(created.statusCode, created.body).toBe(201);
  const legacy = taskRequestHash(TaskInputSchema.parse(normalizeWorkflowInput(payload, { requireSource: true })), { kind: "agent", id: agentId });
  database.authTransaction(db => db.prepare("UPDATE forge_tasks SET request_hash = ? WHERE id = ?").run(legacy, created.json().id));
  const replay = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload });
  expect(replay.statusCode, replay.body).toBe(200);
  const conflict = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { ...payload, description: "Changed" } });
  expect(conflict.statusCode).toBe(409);
});

test("agent lifecycle commands use current revisions, durable receipts, note attribution, and duplicate provenance", async () => {
  const created = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Command target", idempotencyKey: "command-target-001" } });
  expect(created.statusCode).toBe(201);
  const task = created.json() as { id: string; revision: string };
  const command = (payload: object) => app.inject({ method: "POST", url: `/api/hermes/tasks/${task.id}/commands`, headers: { Authorization: `Bearer ${agentCredential}` }, payload });

  const started = await command({ command: "start_task", revision: task.revision, idempotencyKey: "start-001" });
  expect(started.statusCode, started.body).toBe(200);
  expect(started.json()).toMatchObject({ status: "active" });
  const replay = await command({ command: "start_task", revision: task.revision, idempotencyKey: "start-001" });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(started.json());
  const stale = await command({ command: "cancel_task", revision: task.revision, idempotencyKey: "stale-001" });
  expect(stale.statusCode).toBe(412);
  expect(stale.json().code).toBe("revision_stale");

  tasks.repository.controls.claimRoot({ taskId: task.id });
  const noteRevision = tasks.getHermesTask(hermes.authenticate(agentCredential), task.id).revision;
  const noted = await command({ command: "send_task_note", revision: noteRevision, idempotencyKey: "note-001", note: "Machine progress note" });
  expect(noted.statusCode, noted.body).toBe(200);
  expect(database.authQuery(db => (db.prepare("SELECT prompt_text FROM forge_task_turns WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(task.id) as { prompt_text: string }).prompt_text)).toContain(`Agent note (${agentId}):\nMachine progress note`);
  expect((await command({ command: "send_task_note", revision: noteRevision, idempotencyKey: "note-001", note: "Machine progress note" })).statusCode).toBe(200);
  expect(database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_task_turns WHERE task_id = ? AND prompt_text LIKE '%Machine progress note%'").get(task.id) as { count: number }).count)).toBe(1);

  const duplicate = await command({ command: "duplicate_task", revision: noted.json().revision, idempotencyKey: "duplicate-001" });
  expect(duplicate.statusCode, duplicate.body).toBe(200);
  const copyId = duplicate.json().id as string;
  expect(duplicate.json()).toMatchObject({ status: "backlog" });
  expect(database.authQuery(db => db.prepare("SELECT copied_from_task_id FROM forge_tasks WHERE id = ?").get(copyId))).toEqual({ copied_from_task_id: task.id });

  const cancelRevision = tasks.getHermesTask(hermes.authenticate(agentCredential), task.id).revision;
  const cancelled = await command({ command: "cancel_task", revision: cancelRevision, idempotencyKey: "cancel-001" });
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  const archived = await command({ command: "archive_task", revision: cancelled.json().revision, idempotencyKey: "archive-001" });
  expect(archived.statusCode, archived.body).toBe(200);
  expect(archived.json()).toMatchObject({ archived: true });
  const unarchived = await command({ command: "unarchive_task", revision: archived.json().revision, idempotencyKey: "unarchive-001" });
  expect(unarchived.statusCode, unarchived.body).toBe(200);
  expect(unarchived.json()).toMatchObject({ archived: false });
  expect(database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE actor_agent_id = ? AND action IN ('task_started', 'task_note_added', 'task_duplicated', 'task_cancelled', 'task_archived', 'task_unarchived')").get(agentId) as { count: number }).count)).toBe(6);
});

test("Hermes start records queued intent while a prerequisite is undelivered", async () => {
  const prerequisite = await createTask("Hermes prerequisite", "hermes-start-prerequisite-001");
  const created = await app.inject({
    method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` },
    payload: { projectId, title: "Hermes dependent", idempotencyKey: "hermes-start-dependent-001", dependsOn: [prerequisite.id] },
  });
  expect(created.statusCode, created.body).toBe(201);
  const dependent = created.json() as { id: string; revision: string };

  const started = await command(dependent.id, { command: "start_task", revision: dependent.revision, idempotencyKey: "hermes-start-blocked-001" });
  expect(started.statusCode, started.body).toBe(200);
  expect(started.json()).toMatchObject({ status: "backlog", dependsOn: [prerequisite.id] });
  expect(tasks.getTask(adminId, dependent.id)).toMatchObject({ status: "backlog", queue: { startIntent: "queued" } });
  expect(tasks.repository.controls.taskSpend(dependent.id).turns).toBe(0);
});

test("project policy owns the default workflow and implicit Advisor profile", async () => {
  const update = async (agentTaskPolicy: ProjectAgentTaskPolicy) => {
    const current = projects.getProject(adminId, projectId);
    await projects.updateProject(adminId, projectId, { name: current.name, repositoryPath: current.repositoryPath, worktreeRoot: current.worktreeRoot, repository: current.repository!, baseBranch: current.baseBranch, setupCommand: current.setupCommand, verificationCommand: current.verificationCommand, rootProfileId: current.rootProfileId, workerProfileId: current.workerProfileId, agentTaskPolicy });
  };
  await update({ workflowIds: ["workflow_native_direct_build"], defaultWorkflowId: "workflow_native_direct_build", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
  const direct = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Policy default", idempotencyKey: "hermes-policy-default-001" } });
  expect(direct.statusCode, direct.body).toBe(201);
  expect(direct.json().workflow).toMatchObject({ id: "workflow_native_direct_build", engine: "direct_build", name: "Direct build" });

  await update({ workflowIds: ["workflow_native_independent_review"], defaultWorkflowId: "workflow_native_independent_review", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
  const denied = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Implicit advisor", idempotencyKey: "hermes-policy-advisor-denied" } });
  expect(denied.statusCode).toBe(422);

  await update({ workflowIds: ["workflow_native_independent_review"], defaultWorkflowId: "workflow_native_independent_review", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: ["profile_native_root"], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
  const allowed = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Implicit advisor allowed", idempotencyKey: "hermes-policy-advisor-allowed" } });
  expect(allowed.statusCode, allowed.body).toBe(201);
  expect(allowed.json()).toMatchObject({ workflow: { id: "workflow_native_independent_review", engine: "independent_review", name: "Second opinion" } });

  database.authTransaction(db => db.prepare("UPDATE forge_projects SET agent_task_policy_json = ? WHERE id = ?").run("{invalid", projectId));
  const corrupt = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Corrupt policy", idempotencyKey: "hermes-policy-corrupt" } });
  expect(corrupt.statusCode).toBe(422);
});


test("cross-company and out-of-grant projects are non-enumerating with zero side effects", async () => {
  const counts = (): Record<string, number> => Object.fromEntries([
    "forge_task_controls", "forge_tasks", "forge_artifacts", "forge_task_turns", "forge_task_sessions",
  ].map((table) => [table, database.authQuery((db) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]).concat([["task_created_audits", database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action = 'task_created'").get() as { count: number }).count)], ["recovery_wakes", recoveryWakes]]));
  const denied = async (deniedProjectId: string, idempotencyKey: string) => app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: { Authorization: `Bearer ${agentCredential}` },
    payload: {
      projectId: deniedProjectId,
      title: "Out of scope",
      description: "Should fail",
      idempotencyKey,
    },
  });

  const deniedRequests: Array<[string, string]> = [[otherProjectId, "out-of-grant-001"], [crossCompanyProjectId, "cross-company-001"]];
  for (const [deniedProjectId, idempotencyKey] of deniedRequests) {
    const before = counts();
    const response = await denied(deniedProjectId, idempotencyKey);
    const unknown = await denied("project_unknown", `${idempotencyKey}-unknown`);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(unknown.json());
    expect(counts()).toEqual(before);
  }
});

test("unauthenticated requests are rejected", async () => {

  // Missing / invalid bearer token returns 401
  const noAuth = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    payload: {
      projectId,
      title: "No Auth",
      description: "Should fail",
      idempotencyKey: "no-auth-001",
    },
  });
  expect(noAuth.statusCode).toBe(401);

  const badToken = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: { Authorization: "Bearer fha_invalid0000000000000000000000000000000000" },
    payload: {
      projectId,
      title: "Bad Auth",
      description: "Should fail",
      idempotencyKey: "bad-auth-001",
    },
  });
  expect(badToken.statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/api/hermes/me" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/api/hermes/tasks" })).statusCode).toBe(401);
});

test("bearer authentication failures are identical at the HTTP boundary", async () => {
  const payload = { projectId, title: "Authentication boundary", description: "Should never create", idempotencyKey: "auth-boundary-001" };
  const request = (credential: string) => app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${credential}` }, payload });
  const malformed = await request("not-a-bearer-credential");
  expect(malformed.statusCode).toBe(401);

  const rotation = hermes.rotate(adminId, agentId);
  const beforeExchange = await app.inject({ method: "GET", url: "/api/hermes/tasks/task_unknown", headers: { Authorization: `Bearer ${agentCredential}` } });
  expect(beforeExchange.statusCode).toBe(404);
  const replacement = hermes.exchange({ pairingCode: rotation.pairingCode, profileId: "profile-bot" }).credential;
  const replacementSuccess = await app.inject({ method: "GET", url: "/api/hermes/tasks/task_unknown", headers: { Authorization: `Bearer ${replacement}` } });
  expect(replacementSuccess.statusCode).toBe(404);
  hermes.revoke(adminId, agentId);

  const failures = await Promise.all([malformed, request("fha_invalid0000000000000000000000000000000000"), request(agentCredential), request(replacement)]);
  for (const failure of failures) {
    expect(failure.statusCode).toBe(401);
    expect(failure.json()).toEqual(malformed.json());
    expect(failure.headers["cache-control"]).toBeUndefined();
    expect(JSON.stringify(failure.json())).not.toContain(agentId);
    expect(JSON.stringify(failure.json())).not.toMatch(/fha_|[a-f0-9]{64}|revoked_at|credential_id/i);
  }
});

test("GET /api/hermes/tasks/:taskId returns safe projection, handles non-enumeration and scope revocation", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/hermes/tasks",
    headers: { Authorization: `Bearer ${agentCredential}` },
    payload: {
      projectId,
      title: "Task For Status Check",
      description: "Detailed description",
      idempotencyKey: "status-check-001",
    },
  });
  const taskId = created.json().id;
  const stalePrincipal = hermes.authenticate(agentCredential);

  // GET by creator agent succeeds
  const getSuccess = await app.inject({
    method: "GET",
    url: `/api/hermes/tasks/${taskId}`,
    headers: { Authorization: `Bearer ${agentCredential}` },
  });
  expect(getSuccess.statusCode).toBe(200);
  expect(getSuccess.headers["cache-control"]).toBe("private, no-store");
  const expectedKeys = ["id", "issueKey", "projectId", "project", "title", "status", "queue", "dependsOn", "blockedBy", "archived", "revision", "permittedCommands", "humanQuestion", "blocker", "workflowStage", "workflow", "templateId", "deliveryTarget", "runProjectTests", "visualEvidence", "delivery", "createdAt", "updatedAt", "implementation", "integration", "actionRequired"].sort();
  expect(Object.keys(getSuccess.json()).sort()).toEqual(expectedKeys);
  expect(getSuccess.json().title).toBe("Task For Status Check");

  // Another agent granted the same project still reads nothing: a task belongs to the agent that created it.
  const otherAgentIssued = hermes.create(adminId, { name: "Hermes Bot Other", companyId, projectIds: [projectId] });
  const otherPaired = hermes.exchange({ pairingCode: otherAgentIssued.pairingCode, profileId: "profile-other" });

  const getOtherAgent = await app.inject({
    method: "GET",
    url: `/api/hermes/tasks/${taskId}`,
    headers: { Authorization: `Bearer ${otherPaired.credential}` },
  });
  expect(getOtherAgent.statusCode).toBe(404);

  // Non-existent task returns 404
  const getNonExistent = await app.inject({
    method: "GET",
    url: "/api/hermes/tasks/task_non_existent",
    headers: { Authorization: `Bearer ${agentCredential}` },
  });
  expect(getNonExistent.statusCode).toBe(404);

  // Scope revocation: revoke agent's project access -> subsequent GET returns 404
  hermes.replaceProjects(adminId, agentId, []);
  expect(() => tasks.getHermesTask(stalePrincipal, taskId)).toThrow("Not found");
  expect(tasks.listHermesTasks(stalePrincipal, { limit: 10 })).toEqual({ tasks: [], nextCursor: null });
  const getAfterRevocation = await app.inject({
    method: "GET",
    url: `/api/hermes/tasks/${taskId}`,
    headers: { Authorization: `Bearer ${agentCredential}` },
  });
  expect(getAfterRevocation.statusCode).toBe(404);
});


test("a delivered task with a conflicting pull request blocks its downstream task, and filters separate them", async () => {
  const foundation = await deliverTask("Foundation delivery", "integration-foundation-001", 41, ghPullRequest({ number: 41, state: "OPEN", headSha: "d".repeat(40), mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }));
  const downstream = await createHermesTask("Downstream work", "integration-downstream-001");
  branchFrom(downstream, foundation);

  const foundationBody = (await readTask(foundation)).json();
  expect(foundationBody.status).toBe("delivered");
  expect(foundationBody.implementation).toEqual({ status: "delivered" });
  expect(foundationBody.integration.integrated).toBe(false);
  expect(foundationBody.integration.observation).toBe("observed");
  expect(foundationBody.integration.pullRequest).toMatchObject({ state: "conflicting", number: 41, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", targetBranch: "main" });
  expect(foundationBody.integration.deployed).toEqual({ included: null, reason: "not_determinable" });
  expect(foundationBody.actionRequired).toMatchObject({ owner: "agent", reasonCode: "conflicting_pull_request", upstream: null, humanApprovalRequired: false });
  expect(foundationBody.actionRequired.suggestedCommands.length).toBeGreaterThan(0);

  const downstreamBody = (await readTask(downstream)).json();
  expect(downstreamBody.integration.integrated).toBe(false);
  expect(downstreamBody.integration.pullRequest.state).toBe("absent");
  expect(downstreamBody.actionRequired).toMatchObject({ owner: "upstream", reasonCode: "blocked_by_dependency", upstream: { taskId: foundation, pullRequestNumber: 41 } });

  const ids = async (query: string) => ((await listTasks(query)).json().tasks as Array<{ id: string }>).map(task => task.id);
  expect(await ids("?filter=conflicting_pull_request")).toEqual([foundation]);
  expect(await ids("?filter=blocked_by_dependency")).toEqual([downstream]);
  expect((await ids("?filter=not_integrated")).sort()).toEqual([foundation, downstream].sort());
});

test("a merged pull request reports integration with no action required", async () => {
  const taskId = await deliverTask("Merged delivery", "integration-merged-001", 42, ghPullRequest({ number: 42, state: "MERGED", headSha: "d".repeat(40) }));
  const body = (await readTask(taskId)).json();
  expect(body.integration.integrated).toBe(true);
  expect(body.integration.pullRequest.state).toBe("merged");
  expect(body.actionRequired).toBeNull();
  expect(((await listTasks("?filter=not_integrated")).json().tasks as Array<{ id: string }>).map(task => task.id)).not.toContain(taskId);
});

test("failed checks, pending review, and a base branch behind the pull request each report their own action", async () => {
  const failing = await deliverTask("Failing checks", "integration-failing-001", 43, ghPullRequest({ number: 43, state: "OPEN", headSha: "d".repeat(40), checks: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }] }));
  const review = await deliverTask("Pending review", "integration-review-001", 44, ghPullRequest({ number: 44, state: "OPEN", headSha: "d".repeat(40), reviewDecision: "REVIEW_REQUIRED" }));
  const stale = await deliverTask("Stale delivery", "integration-stale-001", 45, ghPullRequest({ number: 45, state: "OPEN", headSha: "d".repeat(40), mergeStateStatus: "BEHIND" }));

  expect((await readTask(failing)).json().actionRequired).toMatchObject({ owner: "agent", reasonCode: "failed_checks" });
  expect((await readTask(failing)).json().integration.pullRequest.checks).toEqual({ total: 1, pending: 0, failing: 1, successful: 0 });
  expect((await readTask(review)).json().actionRequired).toMatchObject({ owner: "human", reasonCode: "pending_review", humanApprovalRequired: true });
  expect((await readTask(stale)).json().actionRequired).toMatchObject({ owner: "agent", reasonCode: "stale_delivery" });

  const pending = await deliverTask("Pending checks", "integration-pending-001", 47, ghPullRequest({ number: 47, state: "OPEN", headSha: "d".repeat(40), checks: [{ name: "build", status: "IN_PROGRESS", conclusion: null }] }));
  expect((await readTask(pending)).json().actionRequired).toMatchObject({ owner: "forge", reasonCode: "pending_checks" });

  const missing = await deliverTask("Missing pull request", "integration-missing-001", 48, ABSENT);
  expect((await readTask(missing)).json().actionRequired).toMatchObject({ owner: "agent", reasonCode: "pull_request_missing" });

  const approved = await deliverTask("Approved and not merged", "integration-approved-001", 49, ghPullRequest({ number: 49, state: "OPEN", headSha: "d".repeat(40) }));
  expect((await readTask(approved)).json().actionRequired).toMatchObject({ owner: "human", reasonCode: "waiting_human", humanApprovalRequired: true });

  const ids = async (query: string) => ((await listTasks(query)).json().tasks as Array<{ id: string }>).map(task => task.id);
  expect(await ids("?filter=failed_checks")).toEqual([failing]);
  expect(await ids("?filter=pending_review")).toEqual([review]);
  expect(await ids("?filter=stale_delivery")).toEqual([stale]);
});

test("a GitHub read failure returns 200 with an unavailable observation and no integration claim", async () => {
  const taskId = await deliverTask("GitHub unavailable", "integration-unavailable-001", 46, new GithubReleaseFailure("provider-unavailable", "GitHub did not answer"));
  const response = await readTask(taskId);
  expect(response.statusCode).toBe(200);
  expect(response.json().integration).toMatchObject({ integrated: false, observation: "unavailable", observationReason: "provider-unavailable" });
  expect(response.json().actionRequired).toMatchObject({ owner: "forge", reasonCode: "observation_unavailable" });
});

test("GET /api/hermes/tasks scopes the list, rejects an unknown filter, and exposes no build internals", async () => {
  const granted = await createHermesTask("Granted project task", "list-granted-001");
  const outOfGrant = (await tasks.createTask(adminId, companyId, { projectId: otherProjectId, title: "Out of grant", idempotencyKey: "list-out-of-grant-001" })).task;
  const crossCompany = (await tasks.createTask(adminId, auth.listVisibleCompanies(adminId).find(company => company.id !== companyId)!.id, { projectId: crossCompanyProjectId, title: "Cross company", idempotencyKey: "list-cross-company-001" })).task;

  const response = await listTasks();
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  const listed = response.json().tasks as Array<Record<string, unknown>>;
  const ids = listed.map(task => task.id);
  expect(ids).toContain(granted);
  expect(ids).not.toContain(outOfGrant.id);
  expect(ids).not.toContain(crossCompany.id);

  expect(Object.keys(listed[0]!).sort()).toEqual(["id", "issueKey", "projectId", "project", "title", "status", "queue", "dependsOn", "blockedBy", "archived", "revision", "permittedCommands", "humanQuestion", "blocker", "workflowStage", "workflow", "templateId", "deliveryTarget", "runProjectTests", "visualEvidence", "delivery", "createdAt", "updatedAt", "implementation", "integration", "actionRequired"].sort());
  expect(JSON.stringify(listed)).not.toMatch(/worktree|repositoryPath|session|turn|prompt|transcript|credential|objective/i);

  expect((await listTasks(`?projectId=${projectId}`)).json().tasks.map((task: { id: string }) => task.id)).toContain(granted);
  expect((await listTasks(`?projectId=${otherProjectId}`)).statusCode).toBe(404);
  expect((await listTasks("?filter=not_a_filter")).statusCode).toBe(400);

  // An archived task keeps its place on the agent surface, flagged and reduced to a single command.
  await tasks.archiveTask(adminId, granted);
  expect(((await listTasks()).json().tasks as Array<{ id: string; archived: boolean }>).find(task => task.id === granted)).toMatchObject({ archived: true });
  expect((await readTask(granted)).json()).toMatchObject({ archived: true, permittedCommands: ["unarchive_task"] });
});

test("real HTTP discovery applies current grants, ownership, pagination, and conditional polling", async () => {
  const create = async (title: string, idempotencyKey: string) => {
    const response = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title, idempotencyKey } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; revision: string };
  };
  const first = await create("Discovery first", "discovery-001");
  const second = await create("Discovery second", "discovery-002");
  const third = await create("Discovery third", "discovery-003");
  const humanTask = await tasks.createTask(adminId, companyId, { projectId, title: "Human-owned task", description: "Not visible to Hermes", idempotencyKey: "human-discovery-001" });

  const otherIssued = hermes.create(adminId, { name: "Discovery Other", companyId, projectIds: [projectId] });
  const otherCredential = hermes.exchange({ pairingCode: otherIssued.pairingCode, profileId: "profile-discovery-other" }).credential;
  const otherTask = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${otherCredential}` }, payload: { projectId, title: "Other agent task", idempotencyKey: "other-agent-001" } });
  const otherProjectIssued = hermes.create(adminId, { name: "Other project agent", companyId, projectIds: [otherProjectId] });
  const otherProjectCredential = hermes.exchange({ pairingCode: otherProjectIssued.pairingCode, profileId: "profile-other-project" }).credential;
  const otherProjectTask = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${otherProjectCredential}` }, payload: { projectId: otherProjectId, title: "Cross-grant task", idempotencyKey: "cross-grant-001" } });
  const crossCompanyIssued = hermes.create(adminId, { name: "Cross company agent", companyId: crossCompanyId, projectIds: [crossCompanyProjectId] });
  const crossCompanyCredential = hermes.exchange({ pairingCode: crossCompanyIssued.pairingCode, profileId: "profile-cross-company" }).credential;
  const crossCompanyTask = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${crossCompanyCredential}` }, payload: { projectId: crossCompanyProjectId, title: "Cross-company task", idempotencyKey: "cross-company-001" } });
  expect(otherTask.statusCode).toBe(201);
  expect(otherProjectTask.statusCode).toBe(201);
  expect(crossCompanyTask.statusCode).toBe(201);

  tasks.repository.controls.start(first.id);
  tasks.repository.controls.askHuman(first.id, "Need a human decision");
  tasks.repository.setArchived(second.id, true);
  tasks.repository.controls.start(third.id);
  tasks.repository.controls.start(otherTask.json().id);
  tasks.repository.controls.start(humanTask.task.id);
  database.authTransaction((db) => {
    const timestamp = "2030-01-01T00:00:00.000Z";
    db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json(?)), updated_at = ? WHERE task_id = ?").run(JSON.stringify({ headSha: "a".repeat(40), fingerprint: "delivery-wait", since: timestamp, reason: "checks" }), timestamp, third.id);
    db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json(?)), updated_at = ? WHERE task_id IN (?, ?)").run(JSON.stringify({ headSha: "a".repeat(40), fingerprint: "unauthorized-delivery-wait", since: timestamp, reason: "checks" }), timestamp, otherTask.json().id, humanTask.task.id);
    db.prepare("UPDATE forge_task_controls SET updated_at = ? WHERE task_id IN (?, ?)").run(timestamp, first.id, second.id);
    db.prepare("UPDATE forge_tasks SET updated_at = ? WHERE id = ?").run(timestamp, second.id);
  });

  let address = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = async (path: string, credential = agentCredential, headers: HeadersInit = {}) => fetch(new URL(path, address), { headers: { authorization: `Bearer ${credential}`, ...headers } });

  const identity = await request("/api/hermes/me");
  expect(identity.status).toBe(200);
  expect(await identity.json()).toMatchObject({ agent: { id: agentId, name: "Hermes Bot", profileId: "profile-bot" }, capabilities: { taskDiscovery: true, taskRead: true, taskCreate: true, taskCommands: expect.arrayContaining(["start_task", "cancel_task", "duplicate_task"]) }, projects: [{ id: projectId, name: "Hermes Project", agentTaskPolicy: { deliveryTargets: ["pull_request_draft"], runProjectTests: true, visualEvidence: "off" } }] });

  const pageOne = await request("/api/hermes/tasks?limit=2");
  expect(pageOne.status).toBe(200);
  const pageOneBody = await pageOne.json() as { tasks: Array<{ id: string; project: { id: string }; revision: string }>; nextCursor: string | null };
  expect(pageOneBody.tasks).toHaveLength(2);
  expect(pageOneBody.tasks.every(task => task.project.id === projectId)).toBe(true);
  expect(pageOneBody.nextCursor).toBeTypeOf("string");
  await app.close();
  tasks = new TaskService(database, auth, projects, config);
  hermes = new HermesAgentService(database, auth);
  app = createApp({ config, auth, projects, tasks, hermes, host: { async recover() { recoveryWakes++; } }, health: {
    database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
    artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
    ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
  } });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
  const pageTwo = await request(`/api/hermes/tasks?limit=2&cursor=${encodeURIComponent(pageOneBody.nextCursor!)}`);
  expect(pageTwo.status).toBe(200);
  const pageTwoBody = await pageTwo.json() as { tasks: Array<{ id: string }> };
  expect(pageTwoBody.tasks).toHaveLength(1);
  expect([...pageOneBody.tasks.map(task => task.id), ...pageTwoBody.tasks.map(task => task.id)].sort()).toEqual([first.id, second.id, third.id].sort());
  expect((await request(`/api/hermes/tasks?limit=2&cursor=${encodeURIComponent(pageOneBody.nextCursor!)}`, otherCredential)).status).toBe(400);
  expect((await request(`/api/hermes/tasks?limit=2&status=active&cursor=${encodeURIComponent(pageOneBody.nextCursor!)}`)).status).toBe(400);
  expect((await request("/api/hermes/tasks?projectId=project_unknown")).status).toBe(404);
  for (const taskId of [otherTask.json().id, otherProjectTask.json().id, crossCompanyTask.json().id, humanTask.task.id]) {
    const denied = await request(`/api/hermes/tasks/${taskId}`);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "Not found", code: "resource_not_found" });
  }
  expect((await request("/api/hermes/tasks?cursor=not-a-cursor")).status).toBe(400);
  const [cursorPayload, cursorSignature] = pageOneBody.nextCursor!.split(".");
  const tamperedSignature = `${cursorSignature!.slice(0, -1)}${cursorSignature!.endsWith("A") ? "B" : "A"}`;
  expect((await request(`/api/hermes/tasks?cursor=${encodeURIComponent(`${cursorPayload}.${tamperedSignature}`)}`)).status).toBe(400);
  const unicodeCursor = `${pageOneBody.nextCursor!.split(".")[0]}.${"é".repeat(43)}`;
  expect((await request(`/api/hermes/tasks?cursor=${encodeURIComponent(unicodeCursor)}`)).status).toBe(400);
  expect(await (await request(`/api/hermes/tasks?projectId=${projectId}`)).json()).toMatchObject({ tasks: expect.any(Array) });
  expect(await (await request("/api/hermes/tasks?status=waiting_human")).json()).toMatchObject({ tasks: [{ id: first.id }] });
  expect(await (await request("/api/hermes/tasks?archived=true")).json()).toMatchObject({ tasks: [{ id: second.id }] });
  expect(await (await request("/api/hermes/tasks?attention=true")).json()).toMatchObject({ tasks: [{ id: first.id }] });
  const blockerTasks = await (await request("/api/hermes/tasks?blocker=true")).json() as { tasks: Array<{ id: string }>; nextCursor: string | null };
  expect(blockerTasks.tasks.map(task => task.id)).toEqual([first.id, third.id].sort());
  const blockedFirstPage = await (await request("/api/hermes/tasks?blocker=true&limit=1")).json() as { tasks: Array<{ id: string }>; nextCursor: string | null };
  const blockedSecondPage = await (await request(`/api/hermes/tasks?blocker=true&limit=1&cursor=${encodeURIComponent(blockedFirstPage.nextCursor!)}`)).json() as { tasks: Array<{ id: string }>; nextCursor: string | null };
  expect([...blockedFirstPage.tasks, ...blockedSecondPage.tasks].map(task => task.id).sort()).toEqual([first.id, third.id].sort());
  expect(blockedSecondPage.nextCursor).toBeNull();
  const combinedBlocked = await (await request(`/api/hermes/tasks?projectId=${projectId}&status=active&archived=false&attention=false&blocker=true&updatedSince=2030-01-01T00:00:00Z`)).json() as { tasks: Array<{ id: string }> };
  expect(combinedBlocked.tasks.map(task => task.id)).toEqual([third.id]);
  const unblockedTasks = await (await request("/api/hermes/tasks?blocker=false")).json() as { tasks: Array<{ id: string }> };
  expect(unblockedTasks.tasks.map(task => task.id)).toEqual([second.id]);
  const updatedTasks = await (await request("/api/hermes/tasks?updatedSince=2030-01-01T00:00:00Z")).json() as { tasks: Array<{ id: string }> };
  expect(updatedTasks.tasks.map(task => task.id)).toEqual(expect.arrayContaining([first.id, second.id, third.id]));

  const current = await request(`/api/hermes/tasks/${first.id}`);
  expect(current.status).toBe(200);
  const etag = current.headers.get("etag");
  expect(etag).toBe(`\"${(await current.json() as { revision: string }).revision}\"`);
  const unchanged = await request(`/api/hermes/tasks/${first.id}`, agentCredential, { "if-none-match": etag! });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  const stale = await request(`/api/hermes/tasks/${first.id}`, agentCredential, { "if-match": "\"stale\"" });
  expect(stale.status).toBe(412);
  expect(await stale.json()).toEqual({ error: "Task revision is stale", code: "revision_stale" });
  const waitingDelivery = await request(`/api/hermes/tasks/${third.id}`);
  const waitingDeliveryEtag = waitingDelivery.headers.get("etag");
  expect(await waitingDelivery.json()).toMatchObject({ workflowStage: "waiting_delivery", blocker: { kind: "delivery_wait", reason: "checks" }, delivery: { checks: null, waiting: { reason: "checks" } } });
  database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null'), '$.completion', json(?)), updated_at = ? WHERE task_id = ?").run(JSON.stringify({ kind: "workflow", reviewedHead: "a".repeat(40), pullRequestNumber: null, observedAt: "2030-01-01T00:00:01.000Z" }), "2030-01-01T00:00:01.000Z", third.id));
  const completedDelivery = await request(`/api/hermes/tasks/${third.id}`, agentCredential, { "if-none-match": waitingDeliveryEtag! });
  expect(completedDelivery.status).toBe(200);
  expect(await completedDelivery.json()).toMatchObject({ workflowStage: "completed", delivery: { completion: { kind: "workflow", observedAt: "2030-01-01T00:00:01.000Z" } } });
  tasks.repository.controls.cancel(first.id);
  const changed = await request(`/api/hermes/tasks/${first.id}`, agentCredential, { "if-none-match": etag! });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(etag);

  hermes.replaceProjects(adminId, agentId, []);
  expect((await request("/api/hermes/me")).status).toBe(200);
  expect((await (await request("/api/hermes/me")).json() as { projects: unknown[] }).projects).toEqual([]);
  expect(await (await request("/api/hermes/tasks")).json()).toEqual({ tasks: [], nextCursor: null });
  expect((await request(`/api/hermes/tasks/${first.id}`, agentCredential, { "if-none-match": etag! })).status).toBe(404);
});

const duplicateKey = (taskId: string, key: string): string => `duplicate-${createHash("sha256").update(`${taskId}:${key}`).digest("hex")}`;
const revisionOf = (taskId: string): string => tasks.getHermesTask(hermes.authenticate(agentCredential), taskId).revision;
const commandRevision = (taskId: string): number => database.authQuery(db => (db.prepare("SELECT command_revision FROM forge_tasks WHERE id = ?").get(taskId) as { command_revision: number }).command_revision);
const receipt = (taskId: string, key: string) => database.authQuery(db => db.prepare("SELECT result_json FROM forge_hermes_task_command_receipts WHERE agent_id = ? AND task_id = ? AND idempotency_key = ?").get(agentId, taskId, key) as { result_json: string } | undefined);
const auditCount = (action: string, taskId: string): number => database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE actor_agent_id = ? AND action = ? AND metadata_json LIKE ?").get(agentId, action, `%${taskId}%`) as { count: number }).count);
const rowCount = (sql: string, ...params: unknown[]): number => database.authQuery(db => (db.prepare(sql).get(...params as never[]) as { count: number }).count);

/** Builds a second TaskService over the same database, the way a second Forge process or instance would. */
function siblingService(): TaskService {
  return new TaskService(database, auth, projects, config);
}

async function createTask(title: string, idempotencyKey: string): Promise<{ id: string; revision: string }> {
  const response = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title, idempotencyKey } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; revision: string };
}

const command = (taskId: string, payload: object) => app.inject({ method: "POST", url: `/api/hermes/tasks/${taskId}/commands`, headers: { Authorization: `Bearer ${agentCredential}` }, payload });

test("a receipt another writer completed replays on a stale revision without rerunning the effect", async () => {
  const task = await createTask("Completed elsewhere", "completed-elsewhere-001");
  const body = { command: "cancel_task", revision: revisionOf(task.id), idempotencyKey: "elsewhere-cancel" };
  const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const stale = revisionOf(task.id);

  // The other writer cancelled the task and completed its receipt; this request still holds the pre-command revision.
  tasks.repository.controls.cancel(task.id);
  const winner = tasks.getHermesTask(hermes.authenticate(agentCredential), task.id);
  database.authImmediateTransaction(db => {
    db.prepare("UPDATE forge_tasks SET command_revision = command_revision + 1 WHERE id = ?").run(task.id);
    db.prepare("INSERT INTO forge_hermes_task_command_receipts (agent_id, task_id, idempotency_key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(agentId, task.id, body.idempotencyKey, requestHash, JSON.stringify(winner), new Date().toISOString());
  });
  const claimedBefore = commandRevision(task.id);

  const replay = await command(task.id, { ...body, revision: stale });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json()).toEqual(winner);
  // The replay neither reran the effect nor kept a revision claim of its own.
  expect(commandRevision(task.id)).toBe(claimedBefore);
  expect(auditCount("task_cancelled", task.id)).toBe(0);
});

test("concurrent commands admit one, hold the in-flight replay, and report the loser as stale", async () => {
  const task = await createTask("Concurrent commands", "concurrent-commands-001");
  const revision = revisionOf(task.id);
  const held = new Promise<void>(resolve => { inspectionStarted = resolve; });
  let release!: () => void;
  inspectionGate = new Promise<void>(resolve => { release = resolve; });

  const winner = command(task.id, { command: "duplicate_task", revision, idempotencyKey: "concurrent-duplicate" });
  await held;
  const replay = await command(task.id, { command: "duplicate_task", revision, idempotencyKey: "concurrent-duplicate" });
  expect(replay.statusCode).toBe(409);
  expect(replay.json().code).toBe("command_in_progress");
  const loser = await command(task.id, { command: "cancel_task", revision, idempotencyKey: "concurrent-cancel" });
  expect(loser.statusCode).toBe(412);
  expect(loser.json().code).toBe("revision_stale");
  release();
  expect((await winner).statusCode, (await winner).body).toBe(200);
  expect(rowCount("SELECT COUNT(*) AS count FROM forge_tasks WHERE copied_from_task_id = ?", task.id)).toBe(1);

  const conflicting = await command(task.id, { command: "cancel_task", revision: revisionOf(task.id), idempotencyKey: "concurrent-duplicate" });
  expect(conflicting.statusCode).toBe(409);
  expect(conflicting.json().code).toBe("idempotency_conflict");
});

test("duplicates carry the source configuration, attachments, and provenance the project still permits", async () => {
  // A stubbed source resolver keeps this focused on what the duplicate inherits, not on live repository reads.
  const sourceTasks = new TaskService(database, auth, {
    getProject: projects.getProject.bind(projects), getProjectInCompany: projects.getProjectInCompany.bind(projects), captureTaskConfiguration: projects.captureTaskConfiguration.bind(projects),
    async resolveTaskSource() { return { kind: "branch", branch: "feature", headSha: "b".repeat(40) } as never; },
  }, config);
  const principal = hermes.authenticate(agentCredential);
  const created = await sourceTasks.createTaskForHermes(principal, {
    projectId, title: "Source task", description: "Carry me", idempotencyKey: "duplicate-source-001",
    images: [{ filename: "shot.png", mimeType: "image/png", base64: "iVBORw0KGgo=" }], source: { kind: "branch", branch: "feature" }, advisorProfileIds: {},
  });
  const task = created.task;

  const duplicated = await sourceTasks.commandHermesTask(principal, task.id, { command: "duplicate_task", revision: task.revision, idempotencyKey: "duplicate-configuration" });
  const copy = tasks.getTask(adminId, duplicated.id);
  const source = tasks.getTask(adminId, task.id);
  expect(copy.title).toBe("Source task (2)");
  expect(copy.description).toBe("Carry me");
  expect(copy.configuration.source).toEqual({ kind: "branch", branch: "feature" });
  expect(copy.configuration.startingSha).toBe("b".repeat(40));
  expect(copy.workflow).toBe(source.workflow);
  expect(copy.deliveryTarget).toBe(source.deliveryTarget);
  expect(copy.configuration.runProjectTests).toBe(source.configuration.runProjectTests);
  expect(copy.configuration.visualEvidence).toBe(source.configuration.visualEvidence);
  expect(copy.rootProfile.profileId).toBe(source.rootProfile.profileId);
  expect(copy.workerProfile.profileId).toBe(source.workerProfile.profileId);
  expect(copy.advisorProfiles).toEqual(source.advisorProfiles);
  expect(copy.images.map(item => item.filename)).toEqual(["shot.png"]);
  expect(copy.status).toBe("backlog");
  expect(database.authQuery(db => db.prepare("SELECT copied_from_task_id, idempotency_key FROM forge_tasks WHERE id = ?").get(copy.id))).toEqual({ copied_from_task_id: task.id, idempotency_key: duplicateKey(task.id, "duplicate-configuration") });
});

test("delivery rechecks stay bounded to active waiting tasks and never grant human, delivery, or merge powers", async () => {
  const task = await createTask("Recheck target", "recheck-target-001");
  await command(task.id, { command: "start_task", revision: task.revision, idempotencyKey: "recheck-start" });
  expect(tasks.getHermesTask(hermes.authenticate(agentCredential), task.id).permittedCommands).not.toContain("recheck_delivery_wait");

  const setWait = (value: string | null) => database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json(?)), updated_at = ? WHERE task_id = ?").run(value ?? "null", new Date().toISOString(), task.id));
  setWait(JSON.stringify({ headSha: "a".repeat(40), fingerprint: "recheck", since: "2030-01-01T00:00:00.000Z", reason: "checks" }));
  expect(tasks.getHermesTask(hermes.authenticate(agentCredential), task.id).permittedCommands).toContain("recheck_delivery_wait");

  const before = recoveryWakes;
  const recheckBody = { command: "recheck_delivery_wait", revision: revisionOf(task.id), idempotencyKey: "recheck-001" };
  const rechecked = await command(task.id, recheckBody);
  expect(rechecked.statusCode, rechecked.body).toBe(200);
  expect(recoveryWakes).toBe(before + 1);
  expect(auditCount("delivery_wait_recheck_requested", task.id)).toBe(1);
  // A retry of the same request replays the stored receipt: no second audited command, though asking the host
  // to observe delivery again is safe and is not a receipt-guarded effect.
  const replay = await command(task.id, recheckBody);
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(rechecked.json());
  expect(auditCount("delivery_wait_recheck_requested", task.id)).toBe(1);
  expect(recoveryWakes).toBe(before + 2);

  // An archived task is never rechecked, whatever its recorded wait says.
  tasks.repository.setArchived(task.id, true);
  const archived = await command(task.id, { command: "recheck_delivery_wait", revision: revisionOf(task.id), idempotencyKey: "recheck-002" });
  expect(archived.statusCode).toBe(409);
  expect(archived.json().code).toBe("illegal_command");
  tasks.repository.setArchived(task.id, false);

  // Human decisions, delivery, releases and merges remain outside the runtime vocabulary.
  tasks.repository.controls.askHuman(task.id, "Which option do you want?");
  const waiting = tasks.getHermesTask(hermes.authenticate(agentCredential), task.id);
  expect(waiting.permittedCommands).toEqual(["cancel_task", "duplicate_task"]);
  for (const blocked of ["answer_human_question", "deliver_task", "merge_pull_request", "release_task"]) {
    const rejected = await command(task.id, { command: blocked, revision: waiting.revision, idempotencyKey: `blocked-${blocked}` });
    expect(rejected.statusCode, blocked).toBe(400);
    expect(rejected.json().code).toBe("request_invalid");
  }
  expect(rowCount("SELECT COUNT(*) AS count FROM forge_hermes_task_command_receipts WHERE task_id = ? AND idempotency_key LIKE 'blocked-%'", task.id)).toBe(0);
});

test("archiving observes authoritative task state, not pane or session mirrors", async () => {
  const task = await createTask("No mirror archive", "no-mirror-archive-001");
  await command(task.id, { command: "start_task", revision: task.revision, idempotencyKey: "mirror-start" });
  tasks.repository.controls.claimRoot({ taskId: task.id });
  // A restarted Herdr leaves recreated or missing pane tokens behind; they never decide whether archiving is legal.
  database.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET pane_id = ?, native_session_id = NULL WHERE task_id = ?").run("pane-from-a-previous-run", task.id));

  const cancelled = await command(task.id, { command: "cancel_task", revision: revisionOf(task.id), idempotencyKey: "mirror-cancel" });
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  const archived = await command(task.id, { command: "archive_task", revision: revisionOf(task.id), idempotencyKey: "mirror-archive" });
  expect(archived.statusCode, archived.body).toBe(200);
  expect(archived.json()).toMatchObject({ archived: true });
  const unarchived = await command(task.id, { command: "unarchive_task", revision: revisionOf(task.id), idempotencyKey: "mirror-unarchive" });
  expect(unarchived.statusCode, unarchived.body).toBe(200);
  expect(unarchived.json()).toMatchObject({ archived: false });
});

test("a revoked grant stops replays of a completed receipt without changing it", async () => {
  const task = await createTask("Revoked replay", "revoked-replay-001");
  const started = await command(task.id, { command: "start_task", revision: task.revision, idempotencyKey: "revoked-start" });
  expect(started.statusCode, started.body).toBe(200);
  const stored = receipt(task.id, "revoked-start")!;

  hermes.replaceProjects(adminId, agentId, []);
  const denied = await command(task.id, { command: "start_task", revision: task.revision, idempotencyKey: "revoked-start" });
  expect(denied.statusCode).toBe(404);
  expect(denied.json().code).toBe("not_found");
  expect(receipt(task.id, "revoked-start")).toEqual(stored);
});

test("delivery rechecks follow the authoritative wait: an unchanged observation keeps it, a changed one ends it", async () => {
  const task = await createTask("Recheck observation", "recheck-observation-001");
  await command(task.id, { command: "start_task", revision: task.revision, idempotencyKey: "observation-start" });
  const wait = { headSha: "a".repeat(40), fingerprint: "checks-pending", since: "2030-01-01T00:00:00.000Z", reason: "checks" as const };
  database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json(?)), updated_at = ? WHERE task_id = ?").run(JSON.stringify(wait), new Date().toISOString(), task.id));

  const rechecked = await command(task.id, { command: "recheck_delivery_wait", revision: revisionOf(task.id), idempotencyKey: "observation-recheck" });
  expect(rechecked.statusCode, rechecked.body).toBe(200);
  expect(rechecked.json()).toMatchObject({ workflowStage: "waiting_delivery", blocker: { kind: "delivery_wait", reason: "checks" } });

  // The observation came back unchanged: its fingerprint no longer matches, so the domain refuses to end the wait.
  expect(tasks.repository.controls.clearDeliveryWait(task.id, { ...wait, fingerprint: "an-older-observation" })).toBe(false);
  expect(tasks.getHermesTask(hermes.authenticate(agentCredential), task.id).permittedCommands).toContain("recheck_delivery_wait");

  // The observation changed: the domain clears exactly the wait it observed, and the recheck is no longer offered.
  expect(tasks.repository.controls.clearDeliveryWait(task.id, wait)).toBe(true);
  const cleared = tasks.getHermesTask(hermes.authenticate(agentCredential), task.id);
  expect(cleared.blocker).toBeNull();
  expect(cleared.permittedCommands).not.toContain("recheck_delivery_wait");
  const late = await command(task.id, { command: "recheck_delivery_wait", revision: cleared.revision, idempotencyKey: "observation-late" });
  expect(late.statusCode).toBe(409);
  expect(late.json().code).toBe("illegal_command");

  // A delivery that needs a person becomes a human question, and the agent still holds no power to answer it.
  tasks.repository.controls.claimRoot({ taskId: task.id });
  database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json(?)), updated_at = ? WHERE task_id = ?").run(JSON.stringify(wait), new Date().toISOString(), task.id));
  expect(tasks.repository.controls.failDeliveryWait(task.id, wait, "Delivery checks failed. How do you want to continue?")).toBe(true);
  const blocked = tasks.getHermesTask(hermes.authenticate(agentCredential), task.id);
  expect(blocked).toMatchObject({ workflowStage: "waiting_human", blocker: { kind: "human_question" } });
  expect(blocked.permittedCommands).toEqual(["cancel_task", "duplicate_task"]);
});

/** A cancelled task with a recorded worktree, ready to be archived. */
async function archivableTask(title: string, key: string, service: TaskService = tasks): Promise<{ id: string; worktree: WorktreeReference }> {
  const principal = hermes.authenticate(agentCredential);
  const created = await service.createTaskForHermes(principal, { projectId, title, idempotencyKey: key, images: [], advisorProfileIds: {} });
  const id = created.task.id;
  service.repository.controls.start(id);
  const worktree = { path: join(root, "worktrees", "project1", id), branch: `task/${key}`, baseSha: "a".repeat(40), headSha: "b".repeat(40), dirty: false };
  service.repository.controls.setWorktree(id, worktree);
  service.repository.controls.cancel(id);
  return { id, worktree };
}

test("a start during archive cleanup is refused by every authority, and the archive then completes once", async () => {
  let reachedCleanup!: () => void;
  const cleanupStarted = new Promise<void>(resolve => { reachedCleanup = resolve; });
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const removals: string[] = [];
  const archiving = new TaskService(database, auth, projects, config, {
    async removeWorktree(intent, _reference, _confirm, authorize) {
      reachedCleanup();
      await cleanupGate;
      authorize();
      removals.push(intent.taskId);
      return { status: "cleaned" };
    },
  });
  // A backlog task is both archivable and startable, so every refusal below comes from the cleanup guard itself.
  const principal = hermes.authenticate(agentCredential);
  const task = (await archiving.createTaskForHermes(principal, { projectId, title: "Cleanup exclusion", idempotencyKey: "cleanup-exclusion-001", images: [], advisorProfileIds: {} })).task;
  expect(archiving.getHermesTask(principal, task.id).permittedCommands).toContain("start_task");

  // The archive is genuinely mid-cleanup when every start path tries to reactivate.
  const dispatching = archiving.commandHermesTask(principal, task.id, { command: "archive_task", revision: archiving.getHermesTask(principal, task.id).revision, idempotencyKey: "cleanup-archive" });
  await cleanupStarted;
  expect(() => tasks.startTask(adminId, task.id)).toThrow("Archive cleanup is in progress");
  const agentStart = await command(task.id, { command: "start_task", revision: revisionOf(task.id), idempotencyKey: "cleanup-agent-start" });
  expect(agentStart.statusCode, agentStart.body).toBe(409);
  expect(agentStart.json()).toMatchObject({ error: "Archive cleanup is in progress", code: "illegal_command" });
  expect(tasks.getTask(adminId, task.id).status).toBe("backlog");
  expect(receipt(task.id, "cleanup-agent-start")).toBeUndefined();

  releaseCleanup();
  const archived = await dispatching;
  expect(archived).toMatchObject({ archived: true });
  expect(removals).toEqual([task.id]);
  expect(tasks.getTask(adminId, task.id).status).toBe("backlog");
  expect(auditCount("task_archived", task.id)).toBe(1);
});

test("a dirty worktree stops the agent archive with no effect, and only a human confirmation discards it", async () => {
  let confirmed = false;
  const archiving = new TaskService(database, auth, projects, config, {
    async removeWorktree(_intent, _reference, confirmDiscardDirty) {
      if (!confirmDiscardDirty) return { status: "confirmation_required", dirtyFileCount: 2, dirtyFilePaths: ["notes.md", "scratch.txt"] };
      confirmed = true;
      return { status: "cleaned" };
    },
  });
  const task = await archivableTask("Dirty cleanup", "dirty-cleanup-001", archiving);
  const principal = hermes.authenticate(agentCredential);

  // The agent has no power to discard a person's uncommitted work, so its archive stops with nothing changed.
  await expect(archiving.commandHermesTask(principal, task.id, { command: "archive_task", revision: archiving.getHermesTask(principal, task.id).revision, idempotencyKey: "dirty-archive" }))
    .rejects.toMatchObject({ statusCode: 409, code: "illegal_command", publicMessage: "Discard dirty worktree changes before archiving" });
  expect(confirmed).toBe(false);
  expect(tasks.getTask(adminId, task.id)).toMatchObject({ archivedAt: null });
  expect(tasks.getTask(adminId, task.id).worktree).toEqual(task.worktree);
  expect(receipt(task.id, "dirty-archive")).toBeUndefined();
  expect(auditCount("task_archived", task.id)).toBe(0);

  // A person sees the same dirty files, and only their explicit confirmation discards them.
  expect(await archiving.archiveTask(adminId, task.id)).toMatchObject({ status: "confirmation_required", dirtyFileCount: 2, dirtyFilePaths: ["notes.md", "scratch.txt"] });
  expect(await archiving.archiveTask(adminId, task.id, true)).toMatchObject({ archivedAt: expect.any(String) });
  expect(confirmed).toBe(true);
  expect(tasks.getTask(adminId, task.id).worktree).toBeNull();
});

test("identical concurrent requests for one key produce one effect and replay the same completed result", async () => {
  const task = await createTask("Concurrent identical", "concurrent-identical-001");
  const principal = hermes.authenticate(agentCredential);
  const service = siblingService();
  const body = { command: "cancel_task", revision: revisionOf(task.id), idempotencyKey: "identical-cancel" };
  const before = commandRevision(task.id);

  // Both calls read no receipt, then the winner commits before the loser reaches its own admission.
  const [first, second] = await Promise.all([
    service.commandHermesTask(principal, task.id, body),
    service.commandHermesTask(principal, task.id, body),
  ]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ status: "cancelled" });
  // One effect, one audit, one receipt, and exactly one revision claim: the loser replayed without writing.
  expect(auditCount("task_cancelled", task.id)).toBe(1);
  expect(receipt(task.id, "identical-cancel")).toBeDefined();
  expect(commandRevision(task.id)).toBe(before + 1);
  expect(rowCount("SELECT COUNT(*) AS count FROM forge_hermes_task_command_receipts WHERE task_id = ?", task.id)).toBe(1);

  // A different key on the now-stale revision is still stale, and a mismatched payload on this key is still a conflict.
  const stale = await command(task.id, { command: "cancel_task", revision: body.revision, idempotencyKey: "identical-other-key" });
  expect(stale.statusCode).toBe(412);
  expect(stale.json().code).toBe("revision_stale");
  const mismatched = await command(task.id, { command: "archive_task", revision: revisionOf(task.id), idempotencyKey: "identical-cancel" });
  expect(mismatched.statusCode).toBe(409);
  expect(mismatched.json().code).toBe("idempotency_conflict");
  expect(auditCount("task_cancelled", task.id)).toBe(1);
});

const createDependencyTask = async (title: string, idempotencyKey: string, dependsOn?: string[]) => {
  const response = await app.inject({
    method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` },
    payload: { projectId, title, idempotencyKey, ...(dependsOn ? { dependsOn } : {}) },
  });
  return response;
};

test("task dependencies are declared on create, replaced through the agent route, and visible on the projection", async () => {
  const first = await createDependencyTask("Dependency root", "dependency-root-001");
  expect(first.statusCode, first.body).toBe(201);
  const firstId = first.json().id as string;

  const second = await createDependencyTask("Dependency follower", "dependency-follower-001", [firstId]);
  expect(second.statusCode, second.body).toBe(201);
  expect(second.json()).toMatchObject({ dependsOn: [firstId], blockedBy: [{ id: firstId, title: "Dependency root", status: "backlog" }] });
  const secondId = second.json().id as string;
  expect(tasks.getTask(adminId, secondId)).toMatchObject({ dependsOn: [firstId], blockedBy: [{ id: firstId, title: "Dependency root", status: "backlog" }] });

  const third = await createDependencyTask("Dependency third", "dependency-third-001");
  const thirdId = third.json().id as string;
  const replaced = await app.inject({
    method: "PUT", url: `/api/hermes/tasks/${thirdId}/dependencies`,
    headers: { Authorization: `Bearer ${agentCredential}` }, payload: { dependsOn: [secondId, firstId] },
  });
  expect(replaced.statusCode, replaced.body).toBe(200);
  const both = [{ id: firstId, title: "Dependency root", status: "backlog" }, { id: secondId, title: "Dependency follower", status: "backlog" }].sort((left, right) => left.id.localeCompare(right.id));
  expect(replaced.json()).toMatchObject({ dependsOn: both.map(task => task.id), blockedBy: both });
  // Every reader reports the same edges: the agent read, the board task, and its HTTP read.
  const agentRead = await app.inject({ method: "GET", url: `/api/hermes/tasks/${thirdId}`, headers: { Authorization: `Bearer ${agentCredential}` } });
  expect(agentRead.json()).toMatchObject({ dependsOn: both.map(task => task.id), blockedBy: both });
  expect(tasks.getTask(adminId, thirdId)).toMatchObject({ dependsOn: both.map(task => task.id), blockedBy: both });

  // Removing one prerequisite keeps the other.
  const removed = await app.inject({
    method: "PUT", url: `/api/hermes/tasks/${thirdId}/dependencies`,
    headers: { Authorization: `Bearer ${agentCredential}` }, payload: { dependsOn: [secondId] },
  });
  expect(removed.json()).toMatchObject({ dependsOn: [secondId], blockedBy: [{ id: secondId, title: "Dependency follower", status: "backlog" }] });

  const cleared = await app.inject({
    method: "PUT", url: `/api/hermes/tasks/${thirdId}/dependencies`,
    headers: { Authorization: `Bearer ${agentCredential}` }, payload: { dependsOn: [] },
  });
  expect(cleared.json()).toMatchObject({ dependsOn: [], blockedBy: [] });

  // The user route replaces the same edges under user authority, and the agent reads that edit back.
  expect(tasks.setTaskDependencies(adminId, thirdId, [firstId]).dependsOn).toEqual([firstId]);
  const afterHumanEdit = await app.inject({ method: "GET", url: `/api/hermes/tasks/${thirdId}`, headers: { Authorization: `Bearer ${agentCredential}` } });
  expect(afterHumanEdit.json()).toMatchObject({ dependsOn: [firstId], blockedBy: [{ id: firstId, title: "Dependency root", status: "backlog" }] });
});

test("a cycle, a self-dependency, and a dependency outside the agent scope are rejected", async () => {
  const first = await createDependencyTask("Cycle a", "cycle-a-001");
  const second = await createDependencyTask("Cycle b", "cycle-b-001");
  const firstId = first.json().id as string;
  const secondId = second.json().id as string;
  const dependencies = (taskId: string, dependsOn: string[], credential = agentCredential) => app.inject({
    method: "PUT", url: `/api/hermes/tasks/${taskId}/dependencies`,
    headers: { Authorization: `Bearer ${credential}` }, payload: { dependsOn },
  });

  expect((await dependencies(secondId, [firstId])).statusCode).toBe(200);
  const cycle = await dependencies(firstId, [secondId]);
  expect(cycle.statusCode).toBe(422);
  expect(cycle.json().error).toBe("The dependency creates a cycle");
  expect(tasks.getTask(adminId, firstId).dependsOn).toEqual([]);

  const self = await dependencies(firstId, [firstId]);
  expect(self.statusCode).toBe(422);
  expect(self.json().error).toBe("A task cannot depend on itself");

  // Another agent's task is not enumerable, so it cannot become a dependency.
  const otherIssued = hermes.create(adminId, { name: "Scope Bot", companyId, projectIds: [projectId] });
  const otherCredential = hermes.exchange({ pairingCode: otherIssued.pairingCode, profileId: "profile-scope" }).credential;
  const foreign = await app.inject({
    method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${otherCredential}` },
    payload: { projectId, title: "Foreign task", idempotencyKey: "foreign-task-001" },
  });
  const outOfScope = await dependencies(firstId, [foreign.json().id as string]);
  expect(outOfScope.statusCode).toBe(404);
  expect(tasks.getTask(adminId, firstId).dependsOn).toEqual([]);

  const unknown = await dependencies(firstId, ["task_unknown"]);
  expect(unknown.statusCode).toBe(404);

  // Unsupported dependency input is rejected, never ignored.
  const legacyUpdate = await app.inject({ method: "PUT", url: `/api/hermes/tasks/${firstId}/dependencies`, headers: { Authorization: `Bearer ${agentCredential}` }, payload: { dependsOn: [], blockedByTaskId: secondId } });
  expect(legacyUpdate.statusCode).toBe(400);
  expect(legacyUpdate.json().code).toBe("request_invalid");
  const legacyCreate = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Legacy", idempotencyKey: "legacy-blocked-by-001", blockedByTaskId: secondId } });
  expect(legacyCreate.statusCode).toBe(400);
  expect(legacyCreate.json().code).toBe("request_invalid");
  expect(tasks.getTask(adminId, firstId).dependsOn).toEqual([]);
});

test("configured agent delivery reports delivery, merge, and the agent delivery commands", async () => {
  const health = {
    database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Ready", details: {} }),
    artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Ready", details: {} }),
    opencode: async () => ({ id: "opencode" as const, label: "OpenCode", status: "healthy" as const, summary: "Ready", details: {} }),
    ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
  };
  const config = createTestConfig(root, { repositoryRoot: join(root, "repositories"), worktreeRoot: join(root, "worktrees"), reachableAddress: "http://127.0.0.1:4111", developmentAutoLogin: true });
  const read = (instance: ReturnType<typeof createApp>) => instance.inject({ method: "GET", url: "/api/hermes/capabilities", headers: { Authorization: `Bearer ${agentCredential}` } });

  const unconfigured = await read(app);
  expect(unconfigured.json()).toMatchObject({ capabilities: { delivery: false, merge: false, humanDecisions: false } });
  expect(unconfigured.json().unavailableCommands).toContain("merge_pull_request");

  const store = tasks.repository.controls;
  const agentDelivery = new AgentDeliveryService({ database, tasks, store, delivery: new DeliveryOperations(store), auth });
  const configured = createApp({ config, auth, projects, tasks, hermes, agentDelivery, health });
  try {
    const response = await read(configured);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ capabilities: { read: { task: true }, create: { backlogTask: true }, taskControl: true, delivery: true, merge: true, humanDecisions: false } });
    expect(response.json().unavailableCommands).toEqual(["answer_human_question", "deliver_task"]);
    expect(response.json().autonomousCommands).toEqual(expect.arrayContaining(["observe_delivery", "request_delivery_repair", "decide_delivery_wait", "read_merge_train", "request_merge_approval", "merge_pull_request"]));

    // The published contract still describes the reply it now sends.
    const document = (await configured.inject({ method: "GET", url: "/api/hermes/openapi.json", headers: { Authorization: `Bearer ${agentCredential}` } })).json() as { paths: Record<string, { get?: { responses: Record<string, { content: { "application/json": { schema: unknown } } }> } }> };
    validateDocumentSchema(response.json(), document.paths["/api/hermes/capabilities"]!.get!.responses["200"]!.content["application/json"].schema);
  } finally {
    await configured.close();
  }
});

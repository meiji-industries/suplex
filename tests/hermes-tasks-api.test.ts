import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, test } from "vitest";
import { Ajv, type AnySchema } from "ajv";
import SwaggerParser from "@apidevtools/swagger-parser";

import { AuthService } from "../src/identity/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import type { ForgeConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import type { GithubAdapter } from "../src/integrations/github/client.js";
import { HermesAgentService } from "../src/identity/hermes-agents.js";
import { SESSION_COOKIE_NAME } from "../src/identity/auth-identifiers.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects/projects.js";
import { TaskService } from "../src/tasks/tasks.js";
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
    host: { async recover() { recoveryWakes++; } },
    health: {
      database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
      artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
      opencode: async () => ({ id: "opencode", label: "OpenCode", status: "healthy", summary: "Ready", details: {} }),
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
  expect(Object.keys(document.paths).sort()).toEqual(["/api/hermes/capabilities", "/api/hermes/openapi.json", "/api/hermes/tasks", "/api/hermes/tasks/{taskId}"].sort());
  expect(JSON.stringify(document)).not.toMatch(/pairingCode|credentialCreatedAt|credential_hash|board session/i);
  const createOperation = (document.paths["/api/hermes/tasks"] as CreateOperationDocument).post;
  expect(createOperation.requestBody.content["application/json"].schema.required).toEqual(expect.arrayContaining(["projectId", "title", "idempotencyKey"]));
  expect(createOperation.requestBody.content["application/json"].schema.properties.description.default).toBe("");
  expect(createOperation.responses["201"].content["application/json"].schema.properties.status.enum).toContain("waiting_human");

  const capabilities = await app.inject({ method: "GET", url: "/api/hermes/capabilities", headers: { Authorization: `Bearer ${agentCredential}` } });
  expect(capabilities.statusCode).toBe(200);
  expect(capabilities.json()).toMatchObject({
    apiVersion: "v1",
    capabilities: { read: { task: true }, create: { backlogTask: true }, taskControl: false, delivery: false, merge: false, humanDecisions: false },
    pagination: { supported: false, cursor: false },
  });
  expect(capabilities.json().unavailableCommands).toContain("answer_human_question");

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
    opencode: async () => ({ id: "opencode", label: "OpenCode", status: "healthy", summary: "Ready", details: {} }),
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
  const expectedKeys = ["id", "issueKey", "projectId", "project", "title", "status", "archived", "revision", "permittedCommands", "humanQuestion", "blocker", "workflowStage", "workflow", "delivery", "createdAt", "updatedAt"].sort();
  expect(Object.keys(body).sort()).toEqual(expectedKeys);
  expect(body).toMatchObject({
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
  expect(replay.json()).toEqual(body);
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
  expect(rich.json()).toMatchObject({ workflow: "direct_build" });
  expect(database.authQuery(db => db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts").get())).toEqual({ count: 1 });

  const templated = await request({ projectId, title: "Template task", idempotencyKey: "hermes-template-001", templateId: "template_hermes_direct" });
  expect(templated.statusCode, templated.body).toBe(201);
  expect(templated.json().workflow).toBe("direct_build");

  const denied = await request({ projectId, title: "Denied workflow", idempotencyKey: "hermes-denied-001", workflowId: "workflow_native_independent_review" });
  expect(denied.statusCode).toBe(422);
  const badImage = await request({ projectId, title: "Bad image", idempotencyKey: "hermes-bad-image-001", images: [{ filename: "bad.png", mimeType: "image/png", base64: "aGVsbG8=" }] });
  expect(badImage.statusCode).toBe(422);
  const badFields = await request({ projectId, title: "Bad fields", idempotencyKey: "hermes-bad-fields-001", repositoryPath: "/private/path" });
  expect(badFields.statusCode).toBe(400);
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
  expect((await request({ projectId, title: "Bad choice", idempotencyKey: "bad-choice-001", workflowId: "unknown" })).statusCode).toBe(422);
  expect((await request({ projectId, title: "Bad profile", idempotencyKey: "bad-profile-001", rootProfileId: "profile_native_worker" })).statusCode).toBe(422);
  expect((await request({ projectId, title: "Bad delivery", idempotencyKey: "bad-delivery-001", deliveryTarget: "merged" })).statusCode).toBe(422);
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
  expect((await request({ projectId, title: "Tests disabled", idempotencyKey: "tests-disabled-001", runProjectTests: false })).statusCode).toBe(422);
  database.authTransaction(db => db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES ('template_disallowed', ?, 'Disallowed', ?, ?, ?)").run(projectId, JSON.stringify({ name: "Disallowed", description: "", workflow: "standard", advisorProfileIds: {} }), new Date().toISOString(), new Date().toISOString()));
  for (const templateId of ["template_missing", "template_disallowed"]) expect((await request({ projectId, title: "Unavailable template", idempotencyKey: `template-${templateId}`, templateId })).statusCode).toBe(422);
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

test("project policy owns the default workflow and implicit Advisor profile", async () => {
  const update = async (agentTaskPolicy: ProjectAgentTaskPolicy) => {
    const current = projects.getProject(adminId, projectId);
    await projects.updateProject(adminId, projectId, { name: current.name, repositoryPath: current.repositoryPath, worktreeRoot: current.worktreeRoot, repository: current.repository!, baseBranch: current.baseBranch, setupCommand: current.setupCommand, verificationCommand: current.verificationCommand, rootProfileId: current.rootProfileId, workerProfileId: current.workerProfileId, agentTaskPolicy });
  };
  await update({ workflowIds: ["workflow_native_direct_build"], defaultWorkflowId: "workflow_native_direct_build", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
  const direct = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Policy default", idempotencyKey: "hermes-policy-default-001" } });
  expect(direct.statusCode, direct.body).toBe(201);
  expect(direct.json().workflow).toBe("direct_build");

  await update({ workflowIds: ["workflow_native_independent_review"], defaultWorkflowId: "workflow_native_independent_review", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
  const denied = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Implicit advisor", idempotencyKey: "hermes-policy-advisor-denied" } });
  expect(denied.statusCode).toBe(422);

  await update({ workflowIds: ["workflow_native_independent_review"], defaultWorkflowId: "workflow_native_independent_review", templateIds: [], rootProfileIds: ["profile_native_root"], workerProfileIds: ["profile_native_worker"], advisorProfileIds: { reviewer: ["profile_native_root"], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
  const allowed = await app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${agentCredential}` }, payload: { projectId, title: "Implicit advisor allowed", idempotencyKey: "hermes-policy-advisor-allowed" } });
  expect(allowed.statusCode, allowed.body).toBe(201);
  expect(allowed.json()).toMatchObject({ workflow: "independent_review" });

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
  const expectedKeys = ["id", "issueKey", "projectId", "project", "title", "status", "archived", "revision", "permittedCommands", "humanQuestion", "blocker", "workflowStage", "workflow", "delivery", "createdAt", "updatedAt"].sort();
  expect(Object.keys(getSuccess.json()).sort()).toEqual(expectedKeys);
  expect(getSuccess.json().title).toBe("Task For Status Check");

  // GET by a different agent returns 404
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
  expect(await identity.json()).toMatchObject({ agent: { id: agentId, name: "Hermes Bot", profileId: "profile-bot" }, capabilities: { taskDiscovery: true, taskRead: true, taskCreate: true, taskCommands: [] }, projects: [{ id: projectId, name: "Hermes Project" }] });

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
    opencode: async () => ({ id: "opencode", label: "OpenCode", status: "healthy", summary: "Ready", details: {} }),
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

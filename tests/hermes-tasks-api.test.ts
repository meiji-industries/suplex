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
import { ForgeDatabase } from "../src/platform/database.js";
import type { GithubAdapter } from "../src/integrations/github/client.js";
import { HermesAgentService } from "../src/identity/hermes-agents.js";
import { SESSION_COOKIE_NAME } from "../src/identity/auth-identifiers.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects/projects.js";
import { TaskService } from "../src/tasks/tasks.js";

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
      remoteRepository: input.repositoryPath.includes("project2") ? "meiji/other-test" : input.repositoryPath.includes("project3") ? "meiji/hermes-cross-company-test" : "meiji/hermes-test",
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
let agentCredential: string;
let agentId: string;
let recoveryWakes: number;

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
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111", developmentAutoLogin: true });
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
  const unmatched = await app.inject({ method: "GET", url: "/api/hermes/tasks" });
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
  const expectedKeys = ["id", "issueKey", "projectId", "title", "status", "humanQuestion", "createdAt", "updatedAt"].sort();
  expect(Object.keys(body).sort()).toEqual(expectedKeys);
  expect(body).toMatchObject({
    issueKey: "HMC-1",
    projectId,
    title: "Hermes task creation",
    status: "backlog",
    humanQuestion: null,
  });

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

  // GET by creator agent succeeds
  const getSuccess = await app.inject({
    method: "GET",
    url: `/api/hermes/tasks/${taskId}`,
    headers: { Authorization: `Bearer ${agentCredential}` },
  });
  expect(getSuccess.statusCode).toBe(200);
  expect(getSuccess.headers["cache-control"]).toBe("private, no-store");
  const expectedKeys = ["id", "issueKey", "projectId", "title", "status", "humanQuestion", "createdAt", "updatedAt"].sort();
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
  const getAfterRevocation = await app.inject({
    method: "GET",
    url: `/api/hermes/tasks/${taskId}`,
    headers: { Authorization: `Bearer ${agentCredential}` },
  });
  expect(getAfterRevocation.statusCode).toBe(404);
});

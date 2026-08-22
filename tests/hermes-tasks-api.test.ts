import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { GithubAdapter } from "../src/github.js";
import { HermesAgentService } from "../src/hermes-agents.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import { TaskService } from "../src/tasks.js";
import { IssueProjectionEventSchema } from "../src/temporal/issue-contracts.js";
import { createWorkflowPortFake } from "./fakes/workflow-port.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

const localRepository: LocalRepositoryAdapter = {
  async inspect(input) {
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
let workflowStarts: number;

beforeEach(async () => {
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

  const profile = projects.createProfile(adminId, { name: "Hermes test profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const planner = projects.createAgent(adminId, { name: "Planner", role: "planner", profileId: profile.id });
  const builder = projects.createAgent(adminId, { name: "Builder", role: "builder", profileId: profile.id });
  const reviewer = projects.createAgent(adminId, { name: "Reviewer", role: "reviewer", profileId: profile.id });

  const project = await projects.createProject(adminId, companyId, {
    name: "Hermes Project",
    repositoryPath,
    worktreeRoot: project1Worktrees,
    repository: "meiji/hermes-test",
    baseBranch: "main",
    targetBranch: "main",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    requiredChecks: ["Tests / unit"],
    roleDefaults: { planner: planner.id, reviewer: reviewer.id, builder: builder.id },
  });
  const active = await projects.activateProject(adminId, project.id);
  projectId = active.id;

  const otherProj = await projects.createProject(adminId, companyId, {
    name: "Other Project",
    repositoryPath: otherRepoPath,
    worktreeRoot: otherWorktrees,
    repository: "meiji/other-test",
    baseBranch: "main",
    targetBranch: "main",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    requiredChecks: ["Tests / unit"],
    roleDefaults: { planner: planner.id, reviewer: reviewer.id, builder: builder.id },
  });
  const activeOther = await projects.activateProject(adminId, otherProj.id);
  otherProjectId = activeOther.id;

  const crossCompany = auth.createCompany(adminId, "Hermes Other Company");
  const crossProject = await projects.createProject(adminId, crossCompany.id, {
    name: "Cross Company Project",
    repositoryPath: crossRepoPath,
    worktreeRoot: crossWorktrees,
    repository: "meiji/hermes-cross-company-test",
    baseBranch: "main",
    targetBranch: "main",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    requiredChecks: ["Tests / unit"],
    roleDefaults: { planner: planner.id, reviewer: reviewer.id, builder: builder.id },
  });
  crossCompanyProjectId = (await projects.activateProject(adminId, crossProject.id)).id;

  const workflow = createWorkflowPortFake({
    companyId,
    projectId,
    projectRevisionId: active.activeRevisionId!,
    projectState: (state) => {
      database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state }));
      return state;
    },
  });
  workflowStarts = 0;
  const start = workflow.start;
  workflow.start = async (input) => {
    workflowStarts += 1;
    return start(input);
  };
  tasks = new TaskService(database, auth, projects, config, { workflow });
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
    health: {
      temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }),
      database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
      artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
      worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }),
      codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }),
      ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
    },
  });
});

afterEach(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("POST /api/hermes/tasks creates task with 9-field projection, private no-store headers, and records creator attribution", async () => {
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
  const expectedKeys = ["id", "issueKey", "projectId", "title", "phase", "revision", "pendingAction", "createdAt", "updatedAt"].sort();
  expect(Object.keys(body).sort()).toEqual(expectedKeys);
  expect(body).toMatchObject({
    issueKey: "HMC-1",
    projectId,
    title: "Hermes task creation",
    phase: "backlog",
    revision: 0,
    pendingAction: "Start planning",
  });

  // Verify creator_agent_id persisted on task and intent
  const taskRow = database.authQuery((db) => db.prepare("SELECT creator_agent_id FROM forge_tasks WHERE id = ?").get(body.id) as { creator_agent_id: string | null });
  expect(taskRow.creator_agent_id).toBe(agentId);

  const intentRow = database.authQuery((db) => db.prepare("SELECT creator_agent_id FROM forge_task_creation_intents WHERE task_id = ?").get(body.id) as { creator_agent_id: string | null });
  expect(intentRow.creator_agent_id).toBe(agentId);

  // Verify activity log resolves creator as an agent
  const fullTask = tasks.getTask(adminId, body.id);
  const createdActivity = fullTask.activity.find((a) => a.eventType === "task_created");
  expect(createdActivity?.actor).toMatchObject({
    kind: "agent",
    id: agentId,
    displayName: "Hermes Bot",
  });

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
  expect(count("forge_task_creation_intents")).toBe(1);
  expect(count("forge_artifacts")).toBe(1);
  expect(count("forge_issue_projections")).toBe(1);
  expect(count("forge_workflow_snapshots")).toBe(1);
  expect(count("forge_issue_timeline")).toBe(1);
  expect(count("forge_audit_events", "WHERE action = 'task_created'")).toBe(1);
  expect(workflowStarts).toBe(1);
});


test("cross-company and out-of-grant projects are non-enumerating with zero side effects", async () => {
  const counts = (): Record<string, number> => Object.fromEntries([
    "forge_task_creation_intents", "forge_tasks", "forge_artifacts", "forge_issue_projections", "forge_workflow_snapshots", "forge_issue_timeline",
  ].map((table) => [table, database.authQuery((db) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]).concat([["task_created_audits", database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action = 'task_created'").get() as { count: number }).count)], ["workflow_starts", workflowStarts]]));
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
  const expectedKeys = ["id", "issueKey", "projectId", "title", "phase", "revision", "pendingAction", "createdAt", "updatedAt"].sort();
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

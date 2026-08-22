import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService, parseGithubRepositoryUrl, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";

interface Fixture {
  root: string;
  database: ForgeDatabase;
  auth: AuthService;
  projects: ProjectService;
  adminId: string;
  companyId: string;
  profileId: string;
  roleDefaults: { planner: string; builder: string; reviewer: string };
  repositoryPath: string;
  worktreeRoot: string;
}

const localRepository: LocalRepositoryAdapter = {
  async inspect(input) {
    const identity = input.repositoryPath.includes("unavailable") ? "acme/unavailable" : input.repositoryPath.includes("cross") ? "acme/cross" : "acme/forge";
    return { canonicalPath: input.repositoryPath, remoteRepository: identity, clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) };
  },
};

const github: GithubAdapter = {
  async checkAuthentication() {},
  async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; },
  async listChecks() { return [{ name: "Tests / unit", status: "completed", conclusion: "success" }]; },
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "forge-project-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot, worktreeRoot });
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "Acme");
  const profile = projects.createProfile("admin-1", { name: "Default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const planner = projects.createAgent("admin-1", { name: "Planner", role: "planner", profileId: profile.id });
  const builder = projects.createAgent("admin-1", { name: "Builder", role: "builder", profileId: profile.id });
  const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
  return { root, database, auth, projects, adminId: "admin-1", companyId: company.id, profileId: profile.id, roleDefaults: { planner: planner.id, builder: builder.id, reviewer: reviewer.id }, repositoryPath, worktreeRoot };
}

async function close(value: Fixture): Promise<void> {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

function input(value: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    name: "Forge project",
    repositoryPath: value.repositoryPath,
    worktreeRoot: value.worktreeRoot,
    repository: "acme/forge",
    baseBranch: "main",
    targetBranch: "main",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    requiredChecks: ["Tests / unit"],
    roleDefaults: value.roleDefaults,
    ...overrides,
  };
}

test("normalizes supported GitHub repository URLs", () => {
  for (const repositoryUrl of [
    "https://github.com/meiji-industries/sampler",
    "https://github.com/meiji-industries/sampler.git",
    "git@github.com:meiji-industries/sampler.git",
  ]) {
    expect(parseGithubRepositoryUrl(repositoryUrl)).toMatchObject({ repository: "meiji-industries/sampler", name: "sampler" });
  }
  expect(parseGithubRepositoryUrl("git@github.com:meiji-industries/sampler.git").cloneUrl).toBe("git@github.com:meiji-industries/sampler.git");
  expect(() => parseGithubRepositoryUrl("https://token@github.com/meiji-industries/sampler.git")).toThrowError("GitHub repository URL is invalid");
  expect(() => parseGithubRepositoryUrl("https://gitlab.com/meiji-industries/sampler.git")).toThrowError("GitHub repository URL is invalid");
});

test("maintains the model catalog and only creates profiles from active models", async () => {
  const value = await fixture();
  try {
    expect(value.projects.listModels(value.adminId).map((model) => model.id)).toContain("gpt-5.6-sol");
    const custom = value.projects.createModel(value.adminId, { id: "acme-codex-1", displayName: "Acme Codex 1" });
    expect(custom).toMatchObject({ id: "acme-codex-1", status: "active" });
    expect(value.projects.createProfile(value.adminId, { name: "Custom", model: custom.id, reasoningLevel: "high", servicePriority: "priority", capacity: 1 })).toMatchObject({ model: custom.id });
    value.projects.setModelStatus(value.adminId, custom.id, "retired");
    expect(value.projects.listModels(value.adminId).map((model) => model.id)).not.toContain(custom.id);
    expect(value.projects.listModels(value.adminId, true)).toEqual(expect.arrayContaining([expect.objectContaining({ id: custom.id, status: "retired" })]));
    expect(() => value.projects.createProfile(value.adminId, { name: "Retired", model: custom.id, reasoningLevel: "medium", servicePriority: "standard", capacity: 1 })).toThrowError("Profile configuration is invalid");
  } finally {
    await close(value);
  }
});

test("preserves inherited capacity and applies integer profile overrides", async () => {
  const value = await fixture();
  try {
    expect(value.projects.createProfile(value.adminId, { name: "Inherited", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard" })).toMatchObject({ capacity: null, effectiveCapacity: 2 });
    const explicitNull = value.projects.createProfile(value.adminId, { name: "Explicit default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: null });
    expect(explicitNull).toMatchObject({ capacity: null, effectiveCapacity: 2 });
    const patched = value.projects.updateProfileCapacity(value.adminId, explicitNull.id, 3);
    expect(patched).toMatchObject({ capacity: 3, effectiveCapacity: 3 });
    expect(value.projects.updateProfileCapacity(value.adminId, explicitNull.id, null)).toMatchObject({ capacity: null, effectiveCapacity: 2 });
  } finally {
    await close(value);
  }
});

test("sorts agents by active execution count", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    const now = new Date().toISOString();
    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-agent-leaderboard', ?, 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'brief-agent-leaderboard.md', ?)").run(value.companyId, "a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-agent-leaderboard', ?, ?, 'Agent leaderboard', 'brief-agent-leaderboard', '[]', ?, 0, 'workflow-agent-leaderboard', 'revision-agent-leaderboard', 'agent-leaderboard', ?, ?)").run(value.companyId, project.id, JSON.stringify(value.roleDefaults), now, now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, finished_at, heartbeat_at) VALUES ('planner-agent-leaderboard', 'task-agent-leaderboard', ?, 'workflow-agent-leaderboard', 'planner', 'completed', 1, ?, ?, ?)").run(value.companyId, now, now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer-agent-leaderboard', 'task-agent-leaderboard', ?, 'workflow-agent-leaderboard', 1, 1, 'running', 'work/leaderboard', '/tmp/leaderboard', ?, ?)").run(value.companyId, "b".repeat(40), now);
    });
    const agents = value.projects.listAgents(value.adminId);
    expect(agents.map(({ role, activeCount, lastSeenAt }) => ({ role, activeCount, lastSeenAt }))).toEqual([
      { role: "builder", activeCount: 1, lastSeenAt: now },
      { role: "planner", activeCount: 0, lastSeenAt: now },
      { role: "reviewer", activeCount: 0, lastSeenAt: agents[2]?.createdAt },
    ]);
  } finally {
    await close(value);
  }
});

test("updates every editable profile setting", async () => {
  const value = await fixture();
  try {
    const profile = value.projects.createProfile(value.adminId, { name: "Editable", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
    expect(value.projects.updateProfile(value.adminId, profile.id, { name: "Updated", model: "gpt-5.6-terra", reasoningLevel: "high", servicePriority: "priority", capacity: 4 })).toMatchObject({ id: profile.id, name: "Updated", model: "gpt-5.6-terra", reasoningLevel: "high", servicePriority: "priority", capacity: 4, effectiveCapacity: 4 });
  } finally {
    await close(value);
  }
});

test("clones a GitHub repository under the configured Forge roots", async () => {
  const value = await fixture();
  const provisioned: Array<{ cloneUrl: string; repository: string; repositoryPath: string; worktreeRoot: string }> = [];
  const projects = new ProjectService(value.database, value.auth, createTestConfig(value.root, {
    reachableAddress: "https://forge.tailnet.ts.net:4111",
    repositoryRoot: join(value.root, "repositories"),
    worktreeRoot: value.worktreeRoot,
  }), {
    localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "meiji-industries/sampler", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } },
    github,
    repositoryProvisioner: { async ensure(coordinate) { provisioned.push(coordinate); await mkdir(coordinate.repositoryPath, { recursive: true }); await mkdir(coordinate.worktreeRoot, { recursive: true }); await writeFile(join(coordinate.repositoryPath, "mise.toml"), "[tasks.setup]\nrun = \"cargo fetch --locked\"\n[tasks.test]\nrun = \"cargo test\"\n"); } },
  });
  try {
    const project = await projects.createProjectFromRepository(value.adminId, value.companyId, "https://github.com/meiji-industries/sampler.git");
    expect(project).toMatchObject({
      name: "sampler",
      repository: "meiji-industries/sampler",
      repositoryPath: await realpath(join(value.root, "repositories", "meiji-industries", "sampler")),
      worktreeRoot: await realpath(join(value.worktreeRoot, "meiji-industries", "sampler")),
      baseBranch: "main",
      targetBranch: "main",
      setupCommand: "mise run setup",
      verificationCommand: "mise run test",
      requiredChecks: ["Tests / unit"],
      roleDefaults: value.roleDefaults,
    });
    expect(provisioned).toEqual([expect.objectContaining({ cloneUrl: "https://github.com/meiji-industries/sampler.git", repository: "meiji-industries/sampler" })]);
  } finally {
    await close(value);
  }
});

test.skip("keeps an active project active while saving configuration history", async () => {
  const value = await fixture();
  try {
    const draft = await value.projects.createProject(value.adminId, value.companyId, input(value));
    expect(draft.status).toBe("draft");
    const active = await value.projects.activateProject(value.adminId, draft.id);
    expect(active.status).toBe("active");
    expect(active.configurationRevision).toBe(1);
    expect(active.configurationIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(active.baseSha).toBe("a".repeat(40));
    expect(active.targetSha).toBe("b".repeat(40));
    const unchanged = await value.projects.updateProject(value.adminId, draft.id, input(value));
    expect(unchanged.status).toBe("active");
    expect(unchanged.configurationRevision).toBe(1);
    const changed = await value.projects.updateProject(value.adminId, draft.id, input(value, { targetBranch: "release" }));
    expect(changed.status).toBe("active");
    expect(changed.configurationRevision).toBe(2);
    const revisions = value.database.authQuery((db) => db.prepare("SELECT revision, identity, normalized_json FROM forge_project_revisions WHERE project_id = ? ORDER BY revision").all(draft.id) as Array<{ revision: number; identity: string; normalized_json: string }>);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.normalized_json).not.toContain("token");
    expect(JSON.parse(revisions[0]?.normalized_json ?? "{}")).toMatchObject({ baseSha: "a".repeat(40), targetSha: "b".repeat(40) });
  } finally {
    await close(value);
  }
});

test("accepts free-form project commands and rejects secret-shaped commands", async () => {
  const value = await fixture();
  try {
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { setupCommand: "make setup", verificationCommand: "uv run pytest -q" }))).resolves.toMatchObject({ setupCommand: "make setup", verificationCommand: "uv run pytest -q" });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { name: "Secret command", setupCommand: "ghp_should-not-persist", verificationCommand: "uv run pytest -q" }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "unapproved-command", field: "setupCommand", message: "Command must be a single non-empty line without secrets" })]) });
  } finally {
    await close(value);
  }
});

test.skip("rejects traversal, symlink ambiguity, and invalid branches with typed redacted findings", async () => {
  const value = await fixture();
  const outside = join(value.root, "outside");
  const symlinkPath = join(value.root, "repositories", "link");
  await mkdir(outside, { recursive: true });
  await symlink(value.repositoryPath, symlinkPath);
  try {
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { repositoryPath: "../outside" }))).rejects.toMatchObject({ publicMessage: "Project configuration is invalid", findings: expect.arrayContaining([expect.objectContaining({ code: "path-traversal" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { repositoryPath: symlinkPath }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "symlink-ambiguous" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { targetBranch: "feature..token" }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "unsafe-branch" })]) });
    const invalidChecksRepository = join(value.root, "repositories", "invalid-checks");
    const invalidChecksWorktree = join(value.worktreeRoot, "invalid-checks");
    await mkdir(invalidChecksRepository, { recursive: true });
    await mkdir(invalidChecksWorktree, { recursive: true });
    const invalidChecks = await value.projects.createProject(value.adminId, value.companyId, input(value, { name: "Invalid checks", repositoryPath: invalidChecksRepository, worktreeRoot: invalidChecksWorktree, repository: "acme/invalid-checks", requiredChecks: [] }));
    await expect(value.projects.activateProject(value.adminId, invalidChecks.id)).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "invalid-check" })]) });
    expect(() => value.projects.createProfile(value.adminId, { name: "Secret profile", model: "ghp_should-not-persist", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 })).toThrowError("Profile configuration is invalid");
    expect(() => value.projects.createProfile(value.adminId, { name: "Invalid capacity", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 0 })).toThrowError("Profile configuration is invalid");
  } finally {
    await close(value);
  }
});

test.skip("fails closed for provider mismatch, unavailable agents, and cross-company project access", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    const mismatched = new ProjectService(value.database, value.auth, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(value.root, "repositories"), worktreeRoot: value.worktreeRoot }), {
      localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "other/repo", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } },
      github,
    });
    await expect(mismatched.activateProject(value.adminId, project.id)).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "repository-mismatch" })]) });
    const unavailableRepository = join(value.root, "repositories", "unavailable");
    const unavailableWorktree = join(value.worktreeRoot, "unavailable");
    await mkdir(unavailableRepository, { recursive: true });
    await mkdir(unavailableWorktree, { recursive: true });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { name: "Unavailable", repositoryPath: unavailableRepository, worktreeRoot: unavailableWorktree, repository: "acme/unavailable", roleDefaults: { planner: "missing-agent", builder: "missing-agent", reviewer: "missing-agent" } }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "agent-ineligible" })]) });

    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('member-1', 'Member', 'member@forge.local', 'member', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-b', 'Other', 'active', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('member-1', 'company-b', '2026-08-11T00:00:00.000Z')").run();
    });
    expect(() => value.projects.getProject("member-1", project.id)).toThrowError("Not found");
    expect(value.projects.listProjects("member-1")).toEqual([]);
    await expect(value.projects.createProject("member-1", value.companyId, input(value, { name: "Cross-company create", repositoryPath: join(value.root, "repositories", "cross"), worktreeRoot: join(value.worktreeRoot, "cross") }))).rejects.toMatchObject({ publicMessage: "Not found" });
    await expect(value.projects.updateProject("member-1", project.id, input(value))).rejects.toMatchObject({ publicMessage: "Not found" });
    await expect(value.projects.activateProject("member-1", project.id)).rejects.toMatchObject({ publicMessage: "Not found" });
    value.auth.setCompanyStatus(value.adminId, value.companyId, "paused");
    await expect(value.projects.activateProject(value.adminId, project.id)).rejects.toMatchObject({ publicMessage: "Project activation failed", findings: expect.arrayContaining([expect.objectContaining({ code: "company-inactive" })]) });
  } finally {
    await close(value);
  }
});


test.skip("rejects GitHub provider URL with wrong hostname or path", async () => {
  const value = await fixture();
  const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
  const wrongHost = new ProjectService(value.database, value.auth, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(value.root, "repositories"), worktreeRoot: value.worktreeRoot }), {
    localRepository,
    github: { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: "https://notgithub.com/acme/forge" }; } },
  });
  await expect(wrongHost.activateProject(value.adminId, project.id)).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "provider-host" })]) });
  const wrongPath = new ProjectService(value.database, value.auth, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(value.root, "repositories"), worktreeRoot: value.worktreeRoot }), {
    localRepository,
    github: { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: "https://github.com/other/repo" }; } },
  });
  await expect(wrongPath.activateProject(value.adminId, project.id)).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "provider-path" })]) });
  await close(value);
});

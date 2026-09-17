import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";
import { z } from "zod";

import { AuthService } from "../src/identity/auth.js";
import { createTestConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { ProjectService, inferRepositoryCommands, type LocalRepositoryAdapter } from "../src/projects/projects.js";
import { repositoryCoordinate } from "../src/projects/repository-coordinate.js";
import type { GithubAdapter } from "../src/integrations/github/client.js";

interface Fixture {
  root: string;
  database: ForgeDatabase;
  auth: AuthService;
  projects: ProjectService;
  adminId: string;
  companyId: string;
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
  const projects = new ProjectService(database, auth, config, { localRepository, github, validateProjectConfiguration: true, readProviders: async () => ({
    directory: root, observedAt: new Date().toISOString(), providers: [
      { id: "opencode" as const, label: "OpenCode", status: "configured" as const, modelCount: 2, models: [{ id: "openai/shared-model", label: "OpenAI model (OpenAI)" }, { id: "opencode/shared-model", label: "Zen model (OpenCode Zen)" }], connection: { status: "connected" as const, summary: "Signed in" } },
      { id: "devin" as const, label: "Devin CLI", status: "missing" as const, modelCount: 1, models: [{ id: "swe-2", label: "SWE-2" }], connection: { status: "not-connected" as const, summary: "Not installed" } },
    ],
  }) });
  const company = auth.createCompany("admin-1", "Acme");
  return { root, database, auth, projects, adminId: "admin-1", companyId: company.id, repositoryPath, worktreeRoot };
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
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker",
    ...overrides,
  };
}

test("normalizes supported GitHub repository URLs", () => {
  for (const repositoryUrl of [
    "https://github.com/meiji-industries/sampler",
    "https://github.com/meiji-industries/sampler.git",
    "git@github.com:meiji-industries/sampler.git",
  ]) {
    expect(repositoryCoordinate(repositoryUrl)).toMatchObject({ host: "github", repository: "meiji-industries/sampler", name: "sampler" });
  }
  expect(repositoryCoordinate("git@github.com:meiji-industries/sampler.git")?.cloneUrl).toBe("git@github.com:meiji-industries/sampler.git");
  expect(repositoryCoordinate("https://token@github.com/meiji-industries/sampler.git")).toBeNull();
  expect(repositoryCoordinate("https://gitlab.com/meiji-industries/sampler.git")).toBeNull();
  expect(repositoryCoordinate("git@bitbucket.org:team/project.git")).toMatchObject({ host: "bitbucket", repository: "team/project", cloneUrl: "git@bitbucket.org:team/project.git" });
});

test("project provider policy persists, survives unrelated edits, and validates login identities", async () => {
  const f = await fixture();
  try {
    const providerPolicy = { allowedProviders: ["codex"], allowedInstanceIds: [] };
    const project = await f.projects.createProject(f.adminId, f.companyId, input(f, { providerPolicy }));
    expect(project.providerPolicy).toEqual(providerPolicy);
    expect((await f.projects.updateProject(f.adminId, project.id, input(f))).providerPolicy).toEqual(providerPolicy);
    await expect(f.projects.updateProject(f.adminId, project.id, input(f, { providerPolicy: { allowedProviders: ["claude-code"], allowedInstanceIds: ["missing"] } }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "instance-ineligible" })]) });
    expect((await f.projects.updateProject(f.adminId, project.id, input(f, { providerPolicy: null }))).providerPolicy).toBeNull();
  } finally { await close(f); }
});

test("explicit tracker settings survive edits and do not admit unrelated legacy issue sources", async () => {
  const f = await fixture();
  try {
    const integration = { repository: { kind: "github" }, tracker: { kind: "jira", site: "https://client.atlassian.net", project: "APP", emailEnvironment: "CLIENT_EMAIL", tokenEnvironment: "CLIENT_TOKEN" } };
    const project = await f.projects.createProject(f.adminId, f.companyId, input(f, { integration }));
    expect((await f.projects.updateProject(f.adminId, project.id, input(f))).integration).toEqual(integration);
    await expect(f.projects.discoverTaskSources(f.adminId, project.id, "issue")).resolves.toMatchObject({ available: false, sources: [] });
    await expect(f.projects.resolveTaskSource(project, { kind: "issue", number: 7 })).rejects.toThrow("Issue field");
  } finally { await close(f); }
});

test.each([
  ["pnpm", "pnpm-lock.yaml", "pnpm check"],
  ["npm", "package-lock.json", "npm run check"],
  ["yarn", "yarn.lock", "yarn check"],
  ["bun", "bun.lock", "bun check"],
] as const)("prefers the complete package check with the %s runner", async (packageManager, lockfile, verificationCommand) => {
  const repository = await mkdtemp(join(tmpdir(), `forge-infer-${packageManager}-`));
  try {
    await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { check: "lint && test", test: "test" } }));
    await writeFile(join(repository, lockfile), "");
    await expect(inferRepositoryCommands(repository)).resolves.toMatchObject({ verificationCommand });
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("prefers complete checks in mise and Makefile repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-infer-checks-"));
  try {
    const miseRepository = join(root, "mise");
    const makeRepository = join(root, "make");
    await mkdir(miseRepository);
    await mkdir(makeRepository);
    await writeFile(join(miseRepository, "mise.toml"), "[tasks.check]\nrun = \"test && lint\"\n[tasks.test]\nrun = \"test\"\n");
    await writeFile(join(makeRepository, "Makefile"), "check:\n\ttrue\n\ntest:\n\ttrue\n");
    await expect(inferRepositoryCommands(miseRepository)).resolves.toMatchObject({ verificationCommand: "mise run check" });
    await expect(inferRepositoryCommands(makeRepository)).resolves.toMatchObject({ verificationCommand: "make check" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads provider-qualified models from OpenCode without a Forge catalog gate", async () => {
  const value = await fixture();
  try {
    expect(await value.projects.listModels(value.adminId)).toEqual([
      { id: "openai/shared-model", provider: "opencode", providerLabel: "OpenCode", providerStatus: "configured", displayName: "OpenAI model (OpenAI)" },
      { id: "opencode/shared-model", provider: "opencode", providerLabel: "OpenCode", providerStatus: "configured", displayName: "Zen model (OpenCode Zen)" },
      { id: "swe-2", provider: "devin", providerLabel: "Devin CLI", providerStatus: "missing", displayName: "SWE-2" },
    ]);
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
      setupCommand: "mise run setup",
      verificationCommand: "mise run test",
      rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker",
    });
    expect(provisioned).toEqual([expect.objectContaining({ cloneUrl: "https://github.com/meiji-industries/sampler.git", repository: "meiji-industries/sampler" })]);
  } finally {
    await close(value);
  }
});

test("keeps saved project changes live without mutating prior configuration values", async () => {
  const value = await fixture();
  try {
    const original = await value.projects.createProject(value.adminId, value.companyId, input(value));
    expect(original).not.toHaveProperty("status");
    expect(original.baseBranch).toBe("main");
    const unchanged = await value.projects.updateProject(value.adminId, original.id, input(value));
    expect(unchanged.baseBranch).toBe("main");
    const changed = await value.projects.updateProject(value.adminId, original.id, input(value, { baseBranch: "release" }));
    expect(changed.baseBranch).toBe("release");
    expect(value.projects.getProject(value.adminId, original.id).baseBranch).toBe("release");
    expect(original.baseBranch).toBe("main");
    expect(unchanged.baseBranch).toBe("main");
    const history = value.database.authQuery((db) => db.prepare("SELECT action, metadata_json FROM forge_audit_events WHERE company_id = ? AND action IN ('project_created', 'project_updated')").all(value.companyId) as Array<{ action: string; metadata_json: string }>);
    expect(history.filter((event) => event.action === "project_created")).toHaveLength(1);
    expect(history.filter((event) => event.action === "project_updated")).toHaveLength(2);
    expect(history.every((event) => event.metadata_json.includes(original.id))).toBe(true);
  } finally {
    await close(value);
  }
});

test("partial project updates preserve omitted fields and validate only changed domains", async () => {
  const value = await fixture();
  try {
    const original = await value.projects.createProject(value.adminId, value.companyId, input(value, {
      execution: { instructions: "Keep this", skillDirectories: ["skills"], environment: { APP_MODE: "test" }, mcp: [] },
    }));
    const unavailable = new ProjectService(value.database, value.auth, createTestConfig(value.root, {
      reachableAddress: "https://forge.tailnet.ts.net:4111",
      repositoryRoot: join(value.root, "repositories"),
      worktreeRoot: value.worktreeRoot,
    }), {
      localRepository: { async inspect() { throw new Error("repository not available"); } },
      github: { async checkAuthentication() { throw new Error("provider not available"); }, async getRepository() { throw new Error("provider not available"); } },
      validateProjectConfiguration: true,
    });

    await rm(value.repositoryPath, { recursive: true });
    const renamed = await unavailable.patchProject(value.adminId, original.id, { name: "Renamed project" });
    expect(renamed).toMatchObject({
      name: "Renamed project",
      repository: original.repository,
      baseBranch: original.baseBranch,
      setupCommand: original.setupCommand,
      verificationCommand: original.verificationCommand,
    });
    expect((await unavailable.patchProject(value.adminId, original.id, { execution: { instructions: "Changed" } })).execution).toEqual({
      instructions: "Changed",
      skillDirectories: ["skills"],
      environment: { APP_MODE: "test" },
      mcp: [],
    });
    expect((await unavailable.patchProject(value.adminId, original.id, { execution: { environment: { NEXT_MODE: "enabled" } } })).execution).toEqual({
      instructions: "Changed",
      skillDirectories: ["skills"],
      environment: { NEXT_MODE: "enabled" },
      mcp: [],
    });
    await expect(unavailable.patchProject(value.adminId, original.id, { baseBranch: "feature..unsafe" })).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "unsafe-branch", field: "baseBranch" })]) });
    await expect(unavailable.patchProject("missing-user", original.id, { name: "No access" })).rejects.toMatchObject({ statusCode: 401 });
  } finally {
    await close(value);
  }
});

test("partial branch and tracker updates do not require the repository provider", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    const providerUnavailable = new ProjectService(value.database, value.auth, createTestConfig(value.root, {
      reachableAddress: "https://forge.tailnet.ts.net:4111",
      repositoryRoot: join(value.root, "repositories"),
      worktreeRoot: value.worktreeRoot,
    }), {
      localRepository,
      github: { async checkAuthentication() { throw new Error("provider not available"); }, async getRepository() { throw new Error("provider not available"); } },
      validateProjectConfiguration: true,
    });

    await expect(providerUnavailable.patchProject(value.adminId, project.id, { baseBranch: "release" })).resolves.toMatchObject({ baseBranch: "release" });
    const integration = { repository: { kind: "github" as const }, tracker: { kind: "jira" as const, site: "https://client.atlassian.net/", project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } };
    await expect(providerUnavailable.patchProject(value.adminId, project.id, { integration })).resolves.toMatchObject({ integration });
  } finally {
    await close(value);
  }
});

test("partial agent updates reject invalid profiles and provider policies atomically", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    await expect(value.projects.patchProject(value.adminId, project.id, { rootProfileId: "missing-profile", providerPolicy: { allowedProviders: ["codex"], allowedInstanceIds: [] } })).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "profile-ineligible", field: "rootProfileId" })]) });
    expect(value.projects.getProject(value.adminId, project.id)).toMatchObject({ rootProfileId: project.rootProfileId, providerPolicy: project.providerPolicy });

    const rootProvider = z.object({ provider: z.string() }).parse(value.database.authQuery((db) => db.prepare("SELECT provider FROM forge_profiles WHERE id = ?").get(project.rootProfileId))).provider;
    const disallowedProvider = rootProvider === "devin" ? "codex" : "devin";
    await expect(value.projects.patchProject(value.adminId, project.id, { providerPolicy: { allowedProviders: [disallowedProvider], allowedInstanceIds: [] } })).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "profile-provider-ineligible" })]) });
    expect(value.projects.getProject(value.adminId, project.id).providerPolicy).toEqual(project.providerPolicy);
  } finally {
    await close(value);
  }
});

test("partial rename does not revalidate archived default profiles", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    value.database.authQuery((db) => db.prepare("UPDATE forge_profiles SET archived_at = '2026-09-17T00:00:00.000Z' WHERE id IN (?, ?)").run(project.rootProfileId, project.workerProfileId));
    await expect(value.projects.patchProject(value.adminId, project.id, { name: "Renamed with archived defaults" })).resolves.toMatchObject({ name: "Renamed with archived defaults" });
  } finally {
    await close(value);
  }
});

test("project members can list the minimal provider instance catalog", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('member-catalog', 'Member', 'catalog@forge.local', 'member', 'active', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('member-catalog', ?, '2026-09-17T00:00:00.000Z')").run(value.companyId);
      db.prepare("INSERT INTO forge_provider_instances (id, provider, label, home_directory, created_at, updated_at) VALUES ('instance_acmelaude', 'claude-code', 'acmelaude', '/private/acmelaude', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')").run();
    });

    expect(value.projects.listProjectProviderInstances("member-catalog", project.id)).toEqual([{ id: "instance_acmelaude", provider: "claude-code", label: "acmelaude" }]);
    expect(() => value.projects.listProjectProviderInstances("member-catalog", "missing-project")).toThrowError("Not found");
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

test("rejects traversal, symlink ambiguity, and invalid branches with typed redacted findings", async () => {
  const value = await fixture();
  const outside = join(value.root, "outside");
  const symlinkPath = join(value.root, "repositories", "link");
  await mkdir(outside, { recursive: true });
  await symlink(value.repositoryPath, symlinkPath);
  try {
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { repositoryPath: "../outside" }))).rejects.toMatchObject({ publicMessage: "Project configuration is invalid", findings: expect.arrayContaining([expect.objectContaining({ code: "path-traversal" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { repositoryPath: symlinkPath }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "symlink-ambiguous" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { baseBranch: "feature..token" }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "unsafe-branch" })]) });
    const invalidChecksRepository = join(value.root, "repositories", "invalid-checks");
    const invalidChecksWorktree = join(value.worktreeRoot, "invalid-checks");
    await mkdir(invalidChecksRepository, { recursive: true });
    await mkdir(invalidChecksWorktree, { recursive: true });
  } finally {
    await close(value);
  }
});

test("fails closed for provider mismatch, unavailable agents, and cross-company project access", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    const mismatched = new ProjectService(value.database, value.auth, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(value.root, "repositories"), worktreeRoot: value.worktreeRoot }), {
      localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "other/repo", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } },
      github,
      validateProjectConfiguration: true,
    });
    await expect(mismatched.updateProject(value.adminId, project.id, input(value))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "repository-mismatch" })]) });
    const unavailableRepository = join(value.root, "repositories", "unavailable");
    const unavailableWorktree = join(value.worktreeRoot, "unavailable");
    await mkdir(unavailableRepository, { recursive: true });
    await mkdir(unavailableWorktree, { recursive: true });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { name: "Unavailable", repositoryPath: unavailableRepository, worktreeRoot: unavailableWorktree, repository: "acme/unavailable", rootProfileId: "missing-profile", workerProfileId: "missing-profile" }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "profile-ineligible" })]) });

    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('member-1', 'Member', 'member@forge.local', 'member', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-b', 'Other', 'active', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('member-1', 'company-b', '2026-08-11T00:00:00.000Z')").run();
    });
    expect(() => value.projects.getProject("member-1", project.id)).toThrowError("Not found");
    expect(value.projects.listProjects("member-1")).toEqual([]);
    await expect(value.projects.createProject("member-1", value.companyId, input(value, { name: "Cross-company create", repositoryPath: join(value.root, "repositories", "cross"), worktreeRoot: join(value.worktreeRoot, "cross") }))).rejects.toMatchObject({ publicMessage: "Not found" });
    await expect(value.projects.updateProject("member-1", project.id, input(value))).rejects.toMatchObject({ publicMessage: "Not found" });
    await expect(value.projects.patchProject("member-1", project.id, { name: "Cross-company patch" })).rejects.toMatchObject({ publicMessage: "Not found" });
    value.auth.setCompanyStatus(value.adminId, value.companyId, "paused");
    await expect(value.projects.updateProject(value.adminId, project.id, input(value))).rejects.toMatchObject({ publicMessage: "Company is not active", findings: expect.arrayContaining([expect.objectContaining({ code: "company-inactive" })]) });
    await expect(value.projects.patchProject(value.adminId, project.id, { name: "Paused patch" })).rejects.toMatchObject({ publicMessage: "Company is not active", findings: expect.arrayContaining([expect.objectContaining({ code: "company-inactive" })]) });
  } finally {
    await close(value);
  }
});


test("rejects GitHub provider URL with wrong hostname or path", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    const wrongHost = new ProjectService(value.database, value.auth, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(value.root, "repositories"), worktreeRoot: value.worktreeRoot }), {
      localRepository,
      github: { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: "https://notgithub.com/acme/forge" }; } },
      validateProjectConfiguration: true,
    });
    await expect(wrongHost.updateProject(value.adminId, project.id, input(value))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "provider-host" })]) });
    const wrongPath = new ProjectService(value.database, value.auth, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(value.root, "repositories"), worktreeRoot: value.worktreeRoot }), {
      localRepository,
      github: { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: "https://github.com/other/repo" }; } },
      validateProjectConfiguration: true,
    });
    await expect(wrongPath.updateProject(value.adminId, project.id, input(value))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "provider-path" })]) });
  } finally {
    await close(value);
  }
});

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  return { root, database, auth, projects, adminId: "admin-1", companyId: company.id, profileId: profile.id, repositoryPath, worktreeRoot };
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
    allowedProfileIds: [value.profileId],
    roleDefaults: { lead: value.profileId, developer: value.profileId },
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

test("creates a minimal draft from a GitHub URL under the configured Forge roots", async () => {
  const value = await fixture();
  const provisioned: Array<{ cloneUrl: string; repository: string; repositoryPath: string; worktreeRoot: string }> = [];
  const projects = new ProjectService(value.database, value.auth, createTestConfig(value.root, {
    reachableAddress: "https://forge.tailnet.ts.net:4111",
    repositoryRoot: join(value.root, "repositories"),
    worktreeRoot: value.worktreeRoot,
  }), {
    localRepository,
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
      status: "draft",
      requiredChecks: ["Tests / unit"],
      allowedProfileIds: [value.profileId],
      roleDefaults: { lead: value.profileId, developer: value.profileId },
    });
    expect(provisioned).toEqual([expect.objectContaining({ cloneUrl: "https://github.com/meiji-industries/sampler.git", repository: "meiji-industries/sampler" })]);
  } finally {
    await close(value);
  }
});

test("activates a validated project and records an immutable normalized revision", async () => {
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
    expect(unchanged.status).toBe("draft");
    expect(unchanged.configurationRevision).toBe(1);
    const reactivated = await value.projects.activateProject(value.adminId, draft.id);
    expect(reactivated.configurationRevision).toBe(1);
    const changed = await value.projects.updateProject(value.adminId, draft.id, input(value, { targetBranch: "release" }));
    expect(changed.configurationRevision).toBe(1);
    await value.projects.activateProject(value.adminId, draft.id);
    const revisions = value.database.authQuery((db) => db.prepare("SELECT revision, identity, normalized_json FROM forge_project_revisions WHERE project_id = ? ORDER BY revision").all(draft.id) as Array<{ revision: number; identity: string; normalized_json: string }>);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.normalized_json).not.toContain("token");
    expect(JSON.parse(revisions[0]?.normalized_json ?? "{}")).toMatchObject({ baseSha: "a".repeat(40), targetSha: "b".repeat(40) });
  } finally {
    await close(value);
  }
});

test("rejects traversal, symlink ambiguity, unsafe commands, and invalid branches with typed redacted findings", async () => {
  const value = await fixture();
  const outside = join(value.root, "outside");
  const symlinkPath = join(value.root, "repositories", "link");
  await mkdir(outside, { recursive: true });
  await symlink(value.repositoryPath, symlinkPath);
  try {
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { repositoryPath: "../outside" }))).rejects.toMatchObject({ publicMessage: "Project configuration is invalid", findings: expect.arrayContaining([expect.objectContaining({ code: "path-traversal" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { repositoryPath: symlinkPath }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "symlink-ambiguous" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { setupCommand: "pnpm test && curl https://example.com" }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "unapproved-command" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { targetBranch: "feature..token" }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "unsafe-branch" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { requiredChecks: [] }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "invalid-check" })]) });
    expect(() => value.projects.createProfile(value.adminId, { name: "Secret profile", model: "ghp_should-not-persist", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 })).toThrowError("Profile configuration is invalid");
    expect(() => value.projects.createProfile(value.adminId, { name: "Invalid capacity", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 0 })).toThrowError("Profile configuration is invalid");
  } finally {
    await close(value);
  }
});

test("fails closed for provider mismatch, unavailable profiles, and cross-company project access", async () => {
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
    const unavailable = await value.projects.createProject(value.adminId, value.companyId, input(value, { name: "Unavailable", repositoryPath: unavailableRepository, worktreeRoot: unavailableWorktree, repository: "acme/unavailable", allowedProfileIds: ["missing-profile"], roleDefaults: { lead: "missing-profile", developer: "missing-profile" } }));
    await expect(value.projects.activateProject(value.adminId, unavailable.id)).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "profile-unavailable" })]) });

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

test("rejects duplicate repository identity across companies and preserves exact Git SHAs on activation", async () => {
  const value = await fixture();
  try {
    const first = await value.projects.createProject(value.adminId, value.companyId, input(value, { repository: "acme/forge" }));
    const firstActive = await value.projects.activateProject(value.adminId, first.id);
    expect(firstActive.baseSha).toBe("a".repeat(40));
    expect(firstActive.targetSha).toBe("b".repeat(40));

    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-b', 'Other', 'active', '2026-08-11T00:00:00.000Z')").run();
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES (?, 'company-b', '2026-08-11T00:00:00.000Z')").run(value.adminId);
    });
    const secondPath = join(value.root, "repositories", "second");
    const secondWorktree = join(value.worktreeRoot, "second");
    await mkdir(secondPath, { recursive: true });
    await mkdir(secondWorktree, { recursive: true });
    await expect(value.projects.createProject(value.adminId, "company-b", input(value, { name: "Second", repositoryPath: secondPath, worktreeRoot: secondWorktree, repository: "acme/forge" }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "already-assigned", field: "repository" })]) });

    const updatedSha = "c".repeat(40);
    const sameBranches = new ProjectService(value.database, value.auth, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(value.root, "repositories"), worktreeRoot: value.worktreeRoot }), {
      localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: updatedSha, targetSha: "b".repeat(40) }; } },
      github,
    });
    const reactivated = await sameBranches.activateProject(value.adminId, first.id);
    expect(reactivated.configurationRevision).toBeGreaterThan(firstActive.configurationRevision);
    expect(reactivated.baseSha).toBe(updatedSha);
  } finally {
    await close(value);
  }
});

test("rejects unwritable worktree root and missing lead or developer defaults", async () => {
  const value = await fixture();
  const readOnly = join(value.worktreeRoot, "readonly");
  await mkdir(readOnly, { recursive: true });
  await chmod(readOnly, 0o555);
  try {
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { worktreeRoot: readOnly }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "worktree-unwritable" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { roleDefaults: { lead: value.profileId } }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "missing-default", field: "roleDefaults.developer" })]) });
    await expect(value.projects.createProject(value.adminId, value.companyId, input(value, { roleDefaults: { developer: value.profileId } }))).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "missing-default", field: "roleDefaults.lead" })]) });
  } finally {
    await chmod(readOnly, 0o755);
    await close(value);
  }
});

test("rejects GitHub provider URL with wrong hostname or path", async () => {
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

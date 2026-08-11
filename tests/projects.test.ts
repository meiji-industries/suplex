import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
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
    return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "base-sha", targetSha: "target-sha" };
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
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "Acme");
  const profile = projects.createProfile("admin-1", { name: "Default", model: "gpt-5-codex", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
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

test("activates a validated project and records an immutable normalized revision", async () => {
  const value = await fixture();
  try {
    const draft = await value.projects.createProject(value.adminId, value.companyId, input(value));
    expect(draft.status).toBe("draft");
    const active = await value.projects.activateProject(value.adminId, draft.id);
    expect(active.status).toBe("active");
    expect(active.configurationRevision).toBe(1);
    expect(active.configurationIdentity).toMatch(/^[a-f0-9]{64}$/);
    const unchanged = await value.projects.updateProject(value.adminId, draft.id, input(value));
    expect(unchanged.configurationRevision).toBe(1);
    const changed = await value.projects.updateProject(value.adminId, draft.id, input(value, { targetBranch: "release" }));
    expect(changed.configurationRevision).toBe(2);
    const revisions = value.database.authQuery((db) => db.prepare("SELECT revision, identity, normalized_json FROM forge_project_revisions WHERE project_id = ? ORDER BY revision").all(draft.id) as Array<{ revision: number; identity: string; normalized_json: string }>);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.identity).not.toBe(revisions[1]?.identity);
    expect(revisions[0]?.normalized_json).not.toContain("token");
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
    expect(() => value.projects.createProfile(value.adminId, { name: "Invalid capacity", model: "gpt-5-codex", reasoningLevel: "medium", servicePriority: "standard", capacity: 0 })).toThrowError("Profile configuration is invalid");
  } finally {
    await close(value);
  }
});

test("fails closed for provider mismatch, unavailable profiles, and cross-company project access", async () => {
  const value = await fixture();
  try {
    const project = await value.projects.createProject(value.adminId, value.companyId, input(value));
    const mismatched = new ProjectService(value.database, value.auth, createTestConfig(value.root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(value.root, "repositories"), worktreeRoot: value.worktreeRoot }), {
      localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "other/repo", clean: true, baseSha: "base-sha", targetSha: "target-sha" }; } },
      github,
    });
    await expect(mismatched.activateProject(value.adminId, project.id)).rejects.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "repository-mismatch" })]) });
    const unavailableRepository = join(value.root, "repositories", "unavailable");
    const unavailableWorktree = join(value.worktreeRoot, "unavailable");
    await mkdir(unavailableRepository, { recursive: true });
    await mkdir(unavailableWorktree, { recursive: true });
    const unavailable = await value.projects.createProject(value.adminId, value.companyId, input(value, { name: "Unavailable", repositoryPath: unavailableRepository, worktreeRoot: unavailableWorktree, allowedProfileIds: ["missing-profile"], roleDefaults: { lead: "missing-profile" } }));
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

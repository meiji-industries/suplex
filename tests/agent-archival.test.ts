import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService, type Agent, type LocalRepositoryAdapter, type ProjectRole, type RoleAssignments } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";

const localRepository: LocalRepositoryAdapter = {
  async inspect(input) {
    return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) };
  },
};

const github: GithubAdapter = {
  async checkAuthentication() {},
  async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; },
  async listChecks() { return []; },
};

interface Fixture {
  root: string;
  database: ForgeDatabase;
  projects: ProjectService;
  profileId: string;
  companyId: string;
  agent: (name: string, role: ProjectRole) => Agent;
  project: (name: string, roleDefaults: RoleAssignments) => string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "forge-agent-archival-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')").run());
  const config = createTestConfig(root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot: join(root, "repositories"), worktreeRoot: join(root, "worktrees") });
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "Acme");
  const profile = projects.createProfile("admin-1", { name: "Default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  let projectCount = 0;
  return {
    root,
    database,
    projects,
    profileId: profile.id,
    companyId: company.id,
    agent: (name, role) => projects.createAgent("admin-1", { name, role, profileId: profile.id }),
    project: (name, roleDefaults) => {
      const id = `project-${(projectCount += 1)}`;
      database.authQuery((db) => db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[\"Tests / unit\"]', ?, 'draft', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')")
        .run(id, company.id, name, join(root, "repositories", id), join(root, "worktrees", id), JSON.stringify(roleDefaults)));
      return id;
    },
  };
}

async function close(value: Fixture): Promise<void> {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

test("renames an agent without touching its other settings", async () => {
  const value = await fixture();
  try {
    const planner = value.agent("Planner", "planner");
    const renamed = value.projects.updateAgent("admin-1", planner.id, { name: "Strategist" });
    expect(renamed).toMatchObject({ id: planner.id, name: "Strategist", role: "planner", avatarSeed: planner.avatarSeed, archivedAt: null });
    expect(renamed.profileId).toBe(planner.profileId);
    value.agent("Reviewer", "reviewer");
    expect(() => value.projects.updateAgent("admin-1", planner.id, { name: "Reviewer" })).toThrowError("Agent configuration is invalid");
  } finally {
    await close(value);
  }
});

test("duplicates an agent with a disambiguated copy name and a fresh identity", async () => {
  const value = await fixture();
  try {
    const builder = value.agent("Builder", "builder");
    const first = value.projects.duplicateAgent("admin-1", builder.id);
    const second = value.projects.duplicateAgent("admin-1", builder.id);
    const third = value.projects.duplicateAgent("admin-1", builder.id);
    expect([first.name, second.name, third.name]).toEqual(["Builder (copy)", "Builder (copy 2)", "Builder (copy 3)"]);
    expect(first).toMatchObject({ role: "builder", archivedAt: null });
    expect(first.profileId).not.toBe(builder.profileId);
    expect(first.id).not.toBe(builder.id);
    expect(first.avatarSeed).not.toBe(builder.avatarSeed);
    expect(value.projects.listAgents("admin-1").filter((agent) => agent.name.startsWith("Builder"))).toHaveLength(4);
  } finally {
    await close(value);
  }
});

test("refuses to archive a project's builder default even when another builder exists", async () => {
  const value = await fixture();
  try {
    const builder = value.agent("Builder", "builder");
    const spare = value.agent("Spare builder", "builder");
    value.project("Forge", { builder: builder.id });
    expect(() => value.projects.updateAgent("admin-1", builder.id, { archived: true })).toThrowError(/builder default for Forge/);
    expect(value.projects.updateAgent("admin-1", spare.id, { archived: true }).archivedAt).toEqual(expect.any(String));
  } finally {
    await close(value);
  }
});

test("refuses to archive the last remaining agent of a role a project defaults to", async () => {
  const value = await fixture();
  try {
    const reviewer = value.agent("Reviewer", "reviewer");
    value.project("Forge", { reviewer: reviewer.id });
    expect(() => value.projects.updateAgent("admin-1", reviewer.id, { archived: true })).toThrowError(/only reviewer agent left/);
    value.agent("Second reviewer", "reviewer");
    expect(value.projects.updateAgent("admin-1", reviewer.id, { archived: true }).archivedAt).toEqual(expect.any(String));
  } finally {
    await close(value);
  }
});

test("hides archived agents from pickers until they are unarchived", async () => {
  const value = await fixture();
  try {
    const planner = value.agent("Planner", "planner");
    value.agent("Builder", "builder");
    value.projects.updateAgent("admin-1", planner.id, { archived: true });
    expect(value.projects.listAgents("admin-1").map((agent) => agent.name)).toEqual(["Builder"]);
    expect(value.projects.listAgents("admin-1", undefined, true).map((agent) => agent.name)).toEqual(["Builder", "Planner"]);
    const restored = value.projects.updateAgent("admin-1", planner.id, { archived: false });
    expect(restored.archivedAt).toBeNull();
    expect(value.projects.listAgents("admin-1").map((agent) => agent.name)).toEqual(["Builder", "Planner"]);
  } finally {
    await close(value);
  }
});

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { backfillDefaultTaskTemplates, DEFAULT_TASK_TEMPLATES } from "../src/default-task-templates.js";
import type { GithubAdapter } from "../src/github.js";
import { ProjectService } from "../src/projects.js";
import { TaskTemplateService } from "../src/task-templates.js";

const github: GithubAdapter = {
  async checkAuthentication() {},
  async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; },
  async listChecks() { return []; },
};

test("creating a project seeds the Ship Check template", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-default-task-template-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot });
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z')").run());
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, auth, config, { github, localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: input.repositoryPath.includes("repo") ? "acme/forge" : "", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } } });
  try {
    const company = auth.createCompany("admin-1", "Acme");
    const profile = projects.createProfile("admin-1", { name: "Default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 1 });
    const planner = projects.createAgent("admin-1", { name: "Planner", role: "planner", profileId: profile.id });
    const builder = projects.createAgent("admin-1", { name: "Builder", role: "builder", profileId: profile.id });
    const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
    const project = await projects.createProject("admin-1", company.id, { name: "Forge", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { planner: planner.id, builder: builder.id, reviewer: reviewer.id } });
    const templates = new TaskTemplateService(database, { requireCompanyAccess: () => ({}) } as never, {} as never).list("admin-1", project.id);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ ...DEFAULT_TASK_TEMPLATES[0], roleAgents: { planner: planner.id, builder: builder.id, reviewer: reviewer.id } });
    expect(templates[0]?.description).toBe(DEFAULT_TASK_TEMPLATES[0]?.description);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backfill seeds pre-existing projects once and preserves a user deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-default-task-template-backfill-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    database.authQuery((db) => db.pragma("foreign_keys = OFF"));
    database.authTransaction((db) => db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', '/tmp/project', '/tmp/worktrees', 'acme/project', 'main', 'main', '', '', '[]', '{\"planner\":\"planner-1\"}', 'active', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z')").run());
    expect(backfillDefaultTaskTemplates(database)).toBe(1);
    expect(backfillDefaultTaskTemplates(database)).toBe(0);
    database.authTransaction((db) => db.prepare("DELETE FROM forge_task_templates WHERE project_id = 'project-1' AND name = 'Ship Check'").run());
    expect(backfillDefaultTaskTemplates(database)).toBe(0);
    expect(database.authQuery((db) => db.prepare("SELECT * FROM forge_task_templates WHERE project_id = 'project-1'").all())).toEqual([]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

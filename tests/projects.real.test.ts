import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createGithubAdapter } from "../src/github.js";
import { ProjectService } from "../src/projects.js";

const execFileAsync = promisify(execFile);
const repositoryIdentity = process.env.FORGE_REAL_GITHUB_REPOSITORY?.trim().toLowerCase();
const runRealGithubProof = process.env.FORGE_RUN_REAL_GITHUB === "1" && Boolean(repositoryIdentity);

async function gitSnapshot(repositoryPath: string): Promise<{ refs: string; status: string }> {
  const [refs, status] = await Promise.all([
    execFileAsync("git", ["show-ref", "--head"], { cwd: repositoryPath }).then((result) => result.stdout),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repositoryPath }).then((result) => result.stdout),
  ]);
  return { refs, status };
}

test.skipIf(!runRealGithubProof)("activates through the production GitHub adapter without mutating GitHub or the local repository", async () => {
  const realRepository = repositoryIdentity;
  if (!realRepository) return;
  const root = await mkdtemp(join(tmpdir(), "forge-real-github-proof-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, ...realRepository.split("/"));
  const projectWorktreeRoot = join(worktreeRoot, ...realRepository.split("/"));
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(projectWorktreeRoot, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Forge real GitHub proof"]);
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "forge-real-github@example.invalid"]);
  await execFileAsync("git", ["-C", repositoryPath, "commit", "--allow-empty", "-m", "Forge real GitHub proof"]);
  await execFileAsync("git", ["-C", repositoryPath, "remote", "add", "origin", `https://github.com/${repositoryIdentity}.git`]);

  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('real-gh-admin', 'Real GitHub proof', 'real-gh-admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
    const config = createTestConfig(root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot, worktreeRoot });
    const auth = new AuthService(database, config);
    const projects = new ProjectService(database, auth, config);
    const company = auth.createCompany("real-gh-admin", "Real GitHub proof");
    const model = (await projects.listModels("real-gh-admin"))[0]?.id;
    if (!model) throw new Error("No active model is available for the real GitHub proof");
    const profile = projects.createProfile("real-gh-admin", { name: "Real GitHub proof", model, reasoningLevel: "medium", servicePriority: "standard", capacity: 1 });
    const planner = projects.createAgent("real-gh-admin", { name: "Planner", role: "planner", profileId: profile.id });
    const builder = projects.createAgent("real-gh-admin", { name: "Builder", role: "builder", profileId: profile.id });
    const reviewer = projects.createAgent("real-gh-admin", { name: "Reviewer", role: "reviewer", profileId: profile.id });
    const project = await projects.createProject("real-gh-admin", company.id, {
      name: "Real GitHub proof",
      repositoryPath,
      worktreeRoot: projectWorktreeRoot,
      repository: realRepository,
      baseBranch: "main",
      targetBranch: "main",
      setupCommand: "pnpm install",
      verificationCommand: "pnpm test",
      requiredChecks: ["Tests / unit"],
      roleDefaults: { planner: planner.id, builder: builder.id, reviewer: reviewer.id },
    });
    const github = createGithubAdapter();
    const before = {
      repository: await github.getRepository({ cwd: repositoryPath, nameWithOwner: realRepository }),
      git: await gitSnapshot(repositoryPath),
    };
    const activated = await projects.activateProject("real-gh-admin", project.id);
    const after = {
      repository: await github.getRepository({ cwd: repositoryPath, nameWithOwner: realRepository }),
      git: await gitSnapshot(repositoryPath),
    };

    expect(activated.status).toBe("active");
    expect(activated.baseSha).toMatch(/^[a-f0-9]{40,64}$/i);
    expect(activated.targetSha).toMatch(/^[a-f0-9]{40,64}$/i);
    expect(after).toEqual(before);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { runCommand } from "../src/platform/command-runner.js";
import { commitGitFixture, initializeGitFixture } from "./helpers/git-fixture.js";

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ command: "git", args: ["-C", directory, ...args], taskId: null, stepId: null });
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

async function localConfig(directory: string, bare: boolean, key: string): Promise<string> {
  const args = bare ? ["--git-dir", directory] : ["-C", directory];
  const result = await runCommand({ command: "git", args: [...args, "config", "--local", "--get", key], taskId: null, stepId: null });
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

test("Git fixtures write normal repository configuration for native Git commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-git-fixture-"));
  const repository = join(root, "repository");
  try {
    await mkdir(repository);
    await initializeGitFixture(repository, "main");

    expect(await localConfig(repository, false, "user.name")).toBe("Suplex");
    expect(await localConfig(repository, false, "user.email")).toBe("suplex@example.invalid");
    expect(await localConfig(repository, false, "commit.gpgsign")).toBe("false");

    const emptyCommit = await commitGitFixture(repository, "empty", []);
    await writeFile(join(repository, "README.md"), "fixture\n");
    const fileCommit = await commitGitFixture(repository, "file", ["README.md"]);

    expect((await git(repository, "rev-list", "--all")).split("\n")).toEqual([fileCommit, emptyCommit]);
    expect(await git(repository, "show", "HEAD:README.md")).toBe("fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git fixtures write bare repository configuration without a nested Git directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-bare-git-fixture-"));
  const repository = join(root, "repository.git");
  try {
    await mkdir(repository);
    await initializeGitFixture(repository, "main", true);

    expect(await localConfig(repository, true, "user.name")).toBe("Suplex");
    expect(await localConfig(repository, true, "user.email")).toBe("suplex@example.invalid");
    expect(await localConfig(repository, true, "commit.gpgsign")).toBe("false");
    expect(await localConfig(repository, true, "core.bare")).toBe("true");
    expect(existsSync(join(repository, ".git"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

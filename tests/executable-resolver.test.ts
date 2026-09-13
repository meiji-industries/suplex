import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveDevinExecutable, resolveOpenCodeExecutable } from "../src/platform/executable-resolver.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "forge-opencode-executable-"));
  directories.push(homeDirectory);
  const bin = join(homeDirectory, ".opencode", "bin");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "opencode");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { homeDirectory, executable };
}

test("finds the standard OpenCode installation when the service PATH omits it", async () => {
  const { homeDirectory, executable } = await fixture();
  expect(await resolveOpenCodeExecutable({ homeDirectory, env: { PATH: "/usr/bin:/bin" } })).toBe(executable);
});

test("prefers an explicit executable and does not hide invalid configuration", async () => {
  const { homeDirectory, executable } = await fixture();
  expect(await resolveOpenCodeExecutable({ homeDirectory, env: { PATH: "", FORGE_OPENCODE_COMMAND: executable } })).toBe(executable);
  await expect(resolveOpenCodeExecutable({ homeDirectory, env: { FORGE_OPENCODE_COMMAND: "/missing/opencode" } })).rejects.toThrow("FORGE_OPENCODE_COMMAND");
  await expect(resolveOpenCodeExecutable({ homeDirectory, executable: "opencode", env: {} })).rejects.toThrow("absolute");
});

test("uses an executable on PATH before the standard installation", async () => {
  const { homeDirectory } = await fixture();
  const bin = join(homeDirectory, "custom-bin");
  await mkdir(bin);
  const executable = join(bin, "opencode");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  expect(await resolveOpenCodeExecutable({ homeDirectory, env: { PATH: bin } })).toBe(executable);
});

test("reports a missing installation instead of passing an empty executable", async () => {
  const { homeDirectory, executable } = await fixture();
  await chmod(executable, 0o600);
  await expect(resolveOpenCodeExecutable({ homeDirectory, env: { PATH: "" } })).rejects.toThrow("Install OpenCode or set FORGE_OPENCODE_COMMAND");
});

test("resolves Devin from its standard path or explicit command", async () => {
  const { homeDirectory } = await fixture();
  const bin = join(homeDirectory, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "devin");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  expect(await resolveDevinExecutable({ homeDirectory, env: { PATH: "" } })).toBe(executable);
  expect(await resolveDevinExecutable({ homeDirectory, env: { PATH: "", FORGE_DEVIN_COMMAND: executable } })).toBe(executable);
  await expect(resolveDevinExecutable({ homeDirectory, env: { FORGE_DEVIN_COMMAND: "devin" } })).rejects.toThrow("absolute");
});

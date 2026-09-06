import { accessSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { afterAll } from "vitest";

const gitEnvironmentKeys = [
  "FORGE_GIT_BIN",
  "FORGE_GIT_REAL_BIN",
  "FORGE_GIT_GUARD_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_SUPER_PREFIX",
  "GIT_WORK_TREE",
  "PATH",
] as const;

const originalEnvironment = Object.fromEntries(gitEnvironmentKeys.map(key => [key, process.env[key]]));

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function workerGuard(candidate: string): boolean {
  const configuredGuard = process.env.FORGE_GIT_GUARD_DIR?.trim();
  if (configuredGuard) {
    const guardRelativePath = relative(resolve(configuredGuard), resolve(candidate));
    if (guardRelativePath === "" || (!guardRelativePath.startsWith("..") && guardRelativePath !== "..")) return true;
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(candidate, "r");
    const prefix = Buffer.alloc(4096);
    const bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0);
    return prefix.subarray(0, bytesRead).includes("Forge Worker policy blocked git");
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
const configuredCandidates = [process.env.FORGE_GIT_BIN, process.env.FORGE_GIT_REAL_BIN].filter((value): value is string => Boolean(value));
const pathCandidates = pathEntries.flatMap(directory => [join(directory, "git"), join(directory, "git.exe")]);
const gitBin = [...configuredCandidates, ...pathCandidates]
  .find(candidate => executable(candidate) && !workerGuard(candidate));

if (!gitBin) throw new Error("The Git integration project requires a real Git executable outside the Forge Worker guard");

const realGitBin = realpathSync(gitBin);
const testRoot = mkdtempSync(join(tmpdir(), "forge-git-test-environment-"));
const testBin = join(testRoot, "bin");
const globalConfig = join(testRoot, "gitconfig");
mkdirSync(testBin);
symlinkSync(realGitBin, join(testBin, "git"));
writeFileSync(globalConfig, "", { mode: 0o600 });

for (const key of ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_SUPER_PREFIX", "GIT_WORK_TREE"] as const) {
  delete process.env[key];
}
process.env.FORGE_GIT_BIN = realGitBin;
process.env.FORGE_GIT_REAL_BIN = realGitBin;
delete process.env.FORGE_GIT_GUARD_DIR;
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.PATH = [testBin, ...pathEntries].join(delimiter);

afterAll(() => {
  for (const key of gitEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testRoot, { recursive: true, force: true });
});

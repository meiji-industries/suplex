import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

async function readableFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function hasMiseTask(configuration: string, task: string): boolean {
  const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\[tasks\\.(?:${escaped}|["']${escaped}["'])\\]`, "m").test(configuration);
}

export async function inferRepositoryCommands(repositoryPath: string): Promise<{ setupCommand: string; verificationCommand: string }> {
  const miseConfiguration = await readableFile(join(repositoryPath, "mise.toml")) ?? await readableFile(join(repositoryPath, ".mise.toml"));
  const packageText = await readableFile(join(repositoryPath, "package.json"));
  let packageJson: { packageManager?: string; scripts?: Record<string, string> } | undefined;
  try {
    packageJson = packageText ? JSON.parse(packageText) : undefined;
  } catch {}

  let packageManager: "pnpm" | "npm" | "yarn" | "bun" | undefined;
  let setupCommand: string | undefined;
  if (await fileExists(join(repositoryPath, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
    setupCommand = "pnpm install --frozen-lockfile";
  } else if (await fileExists(join(repositoryPath, "package-lock.json")) || await fileExists(join(repositoryPath, "npm-shrinkwrap.json"))) {
    packageManager = "npm";
    setupCommand = "npm ci";
  } else if (await fileExists(join(repositoryPath, "yarn.lock"))) {
    packageManager = "yarn";
    setupCommand = "yarn install --immutable";
  } else if (await fileExists(join(repositoryPath, "bun.lock")) || await fileExists(join(repositoryPath, "bun.lockb"))) {
    packageManager = "bun";
    setupCommand = "bun install";
  } else if (packageJson) {
    const declaredManager = packageJson.packageManager?.split("@")[0];
    packageManager = declaredManager === "pnpm" || declaredManager === "yarn" || declaredManager === "bun" ? declaredManager : "npm";
    setupCommand = packageManager === "pnpm" ? "pnpm install" : packageManager === "npm" ? "npm install" : packageManager === "yarn" ? "yarn install" : "bun install";
  } else if (miseConfiguration && hasMiseTask(miseConfiguration, "setup")) {
    setupCommand = "mise run setup";
  } else if (await fileExists(join(repositoryPath, "Cargo.lock"))) {
    setupCommand = "cargo fetch --locked";
  }

  const scripts = packageJson?.scripts ?? {};
  const script = ["check", "test", "typecheck", "lint"].find((name) => Boolean(scripts[name]));
  let verificationCommand: string | undefined;
  if (script && packageManager) {
    verificationCommand = packageManager === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : `${packageManager} ${script}`;
  } else if (miseConfiguration) {
    const miseTask = ["check", "test", "typecheck", "lint"].find((name) => hasMiseTask(miseConfiguration, name));
    if (miseTask) verificationCommand = `mise run ${miseTask}`;
  } else if (await fileExists(join(repositoryPath, "Cargo.toml"))) {
    verificationCommand = "cargo test";
  } else {
    const makefile = await readableFile(join(repositoryPath, "Makefile"));
    if (makefile && /^check\s*:/m.test(makefile)) verificationCommand = "make check";
    else if (makefile && /^test\s*:/m.test(makefile)) verificationCommand = "make test";
  }

  return {
    setupCommand: setupCommand ?? "pnpm install",
    verificationCommand: verificationCommand ?? "pnpm test",
  };
}

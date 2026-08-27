import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { jsonRequired } from "../task-utils.js";

const paths = (env: NodeJS.ProcessEnv) => ({
  configDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  configFile: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json"),
});

export async function prepareClaudeLaunch({ cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const { configFile } = paths(env);
  let config: Record<string, unknown> = {};
  try { config = jsonRequired(await fs.readFile(configFile, "utf8")) as Record<string, unknown>; } catch { /* missing or corrupt config is replaced */ }
  const projects = typeof config.projects === "object" && config.projects ? config.projects as Record<string, Record<string, unknown>> : {};
  const project = projects[await fs.realpath(cwd)] ?? {};
  if (project.hasTrustDialogAccepted === true) return;
  projects[await fs.realpath(cwd)] = { ...project, hasTrustDialogAccepted: true };
  config.projects = projects;
  await fs.mkdir(join(configFile, ".."), { recursive: true });
  const temporary = `${configFile}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, configFile);
}

export async function claudeTranscriptCandidates(env: NodeJS.ProcessEnv): Promise<string[]> {
  const root = join(paths(env).configDir, "projects");
  const groups = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(groups.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const directory = join(root, entry.name);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    return entries.filter((file) => file.isFile() && file.name.endsWith(".jsonl")).map((file) => join(directory, file.name));
  }))).flat();
}

export async function claudeTranscriptPath(env: NodeJS.ProcessEnv, sessionId: string): Promise<string | undefined> {
  return (await claudeTranscriptCandidates(env)).find((path) => basename(path) === `${sessionId}.jsonl`);
}

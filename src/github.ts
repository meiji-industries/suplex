import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GithubRepository {
  nameWithOwner: string;
  url: string;
}

export interface GithubAdapter {
  checkAuthentication(): Promise<void>;
  getRepository(input: { cwd: string; nameWithOwner: string }): Promise<GithubRepository>;
}

export class GithubFailure extends Error {
  constructor(readonly code: "authentication" | "repository" | "command") {
    super("GitHub validation failed");
    this.name = "GithubFailure";
  }
}

function normalizeRepository(value: string): string {
  return value.trim().replace(/\.git$/, "").toLowerCase();
}

function redactOutput(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]");
}

async function runGh(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, { cwd, timeout: 8_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? redactOutput(error.message) : "command failed";
    throw new GithubFailure(message.includes("auth") ? "authentication" : "command");
  }
}

export function createGithubAdapter(command = process.env.FORGE_GH_COMMAND ?? "gh"): GithubAdapter {
  return {
    async checkAuthentication() {
      await runGh(command, ["auth", "status", "--hostname", "github.com"]);
    },
    async getRepository(input) {
      const result = await runGh(command, ["repo", "view", input.nameWithOwner, "--json", "nameWithOwner,url"], input.cwd);
      try {
        const parsed = JSON.parse(result.stdout) as { nameWithOwner?: unknown; url?: unknown };
        if (typeof parsed.nameWithOwner !== "string" || typeof parsed.url !== "string" || normalizeRepository(parsed.nameWithOwner) !== normalizeRepository(input.nameWithOwner)) {
          throw new GithubFailure("repository");
        }
        return { nameWithOwner: parsed.nameWithOwner, url: parsed.url };
      } catch (error) {
        if (error instanceof GithubFailure) throw error;
        throw new GithubFailure("repository");
      }
    },
  };
}

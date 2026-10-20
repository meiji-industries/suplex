import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

// The host reads each task's provider sign-in with the probe that Settings uses
// (`auth_args` in apps/server/src/profiles/provider_readiness.rs). The journey
// stand-ins must answer it as the real command lines do: without a turn.
const run = promisify(execFile);
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function probe(name: string, args: string[]) {
  const work = await mkdtemp(join(tmpdir(), "suplex-fixture-probe-"));
  const control = await mkdtemp(join(tmpdir(), "suplex-fixture-control-"));
  directories.push(work, control);
  await writeFile(join(work, "README.md"), "# Fixture\n");
  // A paused Worker phase: a turn would write `paused` and wait for a release.
  const env: NodeJS.ProcessEnv = { ...process.env, SUPLEX_DETERMINISTIC_PHASE: "restart", SUPLEX_DETERMINISTIC_CONTROL_DIR: control, CLAUDE_CONFIG_DIR: control };
  for (const name of ["SUPLEX_ROOT_BINDING", "SUPLEX_ROOT_TOKEN", "SUPLEX_ADVISOR_BINDING", "SUPLEX_ADVISOR_TOKEN"]) delete env[name];
  const { stdout } = await run(process.execPath, [fixture(name), ...args], { cwd: work, env, timeout: 10_000 });
  return { stdout, paused: existsSync(join(control, "paused")), readme: await readFile(join(work, "README.md"), "utf8") };
}

test("the Codex stand-in answers `codex login status` as signed in without a Worker turn", async () => {
  const result = await probe("codex-standard-cli.mjs", ["login", "status"]);
  expect(result).toEqual({ stdout: "Logged in using ChatGPT\n", paused: false, readme: "# Fixture\n" });
});

test("the Claude Code stand-in answers `claude auth status --json` as signed in without a session", async () => {
  const result = await probe("claude-code-standard-cli.mjs", ["auth", "status", "--json"]);
  expect(JSON.parse(result.stdout)).toEqual({ loggedIn: true, authMethod: "claude.ai", email: "suplex-fixture@example.invalid" });
  expect([result.paused, result.readme]).toEqual([false, "# Fixture\n"]);
});

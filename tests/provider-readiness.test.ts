import { expect, test } from "vitest";

import {
  createProviderReadiness,
  createProviderReadinessCheck,
  type ProviderProbeResult,
  type ProviderProbeRunner,
  type ProviderReadinessOptions,
} from "../src/profiles/provider-readiness.js";
import { HARNESS_KINDS } from "../src/runtimes/task-harness-registry.js";
import { providerConnectionFromHealth } from "../src/profiles/provider-connection.js";

const absent = async (): Promise<string> => { throw new Error("Install the tool"); };
const missingExecutable = async (): Promise<string> => { throw Object.assign(new Error("spawn /private/bin/opencode ENOENT"), { code: "ENOENT" }); };
const present = (command = "/private/bin/opencode") => async (): Promise<string> => command;

const probe = (result: ProviderProbeResult | Error): ProviderProbeRunner => async () => {
  if (result instanceof Error) throw result;
  return result;
};

const ok = (stdout: string): ProviderProbeResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false });
const enoent = (): Error => Object.assign(new Error("spawn /private/bin/opencode ENOENT"), { code: "ENOENT" });

test("provider readiness covers exactly the registered harness kinds", async () => {
  const check = createProviderReadiness({ resolveExecutable: present() }, HARNESS_KINDS);
  expect([...HARNESS_KINDS].sort()).toEqual(["claude-code", "codex", "opencode"]);
  await expect(check("claude-code")).resolves.toMatchObject({ provider: "claude-code" });
  await expect(check("codex")).resolves.toMatchObject({ provider: "codex" });
  await expect(check("opencode")).resolves.toMatchObject({ provider: "opencode" });
});

test("OpenCode reports absent, signed-out, signed-in, and indeterminate states", async () => {
  const check = (options: ProviderReadinessOptions) => createProviderReadinessCheck("opencode", options)();

  const missing = await check({ resolveExecutable: absent });
  expect(missing).toMatchObject({ id: "provider:opencode", provider: "opencode", status: "unhealthy", summary: "OpenCode is not installed", remedy: "curl -fsSL https://opencode.ai/install | bash", remedyKind: "command", details: { state: "absent" } });
  expect(JSON.stringify(missing)).not.toMatch(/\/private\//);

  const removed = await check({ resolveExecutable: missingExecutable, runCommand: probe(enoent()) });
  expect(removed).toMatchObject({ status: "unhealthy", details: { state: "absent" } });
  expect(JSON.stringify(removed)).not.toMatch(/\/private\/|ENOENT/);

  const signedOut = await check({ resolveExecutable: present(), runCommand: probe(ok("0 credentials\n")) });
  expect(signedOut).toMatchObject({ status: "unhealthy", summary: "OpenCode is not signed in", remedy: "opencode auth login", remedyKind: "command", details: { command: "opencode", state: "signed-out", credentials: 0 } });
  expect(JSON.stringify(signedOut)).not.toMatch(/\/private\//);

  const signedIn = await check({ resolveExecutable: present(), runCommand: probe(ok("4 credentials\n")) });
  expect(signedIn).toMatchObject({ status: "healthy", summary: "OpenCode is signed in. Model access is not tested.", details: { state: "signed-in", credentials: 4 } });
  expect(JSON.stringify(signedIn)).not.toMatch(/\/private\//);

  const indeterminate = await check({ resolveExecutable: present(), runCommand: probe(new Error("auth list /private/state.db locked")) });
  expect(indeterminate).toMatchObject({ status: "warning", summary: "Suplex could not check the OpenCode sign-in", details: { state: "unknown" } });
  expect(JSON.stringify(indeterminate)).not.toMatch(/private/);
});

test("Claude Code reports absent, signed-out, signed-in, and indeterminate states", async () => {
  const check = (options: ProviderReadinessOptions) => createProviderReadinessCheck("claude-code", options)();

  const missing = await check({ resolveExecutable: absent });
  expect(missing).toMatchObject({ id: "provider:claude-code", provider: "claude-code", status: "unhealthy", summary: "Claude Code is not installed", remedy: "curl -fsSL https://claude.ai/install.sh | bash", remedyKind: "command", details: { state: "absent" } });

  const signedOut = await check({ resolveExecutable: present("/private/bin/claude"), runCommand: probe(ok(JSON.stringify({ loggedIn: false, email: "private-account@example.com", orgName: "private-org" }))) });
  expect(signedOut).toMatchObject({ status: "unhealthy", summary: "Claude Code is not signed in", remedy: "claude auth login", details: { command: "claude", state: "signed-out" } });
  expect(JSON.stringify(signedOut)).not.toMatch(/private|account|@|org/);

  const signedIn = await check({ resolveExecutable: present("/private/bin/claude"), runCommand: probe(ok(JSON.stringify({ loggedIn: true, email: "private-account@example.com", orgName: "private-org" }))) });
  expect(signedIn).toMatchObject({ status: "healthy", summary: "Claude Code is signed in. Model access is not tested.", details: { state: "signed-in" } });
  expect(JSON.stringify(signedIn)).not.toMatch(/private|account|@|org/);

  const malformed = await check({ resolveExecutable: present("/private/bin/claude"), runCommand: probe(ok("not json /private/config")) });
  expect(malformed).toMatchObject({ status: "warning", summary: "Claude Code is installed. Suplex could not check the sign-in.", details: { state: "present" } });
  expect(JSON.stringify(malformed)).not.toMatch(/private/);

  const failed = await check({ resolveExecutable: present("/private/bin/claude"), runCommand: probe({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false }) });
  expect(failed).toMatchObject({ status: "warning", summary: "Suplex could not check the Claude Code sign-in", details: { state: "unknown" } });
});

test("provider listings can request the authenticated Claude account without exposing other auth fields", async () => {
  for (const loggedIn of [true, false]) {
    const check = await createProviderReadinessCheck("claude-code", {
      resolveExecutable: present("claude"), includeAccount: true,
      runCommand: probe(ok(JSON.stringify({ loggedIn, email: "person@example.com", orgId: "private-org", token: "secret-value" }))),
    })();
    const connection = providerConnectionFromHealth(check);
    expect(connection.account).toBe(loggedIn ? "person@example.com" : undefined);
    expect(JSON.stringify(check)).not.toMatch(/private-org|secret-value/);
  }
});

test("Codex CLI reports absent, signed-out, signed-in, and indeterminate states", async () => {
  const check = (options: ProviderReadinessOptions) => createProviderReadinessCheck("codex", options)();
  const said = (stderr: string, exitCode: number): ProviderProbeResult => ({ stdout: "", stderr, exitCode, timedOut: false });

  const missing = await check({ resolveExecutable: absent });
  expect(missing).toMatchObject({ id: "provider:codex", provider: "codex", status: "unhealthy", summary: "Codex CLI is not installed", remedy: "npm install -g @openai/codex", remedyKind: "command", details: { state: "absent" } });

  const signedOut = await check({ resolveExecutable: present("/private/bin/codex"), runCommand: probe(said("Not logged in\n", 1)) });
  expect(signedOut).toMatchObject({ status: "unhealthy", summary: "Codex CLI is not signed in", remedy: "codex login", remedyKind: "command", details: { command: "codex", state: "signed-out" } });
  expect(JSON.stringify(signedOut)).not.toMatch(/private/);

  const signedIn = await check({ resolveExecutable: present("/private/bin/codex"), runCommand: probe(said("\x1b[1mLogged in using ChatGPT\x1b[0m\n", 0)) });
  expect(signedIn).toMatchObject({ status: "healthy", summary: "Codex CLI is signed in. Model access is not tested.", details: { command: "codex", state: "signed-in" } });
  expect(JSON.stringify(signedIn)).not.toMatch(/private/);

  const indeterminate = await check({ resolveExecutable: present("/private/bin/codex"), runCommand: probe({ stdout: "", stderr: "", exitCode: null, timedOut: true }) });
  expect(indeterminate).toMatchObject({ status: "warning", summary: "Suplex could not check the Codex CLI sign-in", details: { state: "unknown" } });
});

test("provider checks probe their documented sign-in commands", async () => {
  const calls: string[][] = [];
  const runCommand: ProviderProbeRunner = async (_command, args) => {
    calls.push([...args]);
    return ok("0 credentials\n");
  };
  await createProviderReadinessCheck("opencode", { resolveExecutable: present(), runCommand })();
  expect(calls).toEqual([["auth", "list"]]);

  calls.length = 0;
  const claudeProbe: ProviderProbeRunner = async (_command, args) => {
    calls.push([...args]);
    return ok(JSON.stringify({ loggedIn: true }));
  };
  await createProviderReadinessCheck("claude-code", { resolveExecutable: present("/private/bin/claude"), runCommand: claudeProbe })();
  expect(calls).toEqual([["auth", "status", "--json"]]);

  calls.length = 0;
  const codexProbe: ProviderProbeRunner = async (_command, args) => {
    calls.push([...args]);
    return ok("Logged in using ChatGPT\n");
  };
  await createProviderReadinessCheck("codex", { resolveExecutable: present("/private/bin/codex"), runCommand: codexProbe })();
  expect(calls).toEqual([["login", "status"]]);
});

test("Claude Code readiness passes the local instance environment to its probe", async () => {
  let environment: NodeJS.ProcessEnv | undefined;
  const runCommand: ProviderProbeRunner = async (_command, _args, options) => {
    environment = options.env;
    return ok(JSON.stringify({ loggedIn: true }));
  };
  await createProviderReadinessCheck("claude-code", { resolveExecutable: present("claude"), runCommand, env: { CLAUDE_CONFIG_DIR: "/tmp/instance" } })();
  expect(environment?.CLAUDE_CONFIG_DIR).toBe("/tmp/instance");
});

test("a failing probe that later succeeds reports healthy without state reset", async () => {
  let installed = false;
  const resolveExecutable = async (): Promise<string> => {
    if (!installed) throw new Error("Install the tool");
    return "/private/bin/claude";
  };
  const check = createProviderReadinessCheck("claude-code", { resolveExecutable, runCommand: probe(ok(JSON.stringify({ loggedIn: true }))) });
  expect((await check()).status).toBe("unhealthy");
  installed = true;
  expect((await check()).status).toBe("healthy");
});

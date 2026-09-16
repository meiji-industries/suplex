import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { installManifest, runInstallCommand } from "../src/platform/install/command.js";
import { installStage, type InstallContext } from "../src/platform/install/stages.js";
import type { HealthCheck } from "../src/platform/health.js";

function herdrHealth(apiReachable: boolean): HealthCheck {
  return {
    id: "herdr-readiness",
    label: "Herdr",
    status: apiReachable ? "healthy" : "unhealthy",
    summary: apiReachable ? "Herdr API and terminal views are available" : "Forge cannot reach Herdr",
    remedy: "herdr",
    details: { apiReachable },
  };
}

function context(overrides: Partial<InstallContext> = {}): InstallContext {
  return {
    env: {},
    system: { platform: "darwin", arch: "arm64", release: "24.6.0" },
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    progress: () => {},
    wait: async () => {},
    freeBytes: async () => 8 * 1024 ** 3,
    herdrReadiness: async () => herdrHealth(true),
    doctor: async () => [{ status: "PASS", name: "database schema", detail: "current (9/9 migrations)" }],
    ...overrides,
  };
}

function stage(name: string): NonNullable<ReturnType<typeof installStage>> {
  const found = installStage(name);
  if (!found) throw new Error(`Missing install stage: ${name}`);
  return found;
}

async function capture(args: string[], installContext?: InstallContext): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  try {
    const code = installContext ? await runInstallCommand(args, installContext) : await runInstallCommand(args);
    return { code, stdout: chunks.join("") };
  } finally {
    write.mockRestore();
  }
}

test("the manifest names every stage the desktop app runs", async () => {
  expect(installManifest()).toEqual({
    protocolVersion: 1,
    stages: [
      { name: "prerequisites", title: "Check this Mac" },
      { name: "developer-tools", title: "Install Apple developer tools (git)" },
      { name: "herdr", title: "Install Herdr terminals" },
      { name: "data", title: "Prepare Forge data" },
      { name: "complete", title: "Finish" },
    ],
  });
  const manifest = await capture(["--manifest"]);
  expect(manifest.code).toBe(0);
  expect(manifest.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify(installManifest()));
});

test("prerequisites pass on an Apple silicon Mac with room to spare", async () => {
  expect(await stage("prerequisites").run(context())).toEqual({ ok: true, reason: "macOS 24.6.0 on arm64 with 8.0 GB free" });
});

test("prerequisites fail on a full disk and on an older macOS", async () => {
  expect(await stage("prerequisites").run(context({ freeBytes: async () => 512 * 1024 ** 2 }))).toMatchObject({ ok: false, reason: expect.stringContaining("2 GB") });
  expect(await stage("prerequisites").run(context({ system: { platform: "darwin", arch: "arm64", release: "21.6.0" } }))).toMatchObject({ ok: false, reason: expect.stringContaining("macOS 13") });
});

test("developer tools skip themselves when git and the tools are already installed", async () => {
  const outcome = await stage("developer-tools").run(context({
    run: async (command) => ({ exitCode: 0, stdout: command === "git" ? "git version 2.50.1" : "/Library/Developer/CommandLineTools", stderr: "" }),
  }));
  expect(outcome).toEqual({ ok: true, skipped: true, reason: "git version 2.50.1 already installed" });
});

test("developer tools fail when the Apple installer never finishes", async () => {
  let waits = 0;
  const outcome = await stage("developer-tools").run(context({
    run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    wait: async () => { waits += 1; },
  }));
  expect(waits).toBe(360);
  expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("30 minutes") });
});

test("herdr skips itself when the CLI is installed and the server answers", async () => {
  const commands: string[] = [];
  const outcome = await stage("herdr").run(context({
    run: async (command, args) => { commands.push([command, ...args].join(" ")); return { exitCode: 0, stdout: "herdr 0.9.0", stderr: "" }; },
  }));
  expect(commands).toEqual(["herdr --version"]);
  expect(outcome).toEqual({ ok: true, skipped: true, reason: "Herdr API and terminal views are available" });
});

test("herdr reports the curl exit code when the installer cannot be downloaded", async () => {
  const outcome = await stage("herdr").run(context({
    run: async (command) => command === "curl" ? { exitCode: 22, stdout: "", stderr: "" } : { exitCode: null, stdout: "", stderr: "" },
  }));
  expect(outcome).toEqual({ ok: false, reason: "curl exited 22", remedy: "Check the network connection and try again." });
});

test("herdr starts the server headlessly and waits for the socket API", async () => {
  const commands: string[] = [];
  let reachable = false;
  const outcome = await stage("herdr").run(context({
    run: async (command, args) => { commands.push([command, ...args].join(" ")); return { exitCode: 0, stdout: "", stderr: "" }; },
    herdrReadiness: async () => herdrHealth(reachable),
    wait: async () => { reachable = true; },
  }));
  expect(commands).toEqual(["herdr --version", "sh -c nohup herdr server >/dev/null 2>&1 &"]);
  expect(outcome).toMatchObject({ ok: true, skipped: false });
});

test("data writes the local environment file, migrates, and skips the second run", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-install-data-"));
  try {
    const env = {
      FORGE_ACCESS_MODE: "local",
      FORGE_DATA_ROOT: join(root, "data"),
      FORGE_ENV_FILE: join(root, "forge.env"),
      FORGE_PORT: "4222",
    };
    const first = await stage("data").run(context({ env }));
    expect(first).toMatchObject({ ok: true, skipped: false, reason: expect.stringContaining("schema current") });
    expect(await readFile(env.FORGE_ENV_FILE, "utf8")).toMatch(/^\s*FORGE_ACCESS_MODE=local\nFORGE_BIND_ADDRESS=127\.0\.0\.1\nFORGE_PORT=4222\n$/);
    expect(await stage("data").run(context({ env }))).toMatchObject({ ok: true, skipped: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete fails with the doctor check that failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-install-complete-"));
  try {
    const env = { FORGE_ACCESS_MODE: "local", FORGE_DATA_ROOT: join(root, "data"), FORGE_ENV_FILE: join(root, "forge.env") };
    expect(await stage("complete").run(context({ env }))).toEqual({ ok: true, reason: "1 checks passed" });
    const failing = await capture(["--stage", "complete", "--json"], context({
      env,
      doctor: async () => [{ status: "FAIL", name: "Herdr", detail: "Forge cannot reach Herdr (herdr)" }],
    }));
    expect(failing.code).toBe(1);
    expect(failing.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify({
      ok: false,
      stage: "complete",
      skipped: false,
      reason: "Herdr: Forge cannot reach Herdr (herdr)",
      remedy: "Fix the failing check and run the install again.",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown stage is a failed frame and a non-zero exit", async () => {
  const unknown = await capture(["--stage", "wat", "--json"], context());
  expect(unknown.code).toBe(1);
  expect(unknown.stdout.trim()).toBe(JSON.stringify({ ok: false, stage: "wat", skipped: false, reason: "Unknown install stage: wat" }));
});

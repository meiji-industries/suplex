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
    summary: apiReachable ? "Herdr API and terminal views are available" : "Suplex cannot reach Herdr",
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
      { name: "data", title: "Prepare Suplex data" },
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

test("prerequisites pass on an Intel Mac", async () => {
  expect(await stage("prerequisites").run(context({ system: { platform: "darwin", arch: "x64", release: "24.6.0" } }))).toEqual({ ok: true, reason: "macOS 24.6.0 on x64 with 8.0 GB free" });
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

test("developer tools accept the Xcode license through the administrator dialog", async () => {
  let accepted = false;
  const outcome = await stage("developer-tools").run(context({
    run: async (command) => {
      if (command === "osascript") { accepted = true; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (command === "git") return accepted ? { exitCode: 0, stdout: "git version 2.50.1 (Apple Git-155)", stderr: "" } : { exitCode: 69, stdout: "You have not agreed to the Xcode and Apple SDKs license.", stderr: "" };
      return { exitCode: 0, stdout: "/Library/Developer/CommandLineTools", stderr: "" };
    },
  }));
  expect(outcome).toEqual({ ok: true, reason: "git version 2.50.1 (Apple Git-155) after accepting the Xcode license" });
});

test("developer tools fail with a remedy when the license dialog is cancelled", async () => {
  const outcome = await stage("developer-tools").run(context({
    run: async (command) => command === "osascript"
      ? { exitCode: 1, stdout: "", stderr: "User canceled." }
      : command === "git" ? { exitCode: 69, stdout: "You have not agreed to the Xcode and Apple SDKs license.", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" },
  }));
  expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("User canceled"), remedy: expect.stringContaining("xcodebuild -license accept") });
});

test("developer tools fail fast when macOS says they are installed but git does not work", async () => {
  let waits = 0;
  const outcome = await stage("developer-tools").run(context({
    run: async (command, args) => command === "git"
      ? { exitCode: 1, stdout: "", stderr: "xcrun: error: invalid active developer path" }
      : args[0] === "--install"
        ? { exitCode: 1, stdout: "", stderr: "xcode-select: note: Command line tools are already installed." }
        : { exitCode: 0, stdout: "/Library/Developer/CommandLineTools", stderr: "" },
    wait: async () => { waits += 1; },
  }));
  expect(waits).toBe(0);
  expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("invalid active developer path"), remedy: expect.stringContaining("xcode-select --install") });
});

test("herdr stops a stale server that needs a restart before starting the new one", async () => {
  const commands: string[] = [];
  let stopped = false;
  const outcome = await stage("herdr").run(context({
    run: async (command, args) => {
      const line = [command, ...args].join(" ");
      commands.push(line);
      if (line === "herdr server stop") stopped = true;
      if (line === "herdr status server --json") return { exitCode: 0, stdout: JSON.stringify({ running: true, restart_needed: !stopped, compatible: stopped, version: "0.8.2" }), stderr: "" };
      return { exitCode: 0, stdout: "herdr 0.9.0", stderr: "" };
    },
    herdrReadiness: async () => herdrHealth(stopped),
  }));
  expect(commands.indexOf("herdr server stop")).toBeGreaterThan(-1);
  expect(commands.indexOf("herdr server stop")).toBeLessThan(commands.findIndex(line => line.includes("nohup herdr server")));
  expect(outcome).toMatchObject({ ok: true });
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
  expect(commands).toEqual(["herdr --version", "herdr status server --json", "sh -c nohup herdr server >/dev/null 2>&1 &"]);
  expect(outcome).toMatchObject({ ok: true, skipped: false });
});

test("data writes the local environment file, migrates, and skips the second run", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-install-data-"));
  try {
    const env = {
      SUPLEX_ACCESS_MODE: "local",
      SUPLEX_DATA_ROOT: join(root, "data"),
      SUPLEX_ENV_FILE: join(root, "suplex.env"),
      SUPLEX_PORT: "4222",
    };
    const first = await stage("data").run(context({ env }));
    expect(first).toMatchObject({ ok: true, skipped: false, reason: expect.stringContaining("schema current") });
    expect(await readFile(env.SUPLEX_ENV_FILE, "utf8")).toMatch(/^\s*SUPLEX_ACCESS_MODE=local\nSUPLEX_BIND_ADDRESS=127\.0\.0\.1\nSUPLEX_PORT=4222\n$/);
    expect(await stage("data").run(context({ env }))).toMatchObject({ ok: true, skipped: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete fails with the doctor check that failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-install-complete-"));
  try {
    const env = { SUPLEX_ACCESS_MODE: "local", SUPLEX_DATA_ROOT: join(root, "data"), SUPLEX_ENV_FILE: join(root, "suplex.env") };
    expect(await stage("complete").run(context({ env }))).toEqual({ ok: true, reason: "1 checks passed" });
    const failing = await capture(["--stage", "complete", "--json"], context({
      env,
      doctor: async () => [{ status: "FAIL", name: "Herdr", detail: "Suplex cannot reach Herdr (herdr)" }],
    }));
    expect(failing.code).toBe(1);
    expect(failing.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify({
      ok: false,
      stage: "complete",
      skipped: false,
      reason: "Herdr: Suplex cannot reach Herdr (herdr)",
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

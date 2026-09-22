import { expect, test, vi } from "vitest";

import { createTestConfig } from "../src/platform/config.js";
import { SuplexDatabase } from "../src/platform/database.js";
import { checkGit, checkPnpm, checkTailscale, createHostHealthDependencies } from "../src/platform/host-health.js";
import type { HealthCheck } from "../src/platform/health.js";
import type { CommandRunner } from "../src/profiles/provider-readiness.js";

const probes = [
  { name: "Git", factory: checkGit, id: "git", args: ["--version"], timeout: 3_000, maxBuffer: 4 * 1024, stdout: "git version 2.47.0\n", details: { version: "2.47.0" }, failurePrefix: "version", failedStatus: "unhealthy" },
  { name: "pnpm", factory: checkPnpm, id: "pnpm", args: ["--version"], timeout: 3_000, maxBuffer: 4 * 1024, stdout: "11.22.0\n", details: { version: "11.22.0" }, failurePrefix: "version", failedStatus: "warning" },
  { name: "Tailscale", factory: checkTailscale, id: "tailscale", args: ["status", "--json"], timeout: 5_000, maxBuffer: 256 * 1024, stdout: JSON.stringify({ Self: { DNSName: "suplex.tailnet.ts.net." }, User: { login: "private-account" } }), details: { hostname: "suplex.tailnet.ts.net" }, failurePrefix: "status", failedStatus: "warning" },
] satisfies Array<{ name: string; factory: (command: string, runner: CommandRunner) => () => Promise<HealthCheck>; id: string; args: string[]; timeout: number; maxBuffer: number; stdout: string; details: HealthCheck["details"]; failurePrefix: string; failedStatus: string }>;

test.each(probes)("$name checks only the expected command and publishes safe facts", async (probe) => {
  const runner = vi.fn<CommandRunner>().mockResolvedValue({ stdout: probe.stdout, stderr: "private-diagnostic" });
  const result = await probe.factory(process.execPath, runner)();
  expect(runner).toHaveBeenCalledExactlyOnceWith(process.execPath, probe.args, { timeout: probe.timeout, maxBuffer: probe.maxBuffer });
  expect(result).toMatchObject({ id: probe.id, status: "healthy", details: probe.details });
  expect(result.remedy).toBeUndefined();
  expect(JSON.stringify(result)).not.toMatch(/private|provider|account/);
});

for (const probe of probes) {
  test.each([
    { name: "nonzero exit", error: new Error("/private/bin/tool exited with status 1, private-account"), failure: `${probe.failurePrefix}-failed` },
    { name: "timeout", error: new Error("/private/bin/tool timed out, private-account"), failure: `${probe.failurePrefix}-timeout` },
  ])(`${probe.name} redacts $name failures`, async ({ error, failure }) => {
    const result = await probe.factory(process.execPath, async () => { throw error; })();
    expect(result).toMatchObject({ status: probe.failedStatus, details: { failure } });
    expect(JSON.stringify(result)).not.toMatch(/private|provider|account/);
  });
}

test.each(probes)("$name rejects malformed output without exposing it", async (probe) => {
  const result = await probe.factory(process.execPath, async () => ({ stdout: "private unexpected output", stderr: "" }))();
  expect(result).toMatchObject({ status: probe.failedStatus, details: { failure: `${probe.failurePrefix}-format` } });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("a missing Git reports not installed with the macOS command and a brew alternative only when brew resolves", async () => {
  const missing = async () => { throw Object.assign(new Error("spawn /private/bin/git ENOENT"), { code: "ENOENT" }); };
  const withBrew = await checkGit("git", missing, { platform: "darwin", brewOnPath: async () => true })();
  expect(withBrew).toMatchObject({ status: "unhealthy", summary: "Git is not installed", remedy: "xcode-select --install", details: { failure: "command-missing", alternative: "brew install git" } });
  const withoutBrew = await checkGit("git", missing, { platform: "darwin", brewOnPath: async () => false })();
  expect(withoutBrew.remedy).toBe("xcode-select --install");
  expect(withoutBrew.details).not.toHaveProperty("alternative");
  expect(JSON.stringify(withBrew)).not.toMatch(/private/);
});

test.each(["linux", "win32"] as const)("a missing Git on %s points at the official download page", async (platform) => {
  const missing = async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); };
  const result = await checkGit("git", missing, { platform })();
  expect(result).toMatchObject({ status: "unhealthy", summary: "Git is not installed", remedy: "https://git-scm.com/downloads", remedyKind: "link" });
});

test.each([
  { name: "nonzero exit", error: new Error("git exited with status 1") },
  { name: "timeout", error: new Error("git timed out") },
])("a $name Git probe is never reported as not installed", async ({ error }) => {
  const result = await checkGit("git", async () => { throw error; }, { platform: "darwin" })();
  expect(result.summary).toBe("Git did not report a version");
  expect(result.summary).not.toContain("not installed");
});

test.each(["not-json", '{"Self":{"DNSName":4}}', '{"Self":{"DNSName":"private-host.example.com"}}', '{}'])("Tailscale rejects malformed or missing host status: %s", async (stdout) => {
  const result = await checkTailscale("tailscale", async () => ({ stdout, stderr: "" }))();
  expect(result).toMatchObject({ status: "warning", details: { failure: "status-format" }, remedy: "Open the Tailscale app and sign in" });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("host dependencies register Tailscale only for Tailscale binding or Serve and expose provider readiness", async () => {
  const config = createTestConfig(":memory:");
  const database = new SuplexDatabase(":memory:");
  try {
    expect(createHostHealthDependencies({ ...config, bindAddress: "127.0.0.1", tailscaleExposure: "direct" }, database)).not.toHaveProperty("tailscale");
    expect(createHostHealthDependencies({ ...config, bindAddress: "100.100.1.2", tailscaleExposure: "direct" }, database)).toHaveProperty("tailscale");
    expect(createHostHealthDependencies({ ...config, bindAddress: "127.0.0.1", tailscaleExposure: "serve" }, database)).toHaveProperty("tailscale");
    const dependencies = createHostHealthDependencies(config, database);
    // Provider checks exist exactly for the harness kinds registered in src/task-harness-registry.ts.
    vi.stubEnv("SUPLEX_OPENCODE_COMMAND", "/private/not-installed/opencode");
    const result = await dependencies.provider("opencode");
    expect(result).toMatchObject({ id: "provider:opencode", provider: "opencode", status: "unhealthy", summary: "OpenCode is not installed", remedy: "curl -fsSL https://opencode.ai/install | bash", details: { state: "absent" } });
    expect(JSON.stringify(result)).not.toContain("private");
  } finally {
    vi.unstubAllEnvs();
    database.close();
  }
});

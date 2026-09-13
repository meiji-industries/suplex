import { expect, test } from "vitest";

import { checkHerdrReadiness, type HerdrReadinessCommand } from "../src/integrations/herdr/readiness.js";
import { inspectHostHealth, type HealthCheck } from "../src/platform/health.js";
import { createTestConfig } from "../src/platform/config.js";

function runner(outputs: readonly string[]): { run: HerdrReadinessCommand; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    run: async (input) => {
      calls.push([...input.args]);
      return { stdout: outputs[index++] ?? "", stderr: "", exitCode: 0, timedOut: false };
    },
  };
}

const enoent = (): Error => Object.assign(new Error("spawn /private/bin/herdr ENOENT"), { code: "ENOENT" });

const runningServer = JSON.stringify({
  status: "running",
  running: true,
  version: "0.9.0",
  protocol: 22,
  compatible: true,
  endpoint_compatible: true,
  socket: "/private/herdr.sock",
});

test("reports a reachable matching Herdr client and server", async () => {
  const command = runner(["herdr 0.9.0\n", runningServer]);
  const result = await checkHerdrReadiness({ runCommand: command.run, listWorkspaces: async () => [] });

  expect(command.calls).toEqual([["--version"], ["status", "server", "--json"]]);
  expect(result).toEqual({
    id: "herdr-readiness",
    label: "Herdr",
    status: "healthy",
    summary: "Herdr API and terminal views are available",
    details: {
      apiReachable: true,
      cliPresent: true,
      clientVersion: "0.9.0",
      serverVersion: "0.9.0",
      privateProtocol: 22,
      privateProtocolCompatibility: "compatible",
      endpointCompatibility: "compatible",
    },
  });
  expect(JSON.stringify(result)).not.toContain("/private/");
});

test("a missing CLI reports not installed with the documented install command", async () => {
  const result = await checkHerdrReadiness({
    runCommand: async () => { throw enoent(); },
    listWorkspaces: async () => { throw enoent(); },
  });

  expect(result.status).toBe("unhealthy");
  expect(result.summary).toBe("Herdr is not installed");
  expect(result.remedy).toBe("curl -fsSL https://herdr.dev/install.sh | sh");
  expect(result.details.cliPresent).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/\/private\/bin|ENOENT/);
});

test("a present CLI with an unreachable API reports Forge cannot reach Herdr", async () => {
  const command = runner(["herdr 0.9.0\n", "status: stopped\n"]);
  const result = await checkHerdrReadiness({
    runCommand: command.run,
    listWorkspaces: async () => { throw new Error("connect /private/herdr.sock"); },
  });

  expect(result.status).toBe("unhealthy");
  expect(result.summary).toBe("Forge cannot reach Herdr");
  expect(result.remedy).toBe("herdr");
  expect(result.details).toMatchObject({ apiReachable: false, cliPresent: true, failure: "api-unreachable" });
  expect(JSON.stringify(result)).not.toContain("/private/");
});

test("an incompatible private protocol warns with a restart remedy", async () => {
  const command = runner([
    "herdr 0.9.0\n",
    JSON.stringify({ status: "running", running: true, version: "0.8.2", protocol: 20, compatible: false, endpoint_compatible: true, socket: "/private/herdr.sock" }),
  ]);
  const result = await checkHerdrReadiness({ runCommand: command.run, listWorkspaces: async () => [] });

  expect(result.status).toBe("warning");
  expect(result.summary).toBe("Restart Herdr for terminal views");
  expect(result.remedy).toBe("herdr server stop && herdr");
  expect(result.details).toMatchObject({
    apiReachable: true,
    privateProtocol: 20,
    privateProtocolCompatibility: "incompatible",
    endpointCompatibility: "compatible",
    failure: "protocol-incompatible",
  });
  expect(JSON.stringify(result)).not.toContain("/private/");
});

test("a reachable API with missing diagnostics warns and is never reported missing", async () => {
  const command = runner(["herdr 0.9.0\n", "not diagnostic output /private/herdr.sock\n"]);
  const result = await checkHerdrReadiness({ runCommand: command.run, listWorkspaces: async () => [] });

  expect(result.status).toBe("warning");
  expect(result.summary).toBe("Herdr diagnostics are incomplete");
  expect(result.summary).not.toContain("not installed");
  expect(result.details).toMatchObject({
    apiReachable: true,
    clientVersion: "0.9.0",
    serverVersion: "unknown",
    privateProtocolCompatibility: "unknown",
    failure: "diagnostics-incomplete",
  });
  expect(JSON.stringify(result)).not.toContain("/private/");
});

test("a reachable API with a failed status probe warns with incomplete diagnostics", async () => {
  const statusFailed: HerdrReadinessCommand = async (input) => {
    if (input.args[0] === "status") throw new Error("status failed /private/herdr.sock");
    return { stdout: "herdr 0.9.0\n", stderr: "", exitCode: 0, timedOut: false };
  };
  const result = await checkHerdrReadiness({ runCommand: statusFailed, listWorkspaces: async () => [] });

  expect(result.status).toBe("warning");
  expect(result.summary).toBe("Herdr diagnostics are incomplete");
  expect(JSON.stringify(result)).not.toContain("/private/");
});

test("an ambiguous probe reports Forge could not check Herdr", async () => {
  const timedOut: HerdrReadinessCommand = async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true });
  const result = await checkHerdrReadiness({ runCommand: timedOut, listWorkspaces: async () => { throw new Error("unreachable"); } });

  expect(result.status).toBe("warning");
  expect(result.summary).toBe("Forge could not check Herdr");
  expect(result.details).toMatchObject({ apiReachable: false, failure: "probe-ambiguous" });
});

test("a timed-out version probe with a reachable API still reports diagnostics", async () => {
  const command: HerdrReadinessCommand = async (input) =>
    input.args[0] === "--version"
      ? { stdout: "", stderr: "", exitCode: null, timedOut: true }
      : { stdout: runningServer, stderr: "", exitCode: 0, timedOut: false };
  const result = await checkHerdrReadiness({ runCommand: command, listWorkspaces: async () => [] });

  expect(result.status).toBe("warning");
  expect(result.summary).toBe("Forge could not check Herdr");
  expect(result.details).toMatchObject({ apiReachable: true, clientVersion: "unknown", privateProtocolCompatibility: "compatible" });
});

test("Herdr failures do not block host readiness", async () => {
  const check = (id: HealthCheck["id"], status: HealthCheck["status"]): HealthCheck => ({
    id,
    label: id,
    status,
    summary: status,
    details: {},
  });
  const snapshot = await inspectHostHealth(createTestConfig("/tmp/forge-health-test"), {
    database: async () => check("database", "healthy"),
    artifactRoot: async () => check("artifact-root", "healthy"),
    herdrReadiness: async () => check("herdr-readiness", "unhealthy"),
    ghAuth: async () => check("gh-auth", "healthy"),
  });

  expect(snapshot.ready).toBe(true);
});

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

test("reports a reachable matching Herdr client and server", async () => {
  const command = runner([
    "herdr 0.8.2\n",
    JSON.stringify({
      status: "running",
      running: true,
      version: "0.8.2",
      protocol: 20,
      capabilities: { live_handoff: true, detached_server_daemon: true },
      compatible: true,
      socket: "/private/herdr.sock",
      session: null,
      restart_needed: false,
    }),
  ]);
  const result = await checkHerdrReadiness({ runCommand: command.run, listWorkspaces: async () => [] });

  expect(command.calls).toEqual([["--version"], ["status", "server", "--json"]]);
  expect(result).toEqual({
    id: "herdr-readiness",
    label: "Herdr readiness",
    status: "healthy",
    summary: "Herdr API and terminal views are available",
    details: {
      apiReachable: true,
      clientVersion: "0.8.2",
      serverVersion: "0.8.2",
      privateProtocol: 20,
      privateProtocolCompatibility: "compatible",
      endpointCompatibility: "unknown",
    },
  });
  expect(JSON.stringify(result)).not.toContain("/private/");
});

test("warns when endpoint generation is compatible but the private terminal protocol is not", async () => {
  const command = runner([
    "herdr 0.9.0\n",
    JSON.stringify({
      status: "running",
      running: true,
      version: "0.8.2",
      protocol: 20,
      capabilities: { endpoint_protocol_generation: 1 },
      compatible: false,
      endpoint_compatible: true,
      socket: "/private/herdr.sock",
    }),
  ]);
  const result = await checkHerdrReadiness({ runCommand: command.run, listWorkspaces: async () => [] });

  expect(result.status).toBe("warning");
  expect(result.summary).toBe("Herdr API is reachable. Restart Herdr for terminal views.");
  expect(result.details).toMatchObject({
    clientVersion: "0.9.0",
    serverVersion: "0.8.2",
    privateProtocol: 20,
    privateProtocolCompatibility: "incompatible",
    endpointCompatibility: "compatible",
  });
});

test("accepts different client and server versions when Herdr reports private compatibility", async () => {
  const command = runner([
    "herdr 0.10.1\n",
    "status: running\nversion: 0.9.4\nendpoint_compatible: yes\nprivate_protocol: 22\nprivate_protocol_compatible: yes\n",
  ]);
  const result = await checkHerdrReadiness({ runCommand: command.run, listWorkspaces: async () => [] });

  expect(result.status).toBe("healthy");
  expect(result.details).toMatchObject({
    clientVersion: "0.10.1",
    serverVersion: "0.9.4",
    privateProtocol: 22,
    privateProtocolCompatibility: "compatible",
    endpointCompatibility: "compatible",
  });
});

test("reports a missing Herdr command without exposing the failure", async () => {
  const missing = Object.assign(new Error("/private/bin/herdr was not found"), { code: "ENOENT" });
  const result = await checkHerdrReadiness({
    runCommand: async () => { throw missing; },
    listWorkspaces: async () => { throw missing; },
  });

  expect(result.status).toBe("unhealthy");
  expect(result.summary).toBe("Herdr API is not reachable. Check the Herdr server.");
  expect(result.details).toEqual({
    apiReachable: false,
    clientVersion: "unknown",
    serverVersion: "unknown",
    privateProtocol: "unknown",
    privateProtocolCompatibility: "unknown",
    endpointCompatibility: "unknown",
  });
  expect(JSON.stringify(result)).not.toMatch(/\/private\/bin|not found/);
});

test("reports an unavailable socket even when the client command exists", async () => {
  const command = runner(["herdr 0.9.0\n", "status: stopped\n"]);
  const result = await checkHerdrReadiness({
    runCommand: command.run,
    listWorkspaces: async () => { throw new Error("connect /private/herdr.sock"); },
  });

  expect(result.status).toBe("unhealthy");
  expect(result.details.apiReachable).toBe(false);
  expect(JSON.stringify(result)).not.toContain("/private/");
});

test("warns honestly when status output is malformed", async () => {
  const command = runner(["herdr 0.9.0\n", "not diagnostic output /private/herdr.sock\n"]);
  const result = await checkHerdrReadiness({ runCommand: command.run, listWorkspaces: async () => [] });

  expect(result.status).toBe("warning");
  expect(result.summary).toBe("Herdr API is reachable. Check terminal compatibility.");
  expect(result.details).toMatchObject({
    apiReachable: true,
    clientVersion: "0.9.0",
    serverVersion: "unknown",
    privateProtocol: "unknown",
    privateProtocolCompatibility: "unknown",
  });
  expect(JSON.stringify(result)).not.toContain("/private/");
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
    opencode: async () => check("opencode", "healthy"),
    herdrReadiness: async () => check("herdr-readiness", "unhealthy"),
    ghAuth: async () => check("gh-auth", "healthy"),
  });

  expect(snapshot.ready).toBe(true);
});

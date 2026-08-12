import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { UnsafeBindingError, UnsupportedRuntimeError, loadConfig, temporalConnectionOptions } from "../src/config.js";

const baseEnvironment = {
  FORGE_TAILSCALE_ADDRESS: "forge.tailnet.ts.net",
  FORGE_DATA_ROOT: "/tmp/forge-test-data",
  FORGE_TEMPORAL_TARGET: "cloud",
  FORGE_TEMPORAL_ADDRESS: "test.account.tmprl.cloud:7233",
  FORGE_TEMPORAL_NAMESPACE: "test.account",
  FORGE_TEMPORAL_API_KEY: "test-api-key",
};

test("loads a Tailscale-only configuration and exposes the reachable address", () => {
  const config = loadConfig(baseEnvironment);

  expect(config.accessMode).toBe("tailscale");
  expect(config.bindAddress).toBe("forge.tailnet.ts.net");
  expect(config.reachableAddress).toBe("http://forge.tailnet.ts.net:4111");
  expect(config.repositoryRoot).toBe(join(homedir(), "forge", "repos"));
  expect(config.worktreeRoot).toBe(join(homedir(), "forge", "worktrees"));
  expect(config.temporalNamespace).toBe("test.account");
  expect(config.taskQueue).toBe("tasks-test-installation");
});

test("configures a TLS-authenticated hosted Temporal connection", () => {
  expect(temporalConnectionOptions(loadConfig(baseEnvironment))).toEqual({
    address: "test.account.tmprl.cloud:7233",
    tls: true,
    apiKey: "test-api-key",
  });
});

test("requires the complete hosted Temporal configuration", () => {
  expect(() => loadConfig({ ...baseEnvironment, FORGE_TEMPORAL_API_KEY: undefined })).toThrow(/required for Temporal Cloud/);
});

test("connects to the local Temporal dev server without Cloud credentials", () => {
  const config = loadConfig({
    ...baseEnvironment,
    FORGE_TEMPORAL_TARGET: "local",
    FORGE_TEMPORAL_ADDRESS: "127.0.0.1:7233",
    FORGE_TEMPORAL_NAMESPACE: "forge-dev",
  });

  expect(config.temporalApiKey).toBeUndefined();
  expect(temporalConnectionOptions(config)).toEqual({ address: "127.0.0.1:7233" });
});

test("keeps local and Cloud Temporal targets separate", () => {
  expect(() => loadConfig({ ...baseEnvironment, FORGE_TEMPORAL_TARGET: "local" })).toThrow(/loopback/);
  expect(() => loadConfig({ ...baseEnvironment, FORGE_TEMPORAL_ADDRESS: "127.0.0.1:7233" })).toThrow(/must not use a loopback/);
});

for (const address of [
  "0.0.0.0",
  "::",
  "127.0.0.1",
  "::1",
  "localhost",
  "192.168.1.20",
  "10.0.0.20",
  "*",
]) {
  test(`rejects an unsafe production binding: ${address}`, () => {
    expect(() => loadConfig({ ...baseEnvironment, FORGE_TAILSCALE_ADDRESS: address })).toThrow(UnsafeBindingError);
  });
}

test("accepts a Tailscale IPv4 address", () => {
  const config = loadConfig({ ...baseEnvironment, FORGE_TAILSCALE_ADDRESS: "100.101.102.103" });

  expect(config.reachableAddress).toBe("http://100.101.102.103:4111");
});

test("allows loopback only when Tailscale Serve is the explicit HTTPS boundary", () => {
  const config = loadConfig({
    ...baseEnvironment,
    FORGE_TAILSCALE_EXPOSURE: "serve",
    FORGE_BIND_ADDRESS: "127.0.0.1",
  });

  expect(config.tailscaleExposure).toBe("serve");
  expect(config.reachableAddress).toBe("https://forge.tailnet.ts.net:4111");
});

test("still rejects loopback direct production binding", () => {
  expect(() => loadConfig({ ...baseEnvironment, FORGE_BIND_ADDRESS: "127.0.0.1" })).toThrow(UnsafeBindingError);
});

test("rejects a non-Tailscale access mode", () => {
  expect(() => loadConfig({ ...baseEnvironment, FORGE_ACCESS_MODE: "lan" })).toThrow(UnsafeBindingError);
});

test("rejects an unsupported Node major before loading configuration", () => {
  const original = process.versions.node;
  Object.defineProperty(process.versions, "node", { value: "22.22.1", configurable: true });
  try {
    expect(() => loadConfig(baseEnvironment)).toThrow(UnsupportedRuntimeError);
  } finally {
    Object.defineProperty(process.versions, "node", { value: original, configurable: true });
  }
});

test("requires the exact pinned Node release before loading configuration", () => {
  const original = process.versions.node;
  Object.defineProperty(process.versions, "node", { value: "26.7.1", configurable: true });
  try {
    expect(() => loadConfig(baseEnvironment)).toThrow(/26\.7\.0/);
  } finally {
    Object.defineProperty(process.versions, "node", { value: original, configurable: true });
  }
});

import assert from "node:assert/strict";
import { test } from "vitest";

import { UnsafeBindingError, loadConfig } from "../src/config.js";

const baseEnvironment = {
  FORGE_TAILSCALE_ADDRESS: "forge.tailnet.ts.net",
  FORGE_DATA_ROOT: "/tmp/forge-test-data",
};

test("loads a Tailscale-only configuration and exposes the reachable address", () => {
  const config = loadConfig(baseEnvironment);

  assert.equal(config.accessMode, "tailscale");
  assert.equal(config.bindAddress, "forge.tailnet.ts.net");
  assert.equal(config.reachableAddress, "http://forge.tailnet.ts.net:4111");
  assert.equal(config.temporalNamespace, "runtime-test-installation");
  assert.equal(config.taskQueue, "tasks-test-installation");
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
    assert.throws(
      () => loadConfig({ ...baseEnvironment, FORGE_TAILSCALE_ADDRESS: address }),
      (error: unknown) => error instanceof UnsafeBindingError,
    );
  });
}

test("accepts a Tailscale IPv4 address", () => {
  const config = loadConfig({ ...baseEnvironment, FORGE_TAILSCALE_ADDRESS: "100.101.102.103" });

  assert.equal(config.reachableAddress, "http://100.101.102.103:4111");
});

test("allows loopback only when Tailscale Serve is the explicit HTTPS boundary", () => {
  const config = loadConfig({
    ...baseEnvironment,
    FORGE_TAILSCALE_EXPOSURE: "serve",
    FORGE_BIND_ADDRESS: "127.0.0.1",
  });

  assert.equal(config.tailscaleExposure, "serve");
  assert.equal(config.reachableAddress, "https://forge.tailnet.ts.net:4111");
});

test("still rejects loopback direct production binding", () => {
  assert.throws(
    () => loadConfig({ ...baseEnvironment, FORGE_BIND_ADDRESS: "127.0.0.1" }),
    (error: unknown) => error instanceof UnsafeBindingError,
  );
});

test("rejects a non-Tailscale access mode", () => {
  assert.throws(
    () => loadConfig({ ...baseEnvironment, FORGE_ACCESS_MODE: "lan" }),
    (error: unknown) => error instanceof UnsafeBindingError,
  );
});

test("refuses legacy durable runtime names instead of silently migrating them", () => {
  assert.throws(
    () => loadConfig({ ...baseEnvironment, FORGE_TEMPORAL_NAMESPACE: "forge", FORGE_TASK_QUEUE: "forge" }),
    (error: unknown) => error instanceof UnsafeBindingError,
  );
});

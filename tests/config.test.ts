import { expect, test } from "vitest";

import { UnsafeBindingError, UnsupportedRuntimeError, loadConfig } from "../src/config.js";

const baseEnvironment = {
  FORGE_TAILSCALE_ADDRESS: "forge.tailnet.ts.net",
  FORGE_DATA_ROOT: "/tmp/forge-test-data",
};

test("loads a Tailscale-only configuration and exposes the reachable address", () => {
  const config = loadConfig(baseEnvironment);

  expect(config.accessMode).toBe("tailscale");
  expect(config.bindAddress).toBe("forge.tailnet.ts.net");
  expect(config.reachableAddress).toBe("http://forge.tailnet.ts.net:4111");
  expect(config.temporalNamespace).toBe("runtime-test-installation");
  expect(config.taskQueue).toBe("tasks-test-installation");
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

test("refuses legacy durable runtime names instead of silently migrating them", () => {
  expect(() => loadConfig({ ...baseEnvironment, FORGE_TEMPORAL_NAMESPACE: "forge", FORGE_TASK_QUEUE: "forge" })).toThrow(UnsafeBindingError);
});

test("pins the Temporal server image to an immutable versioned release", () => {
  const config = loadConfig(baseEnvironment);
  expect(config.temporalImage).not.toContain(":latest");
  expect(config.temporalImage).toMatch(/^[^\s]+\/[^:@\s]+:[^:@\s]+@sha256:[a-f0-9]{64}$/);
});

for (const temporalImage of [
  "temporalio/temporal",
  "temporalio/temporal:latest",
  "temporalio/temporal:latest@sha256:cf86707827fac99e4d1c4a47dc11b105382d796199c7bd41fb3213fb0471628e",
  "temporalio/temporal:1.8.2",
  "temporalio/temporal@sha256:cf86707827fac99e4d1c4a47dc11b105382d796199c7bd41fb3213fb0471628e",
]) {
  test(`rejects a non-immutable Temporal image override: ${temporalImage}`, () => {
    expect(() => loadConfig({ ...baseEnvironment, FORGE_TEMPORAL_IMAGE: temporalImage })).toThrow(UnsafeBindingError);
  });
}

test("accepts an explicit immutable Temporal image override", () => {
  const temporalImage = "temporalio/temporal:1.8.3@sha256:cf86707827fac99e4d1c4a47dc11b105382d796199c7bd41fb3213fb0471628e";
  expect(loadConfig({ ...baseEnvironment, FORGE_TEMPORAL_IMAGE: temporalImage }).temporalImage).toBe(temporalImage);
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

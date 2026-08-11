import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { healthProbeAddress, readinessProbePath } from "../src/runtime.js";

test("uses the public auth status endpoint for startup readiness", () => {
  expect(readinessProbePath()).toBe("/api/auth/status");
});

test("probes the local backend when Tailscale Serve owns HTTPS", () => {
  const config = createTestConfig("/tmp/forge-runtime-test", {
    tailscaleExposure: "serve",
    bindAddress: "127.0.0.1",
    reachableAddress: "https://pro2.tail1234.ts.net:4111",
  });

  expect(healthProbeAddress(config)).toBe("http://127.0.0.1:4111");
});

test("probes the configured address for direct Tailscale HTTP", () => {
  const config = createTestConfig("/tmp/forge-runtime-test", {
    reachableAddress: "http://100.87.170.105:4111",
  });

  expect(healthProbeAddress(config)).toBe("http://100.87.170.105:4111");
});

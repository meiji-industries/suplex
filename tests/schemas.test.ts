import { expect, test } from "vitest";

import { HealthSnapshotSchema, ProcessRegistrySchema, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema } from "../src/schemas.js";
import { parseTailscaleHostname, parseTailscaleServeStatus } from "../src/tailscale.js";

test("boundary schemas reject malformed and unexpected values", () => {
  expect(HealthSnapshotSchema.safeParse({ ready: "yes" }).success).toBe(false);
  expect(ProcessRegistrySchema.safeParse({ version: 2, processes: [] }).success).toBe(false);
  expect(ProbeWorkflowInputSchema.safeParse({ workflowId: "w", probeId: 4, companyId: "c" }).success).toBe(false);
  expect(ProbeWorkflowStateSchema.safeParse({ workflowId: "w", probeId: "p", companyId: "c", status: "unknown" }).success).toBe(false);
  expect(() => parseTailscaleHostname("{\"Self\":{\"DNSName\":4}}")).toThrow();
  expect(() => parseTailscaleServeStatus("{\"Web\":[]}")).toThrow();
  expect(() => parseTailscaleHostname("not-json")).toThrow();
  expect(() => parseTailscaleServeStatus("not-json")).toThrow();
});

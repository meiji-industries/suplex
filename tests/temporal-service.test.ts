import type { Client } from "@temporalio/client";
import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { assertLegacyNamespaceProbeOnly, startProbeWorkflow } from "../src/temporal/service.js";

function fakeClient(types: string[]): Client {
  return {
    workflow: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          for (const type of types) {
            yield { type };
          }
        },
      }),
    },
  } as unknown as Client;
}

test("legacy namespace compatibility permits only probe workflow history", async () => {
  await expect(assertLegacyNamespaceProbeOnly(fakeClient(["probeWorkflow"]))).resolves.toBeUndefined();
});

test("legacy namespace compatibility refuses non-probe workflow history", async () => {
  await expect(assertLegacyNamespaceProbeOnly(fakeClient(["probeWorkflow", "issueWorkflow"])))
    .rejects.toThrow("non-probe workflow type issueWorkflow");
});

test("probe workflow starts refuse legacy or foreign installation workflow IDs", async () => {
  const config = createTestConfig("/tmp/forge-neutral-id-test", { installationId: "test-installation" });
  await expect(startProbeWorkflow(config, { workflowId: "forge-old-workflow", probeId: "probe", companyId: "company" }))
    .rejects.toThrow("outside this neutral installation scope");
  await expect(startProbeWorkflow(config, { workflowId: "workflow-other-installation-123", probeId: "probe", companyId: "company" }))
    .rejects.toThrow("outside this neutral installation scope");
});

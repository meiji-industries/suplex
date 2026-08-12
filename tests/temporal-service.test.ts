import type { Connection } from "@temporalio/client";
import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ensureTemporalFoundation, startProbeWorkflow } from "../src/temporal/service.js";

test("probe workflow starts refuse legacy or foreign installation workflow IDs", async () => {
  const config = createTestConfig("/tmp/forge-neutral-id-test", { installationId: "test-installation" });
  await expect(startProbeWorkflow(config, { workflowId: "forge-old-workflow", probeId: "probe", companyId: "company" }))
    .rejects.toThrow("outside this installation scope");
  await expect(startProbeWorkflow(config, { workflowId: "workflow-other-installation-123", probeId: "probe", companyId: "company" }))
    .rejects.toThrow("outside this installation scope");
});

test("hosted Temporal startup refuses a namespace missing required Search Attributes", async () => {
  const connection = {
    workflowService: {
      describeNamespace: async () => ({ config: {} }),
      getSearchAttributes: async () => ({ keys: { CompanyId: 1, ProjectId: 1 } }),
    },
  } as unknown as Connection;

  await expect(ensureTemporalFoundation(connection, createTestConfig("/tmp/forge-hosted-temporal-test")))
    .rejects.toThrow("missing custom Search Attributes: IssueId");
});

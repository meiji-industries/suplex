import { expect, test } from "vitest";

import { HealthSnapshotSchema, ProcessRegistrySchema, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema } from "../src/schemas.js";
import { parseTailscaleHostname, parseTailscaleServeStatus } from "../src/tailscale.js";
import { ContinueWorkCommandSchema, PlanRevisionCommandSchema } from "../src/temporal/issue-contracts.js";
import { ContinueWorkBodySchema, PlanRevisionBodySchema } from "../src/http/contracts/tasks.js";

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

test("revision and continuation commands enforce strict conditional inputs", () => {
  const actorUserId = "member-1";
  const exactBaseSha = "a".repeat(40);
  expect(PlanRevisionCommandSchema.parse({ expectedRevision: 12, actorUserId, reason: "Requirements changed" })).toMatchObject({ worktreeDisposition: "reuse" });
  expect(PlanRevisionCommandSchema.parse({ expectedRevision: 12, actorUserId, reason: "Start from accepted target", worktreeDisposition: "new", exactBaseSha })).toMatchObject({ worktreeDisposition: "reuse" });
  expect(PlanRevisionCommandSchema.parse({ expectedRevision: 12, actorUserId, reason: "reuse", worktreeDisposition: "reuse", exactBaseSha })).toMatchObject({ worktreeDisposition: "reuse" });
  expect(PlanRevisionCommandSchema.parse({ expectedRevision: 12, actorUserId, reason: "new", worktreeDisposition: "new" })).toMatchObject({ worktreeDisposition: "reuse" });
  expect(PlanRevisionCommandSchema.safeParse({ expectedRevision: 12, actorUserId, reason: " ", worktreeDisposition: "new", exactBaseSha }).success).toBe(false);
  expect(PlanRevisionCommandSchema.safeParse({ expectedRevision: 12, actorUserId, reason: "new", worktreeDisposition: "new", exactBaseSha, extra: true }).success).toBe(false);
  expect(ContinueWorkCommandSchema.safeParse({ expectedRevision: 4, actorUserId, reason: "Follow-up scope" }).success).toBe(true);
  expect(ContinueWorkCommandSchema.safeParse({ expectedRevision: 4, actorUserId, reason: "" }).success).toBe(false);
  expect(PlanRevisionBodySchema.safeParse({ expectedRevision: 1, reason: "x" }).success).toBe(true);
  expect(PlanRevisionBodySchema.safeParse({ expectedRevision: 1, reason: "x", worktreeDisposition: "reuse" }).success).toBe(false);
  expect(ContinueWorkBodySchema.safeParse({ expectedRevision: 1, reason: "x", actorUserId }).success).toBe(false);
});

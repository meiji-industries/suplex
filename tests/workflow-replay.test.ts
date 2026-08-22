import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bundleWorkflowCode, ReplayError } from "@temporalio/worker";
import { defaultPayloadConverter, type Payload } from "@temporalio/common";
import { DeterminismViolationError } from "@temporalio/workflow";
import { expect, test } from "vitest";

import { normalizeProtoJsonValue } from "../scripts/capture-workflow-history.js";
import { assertContinuationStateWithinLimit, assertEncodedPayloadBoundary, assertHistoryEventCountWithinLimit, assertPayloadWithinLimit, encodedPayloadSize, PAYLOAD_POLICY, PayloadPolicyViolation, WORKFLOW_HISTORY_EVENT_LIMIT } from "../src/temporal/policy.js";
import { buildProductionWorkflowBundle, productionWorkflowBundleOptions, temporalDataConverter } from "../src/temporal/workflow-bundle.js";
import { auditProductionWorkflowBundle, readReplayHistory, readReplayManifest, replayIssueHistory, replayManifest, workflowBundleSha256 } from "../src/temporal/replay.js";
import { jsonRequired } from "../src/task-utils.js";

const manifestPath = join(process.cwd(), ".scratch/forge-mvp/replay/manifest.json");
const deliveryReviewFixtureNames = [
  "issue-workflow-review-approved.json",
  "issue-workflow-review-repair-fresh-approval.json",
  "issue-workflow-review-format-correction.json",
  "issue-workflow-review-blocker-retry.json",
  "issue-workflow-repair-blocker-retry-cancel.json",
] as const;

function decodedPayloadText(value: unknown, key?: string): string {
  if (Array.isArray(value)) return value.map((entry) => decodedPayloadText(entry)).join("\n");
  if (!value || typeof value !== "object") {
    if (key === "data" && typeof value === "string") {
      try { return Buffer.from(value, "base64").toString("utf8"); } catch { return ""; }
    }
    return "";
  }
  return Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => decodedPayloadText(entryValue, entryKey)).join("\n");
}

function activityCount(history: { events: unknown[] }, activity: string): number {
  return JSON.stringify(history).match(new RegExp(`\\"name\\":\\"${activity}\\"`, "g"))?.length ?? 0;
}

const capacityHistoryFixturePaths = [
  "capacity-two-acquire-third-queued-release-admit.json",
  "ownership-ambiguity-blocker.json",
  "bounded-capacity-exhaustion.json",
  "queued-cancellation.json",
  "rate-limit-reset-reacquire.json",
  "worker-restart-wrapper-reattachment.json",
].map((filename) => join(process.cwd(), ".scratch/forge-mvp/replay", filename));

function decodedPayloads(history: { events: unknown[] }): unknown[] {
  const payloads: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.data === "string" && record.metadata && typeof record.metadata === "object") {
      try { const decoded = jsonRequired(Buffer.from(record.data, "base64").toString("utf8")); payloads.push(decoded); visit(decoded); } catch { /* Non-JSON Temporal payloads are not state checkpoints. */ }
    }
    Object.values(record).forEach(visit);
  };
  visit(history);
  return payloads;
}

async function mutationBundle(mode: "compatible" | "incompatible") {
  const loader = fileURLToPath(new URL("./fixtures/workflow-mutation-loader.cjs", import.meta.url));
  const options = productionWorkflowBundleOptions();
  return bundleWorkflowCode({
    ...options,
    webpackConfigHook(config) {
      config.module ??= {};
      config.module.rules ??= [];
      config.module.rules.unshift({ test: /workflows\.ts$/, enforce: "pre", use: { loader, options: { mode } } });
      return config;
    },
  });
}

test("INV-15 the versioned manifest consumes every sanitized fixture and batch replays the production bundle", async () => {
  const manifest = await readReplayManifest(manifestPath);
  expect(manifest.fixtures).toHaveLength(43);
  expect(manifest.fixtures.map((fixture) => fixture.scenario)).toEqual(expect.arrayContaining([
    "backlog_planning",
    "normal_success",
    "implementation_repair",
    "active_cancellation",
    "blocked_authentication_resume",
    "continue_as_new",
    "release_base_drift_merged",
    "release_base_drift_conflict",
    "ci_wait_retry",
    "acceptance_ready_timeout",
    "acceptance_requested_changes",
    "acceptance_provider_outage",
    "manual_merge_open",
    "manual_merge_closed",
    "manual_merge_changed",
    "final_review_failure",
    "revised_delivery",
    "plan_revision",
    "successor_creation",
    "developer_active_worker_loss",
    "developer_cancellation",
    "developer_linked_retry",
    "developer_result_claim",
    "routine_plan",
    "supplemental_consolidation",
    "consolidated_blocker",
    "stale_duplicate_decision",
    "governance_worker_restart",
    "routine_lead_plan",
    "material_lead_plan",
    "member_revision",
    "decision_blocker",
    "decision_resolution",
    "cancel_while_planning",
    "blocked_configuration",
  ]));
  const continueRuns = manifest.fixtures.filter((fixture) => fixture.scenario === "continue_as_new");
  expect(continueRuns.map((fixture) => fixture.runIndex)).toEqual([0, 1, 2]);
  await replayManifest(manifestPath);
});

test("Codex Lead replay histories preserve plan, blocker, resume, and cancellation semantics", async () => {
  const expectations = [
    { file: "routine-lead-plan.json", kind: "plan", material: false },
    { file: "material-lead-plan.json", kind: "plan", material: true },
    { file: "member-revision.json", resumeReason: "member_revision" },
    { file: "decision-blocker.json", kind: "decision_blocker", blockedCategory: "human_decision" },
    { file: "decision-resolution.json", resumeReason: "decision_resolution", material: true },
    { file: "cancel-while-planning.json" },
    { file: "blocked-configuration.json", blockedCategory: "configuration" },
  ];
  for (const expected of expectations) {
    const history = await readReplayHistory(join(process.cwd(), ".scratch/forge-mvp/replay", expected.file));
    const payloads = decodedPayloads(history);
    if (expected.kind) expect(payloads.some((value) => value && typeof value === "object" && (value as { kind?: unknown }).kind === expected.kind)).toBe(true);
    if (expected.material !== undefined) expect(payloads.some((value) => value && typeof value === "object" && (value as { material?: unknown }).material === expected.material)).toBe(true);
    if (expected.resumeReason) expect(payloads.some((value) => value && typeof value === "object" && (value as { resume?: { reason?: unknown } }).resume?.reason === expected.resumeReason)).toBe(true);
    if (expected.blockedCategory) expect(payloads.some((value) => value && typeof value === "object" && (value as { blockedCategory?: unknown }).blockedCategory === expected.blockedCategory)).toBe(true);
  }
});

test("the captured backlog history still replays through the exact shared bundle", async () => {
  const history = await readReplayHistory(join(process.cwd(), ".scratch/forge-mvp/replay/issue-workflow-backlog-planning.json"));
  await replayIssueHistory(history, "workflow-replay-issue-history");
});

test.each(deliveryReviewFixtureNames)("exact delivery review fixture %s replays through the production bundle", async (fixtureName) => {
  const history = await readReplayHistory(join(process.cwd(), ".scratch/forge-mvp/replay/delivery-review", fixtureName));
  expect(history.events.length).toBeGreaterThan(10);
  await replayIssueHistory(history, `workflow-replay-${fixtureName.replace(/\.json$/, "")}`);
});

test("exact delivery review fixtures retain correction, blocker, repair, and supersession evidence", async () => {
  const directory = join(process.cwd(), ".scratch/forge-mvp/replay/delivery-review");
  const repaired = await readReplayHistory(join(directory, "issue-workflow-review-repair-fresh-approval.json"));
  const correction = await readReplayHistory(join(directory, "issue-workflow-review-format-correction.json"));
  const reviewBlocked = await readReplayHistory(join(directory, "issue-workflow-review-blocker-retry.json"));
  const repairBlocked = await readReplayHistory(join(directory, "issue-workflow-repair-blocker-retry-cancel.json"));
  expect(activityCount(repaired, "runDeveloperRepair")).toBe(1);
  expect(decodedPayloadText(repaired)).toContain('"supersedesReviewId":"review_blocking"');
  expect(decodedPayloadText(correction)).toContain('"correctionAttempts":1');
  expect(decodedPayloadText(reviewBlocked)).toContain('"code":"process-failed"');
  expect(activityCount(repairBlocked, "runDeveloperRepair")).toBe(2);
  expect(decodedPayloadText(repairBlocked)).toContain('"code":"repair-cap-exhausted"');
});

test("the five recovery fixtures contain the intended durable Temporal events", async () => {
  const read = async (scenario: string) => jsonRequired(await readFile(join(process.cwd(), ".scratch/forge-mvp/replay", `issue-workflow-${scenario}.json`), "utf8")) as { events: Array<Record<string, unknown>> };
  const decoded = (value: unknown, found: unknown[] = []): unknown[] => {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { data?: unknown }).data === "string" && (value as { metadata?: unknown }).metadata && typeof (value as { metadata?: unknown }).metadata === "object") {
      const payload = value as { data: string; metadata: Record<string, string> };
      try { found.push(defaultPayloadConverter.fromPayload({ ...payload, data: Buffer.from(payload.data, "base64"), metadata: Object.fromEntries(Object.entries(payload.metadata).map(([key, entry]) => [key, Buffer.from(entry, "base64")])) } as Payload)); } catch { /* Non-JSON payloads are irrelevant to these assertions. */ }
      return found;
    }
    if (Array.isArray(value)) for (const child of value) decoded(child, found);
    else if (value && typeof value === "object") for (const child of Object.values(value)) decoded(child, found);
    return found;
  };
  const workerLoss = await read("developer-active-worker-loss");
  const started = workerLoss.events.flatMap((event) => event.activityTaskStartedEventAttributes ? [event.activityTaskStartedEventAttributes as { attempt?: number; lastFailure?: { message?: string } }] : []);
  expect(started).toEqual(expect.arrayContaining([expect.objectContaining({ attempt: 2, lastFailure: expect.objectContaining({ message: "Controlled Activity worker loss before result claim" }) })]));

  const text = async (scenario: string) => JSON.stringify(await read(scenario));
  const decodedText = async (scenario: string) => JSON.stringify(decoded(await read(scenario)));
  expect(await text("developer-cancellation")).toContain("cancelDeveloperExecution");
  expect(await text("developer-linked-retry")).toContain("retryDevelopment");
  expect(await decodedText("developer-result-claim")).toContain("Controlled result won cancellation race");
});

test("an unpatched command-order mutation produces a real DeterminismViolationError", async () => {
  const history = await readReplayHistory(join(process.cwd(), ".scratch/forge-mvp/replay/issue-workflow-backlog-planning.json"));
  const bundle = await mutationBundle("incompatible");
  await expect(replayIssueHistoryWithBundle(history, bundle, "workflow-replay-mutated")).rejects.toBeInstanceOf(DeterminismViolationError);
});

test("a compatible test-only bundle remains replayable", async () => {
  const history = await readReplayHistory(join(process.cwd(), ".scratch/forge-mvp/replay/issue-workflow-backlog-planning.json"));
  const bundle = await mutationBundle("compatible");
  await replayIssueHistoryWithBundle(history, bundle, "workflow-replay-compatible-mutation");
});

test("a missing Workflow export is a ReplayError, not determinism proof", async () => {
  const history = await readReplayHistory(join(process.cwd(), ".scratch/forge-mvp/replay/issue-workflow-backlog-planning.json"));
  const options = productionWorkflowBundleOptions();
  const bundle = await bundleWorkflowCode({
    ...options,
    workflowsPath: fileURLToPath(new URL("./fixtures/workflow-missing-export.ts", import.meta.url)),
  });
  const replay = replayIssueHistoryWithBundle(history, bundle, "workflow-replay-missing-export");
  await expect(replay).rejects.toBeInstanceOf(ReplayError);
  await expect(replay).rejects.not.toBeInstanceOf(DeterminismViolationError);
});

async function replayIssueHistoryWithBundle(history: Awaited<ReturnType<typeof readReplayHistory>>, bundle: Awaited<ReturnType<typeof buildProductionWorkflowBundle>>, workflowId: string): Promise<void> {
  const { Worker } = await import("@temporalio/worker");
  await Worker.runReplayHistory({ workflowBundle: bundle, dataConverter: temporalDataConverter }, history, workflowId);
}

test("the payload policy uses encoded converter output and covers every configured boundary", async () => {
  expect(PAYLOAD_POLICY.workflowStartInput).toBe(16 * 1024);
  expect(PAYLOAD_POLICY.updateOrSignalArguments).toBe(8 * 1024);
  expect(PAYLOAD_POLICY.activityArguments).toBe(24 * 1024);
  expect(PAYLOAD_POLICY.activityResult).toBe(24 * 1024);
  expect(PAYLOAD_POLICY.workflowOrUpdateResult).toBe(16 * 1024);
  expect(PAYLOAD_POLICY.queryArguments).toBe(2 * 1024);
  expect(PAYLOAD_POLICY.queryResult).toBe(16 * 1024);
  expect(PAYLOAD_POLICY.memo).toBe(4 * 1024);
  expect(PAYLOAD_POLICY.searchAttributes).toBe(4 * 1024);
  expect(PAYLOAD_POLICY.continueAsNewInput).toBe(8 * 1024);
  for (const boundary of Object.keys(PAYLOAD_POLICY)) expect(() => assertPayloadWithinLimit(boundary, "x".repeat(32 * 1024))).toThrow(/[Pp]ayload policy/);
  expect(() => assertContinuationStateWithinLimit({ carried: "x".repeat(8 * 1024) })).toThrow(/[Pp]ayload policy/);
  expect(() => assertHistoryEventCountWithinLimit(WORKFLOW_HISTORY_EVENT_LIMIT + 1)).toThrow(/history/);
  expect(() => assertPayloadWithinLimit("small", { issueId: "issue-1", revision: 1 })).not.toThrow();
});

test("payload boundaries count UTF-8 and aggregate converter output and reject substantive or secret content", () => {
  expect(() => assertEncodedPayloadBoundary("updateOrSignalArguments", ["é".repeat(4_200)], PAYLOAD_POLICY.updateOrSignalArguments)).toThrow(PayloadPolicyViolation);
  expect(() => assertEncodedPayloadBoundary("updateOrSignalArguments", ["a".repeat(4_100), "b".repeat(4_100)], PAYLOAD_POLICY.updateOrSignalArguments)).toThrow(PayloadPolicyViolation);
  for (const value of [{ prompt: "safe-looking text" }, { source: "const x = 1" }, { authorization: "Bearer abcdefghijklmnop" }, "Bearer abcdefghijklmnop"]) {
    expect(() => assertEncodedPayloadBoundary("activityResult", [value], PAYLOAD_POLICY.activityResult, "artifact_safe")).toThrow(PayloadPolicyViolation);
  }
  try {
    assertEncodedPayloadBoundary("queryArguments", ["é".repeat(1_100)], PAYLOAD_POLICY.queryArguments, "artifact_safe");
    throw new Error("Expected payload policy rejection");
  } catch (error) {
    expect(error).toMatchObject({ code: "payload_policy_violation", boundary: "queryArguments", limit: PAYLOAD_POLICY.queryArguments, reference: "artifact_safe" });
    expect(String(error)).not.toContain("é");
  }
  expect(() => encodedPayloadSize({ metadata: {}, data: new Uint8Array(), externalPayloads: [{}] } as never)).toThrow(PayloadPolicyViolation);
});

test("payload policy admits only the structured Developer authorization envelope", () => {
  const authorization = { authorizationId: "plan_auth_123", taskId: "task_123", companyId: "company_123", projectId: "project_123", workflowId: "workflow_123", planRevision: 1, planArtifactId: "artifact_123", planSha256: "a".repeat(64), authorizationKind: "human_approval", approvalDecisionId: "decision_123", authorizedAt: "2026-08-13T00:00:00.000Z" };
  expect(() => assertEncodedPayloadBoundary("activityArguments", [{ authorization }], PAYLOAD_POLICY.activityArguments)).not.toThrow();
  expect(() => assertEncodedPayloadBoundary("activityArguments", [{ authorization: { ...authorization, secret: "nope" } }], PAYLOAD_POLICY.activityArguments)).toThrow(PayloadPolicyViolation);
  expect(() => assertEncodedPayloadBoundary("activityArguments", [{ authorization: { ...authorization, planSha256: "not-a-sha", authorizedAt: "not-a-date" } }], PAYLOAD_POLICY.activityArguments)).toThrow(PayloadPolicyViolation);
});

test("history normalization is byte-stable and canonicalizes approved worker metadata", () => {
  const input = {
    events: [{
      eventId: "1",
      eventTime: { seconds: "1", nanos: 2_000_000 },
      workflowExecutionStartedEventAttributes: {
        originalExecutionRunId: "run-1",
        firstExecutionRunId: "run-1",
        workflowType: { name: "issueWorkflow" },
        workflowTaskTimeout: { nanos: 1_000_000 },
      },
      identity: "machine-specific-worker",
    }],
  };
  const first = normalizeProtoJsonValue(input);
  const second = normalizeProtoJsonValue(input);
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(first).toMatchObject({ events: [{ eventTime: "1970-01-01T00:00:01.002Z", workflowExecutionStartedEventAttributes: { workflowTaskTimeout: "0.001s" } }] });
});

test("manifest completeness fails before replay for orphaned or missing fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-replay-manifest-"));
  try {
    await cp(join(process.cwd(), ".scratch/forge-mvp/replay"), directory, { recursive: true });
    await writeFile(join(directory, "orphan.json"), "{}\n");
    await expect(readReplayManifest(join(directory, "manifest.json"))).rejects.toThrow(/does not consume every history JSON file/);
    await unlink(join(directory, "orphan.json"));
    const manifest = await readReplayManifest(join(directory, "manifest.json"));
    await unlink(join(directory, manifest.fixtures[0]!.file));
    await expect(readReplayManifest(join(directory, "manifest.json"))).rejects.toThrow(/does not consume every history JSON file|ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture sanitization rejects forbidden non-payload history text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-replay-sanitize-"));
  const filename = join(directory, "history.json");
  try {
    const history = jsonRequired(await readFile(join(process.cwd(), ".scratch/forge-mvp/replay/issue-workflow-backlog-planning.json"), "utf8")) as { unsafe?: string };
    history.unsafe = "/Users/private/operator/secret.txt";
    await writeFile(filename, JSON.stringify(history));
    await expect(readReplayHistory(filename)).rejects.toThrow(/forbidden history text/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the bundle hash is stable for the production replay contract", async () => {
  const bundle = await buildProductionWorkflowBundle();
  expect(workflowBundleSha256(bundle)).toMatch(/^[a-f0-9]{64}$/);
  expect(await auditProductionWorkflowBundle(bundle)).toEqual(expect.arrayContaining([
    join(process.cwd(), "src/temporal/workflows.ts"),
    join(process.cwd(), "src/temporal/issue-contracts.ts"),
    join(process.cwd(), "src/temporal/workflow-payload-interceptors.ts"),
  ]));
  const workflowSource = await readFile(join(process.cwd(), "src/temporal/workflows.ts"), "utf8");
  expect(workflowSource).not.toMatch(/from ["']node:/);
  expect(workflowSource).not.toMatch(/@temporalio\/(client|worker|activity)/);
});

test("the module audit follows a transitive project import", async () => {
  const bundle = await buildProductionWorkflowBundle();
  const root = join(process.cwd(), "tests/fixtures/workflow-transitive-root.ts");
  await expect(auditProductionWorkflowBundle(bundle, root)).rejects.toThrow(/node:fs/);
});

test("the captured durable-capacity timer history replays through the current Workflow bundle", async () => {
  for (const [index, fixture] of capacityHistoryFixturePaths.entries()) {
    const history = await readReplayHistory(fixture);
    expect(history.events.length).toBeGreaterThan(10);
    await replayIssueHistory(history, `workflow-replay-capacity-${index}`);
  }
});

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { Connection, WorkflowClient } from "@temporalio/client";
import proto from "@temporalio/proto";

import { ReplayManifestSchema, readReplayHistory, replayHistoryMetadata, replayIssueHistory, workflowBundleSha256, type ReplayHistory, type ReplayManifest } from "../src/temporal/replay.js";
import { buildProductionWorkflowBundle } from "../src/temporal/workflow-bundle.js";

export interface CaptureWorkflowHistoryInput {
  address: string;
  namespace: string;
  workflowId: string;
  firstRunId: string;
  scenario: string;
  currentPhase: string;
  outputDir: string;
  maxRuns?: number;
  replace?: string;
}

const durationKeys = new Set([
  "approximateBacklogAge", "backoff", "backoffDuration", "backoffStartInterval", "catchupWindow", "checkDuration", "cronScheduleToScheduleInterval", "currentRetryInterval", "defaultWorkflowTaskTimeout", "downloadUrlExpirationDuration", "duration", "elapsedSinceLastHeartbeat", "executionDuration", "fastForwardDuration", "firstWorkflowTaskBackoff", "heartbeatTimeout", "initialInterval", "initialSkippedDuration", "interval", "jitter", "localRetryThreshold", "maximumInterval", "namespaceDeleteDelay", "newWorkflowExecutionTimeout", "newWorkflowRunTimeout", "newWorkflowTaskTimeout", "nextRetryDelay", "phase", "scheduleToCloseTimeout", "scheduleToStartTimeout", "startDelay", "startToCloseTimeout", "startToFireTimeout", "workflowExecutionRetentionPeriod", "workflowExecutionRetentionTtl", "workflowExecutionTimeout", "workflowRunTimeout", "workflowStartDelay", "workflowTaskTimeout",
]);
const timestampKeys = new Set([
  "actualTime", "closeTime", "completeTime", "createTime", "createdTime", "currentAttemptScheduledTime", "currentSinceTime", "currentTime", "currentVersionChangedTime", "earliestTime", "emitTime", "endTime", "endTimeExclusive", "eventTime", "executionExpirationTime", "executionTime", "expirationTime", "expireTime", "expiredTime", "expiryTime", "failoverTime", "fastForwardTargetTime", "finishedTime", "firstActivationTime", "firstPollerTime", "futureActionTimes", "generatedTime", "heartbeatTime", "lastAccessTime", "lastAttemptCompleteTime", "lastChangedTime", "lastCheckTime", "lastCheckedTime", "lastCurrentTime", "lastDeactivationTime", "lastHealthCheckTime", "lastHeartbeatTime", "lastModifiedTime", "lastResetTime", "lastStartedTime", "lastSucceededTime", "lastSuccessfulPollTime", "lastUpdateTime", "latestDataExportTime", "latestTime", "nextAttemptScheduleTime", "originalScheduleTime", "originalScheduledTime", "originalStartTime", "pauseTime", "pausedTime", "rampingSinceTime", "rampingVersionChangedTime", "rampingVersionPercentageChangedTime", "registrationTime", "releaseTime", "requestDeadline", "requestedTime", "routingChangedTime", "routingUpdateTime", "runExpirationTime", "scheduleTime", "scheduledTime", "startTime", "startTimeInclusive", "startedTime", "targetTime", "time", "timestamp", "updateTime", "urlExpirationTime", "wallClockTime", "workflowExecutionExpirationTime",
]);

export function normalizeProtoJsonValue(value: unknown, key?: string): unknown {
  if (key === "stackTrace" || key === "stack_trace") return "";
  if (key === "identity") return "fixture-worker";
  if (Array.isArray(value)) return value.map((item) => normalizeProtoJsonValue(item, key));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (durationKeys.has(key ?? "") && Object.keys(record).length === 0) return "0s";
  if ((durationKeys.has(key ?? "") || timestampKeys.has(key ?? "")) && (record.seconds === undefined || typeof record.seconds === "string" || typeof record.seconds === "number") && (record.nanos === undefined || typeof record.nanos === "number")) {
    const secondsText = record.seconds === undefined ? "0" : String(record.seconds);
    const seconds = Number(secondsText);
    const nanos = typeof record.nanos === "number" ? record.nanos : 0;
    if (timestampKeys.has(key ?? "")) return new Date(seconds * 1000 + nanos / 1_000_000).toISOString();
    const fraction = nanos === 0 ? "" : `.${String(nanos).padStart(9, "0").replace(/0+$/, "")}`;
    return `${secondsText}${fraction}s`;
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([childKey, child]) => [childKey, normalizeProtoJsonValue(child, childKey)]));
}

export function normalizedHistory(history: unknown): ReplayHistory {
  const created = proto.temporal.api.history.v1.History.create(history as Parameters<typeof proto.temporal.api.history.v1.History.create>[0]);
  return normalizeProtoJsonValue(proto.temporal.api.history.v1.History.toObject(created, { longs: String, enums: String, bytes: String, defaults: false, arrays: true, objects: true })) as ReplayHistory;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function captureWorkflowHistory(input: CaptureWorkflowHistoryInput): Promise<ReplayManifest> {
  const maxRuns = input.maxRuns ?? 8;
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 32) throw new Error("maxRuns must be an integer from 1 to 32");
  const outputDir = resolve(input.outputDir);
  const connection = await Connection.connect({ address: input.address });
  try {
    const client = new WorkflowClient({ connection, namespace: input.namespace });
    const bundle = await buildProductionWorkflowBundle();
    const capturedBundleSha256 = workflowBundleSha256(bundle);
    const runs: Array<{ runId: string; history: ReplayHistory; bytes: Buffer; metadata: ReturnType<typeof replayHistoryMetadata> }> = [];
    let runId: string | undefined = input.firstRunId;
    for (let runIndex = 0; runId && runIndex < maxRuns; runIndex += 1) {
      const history = normalizedHistory(await client.getHandle(input.workflowId, runId).fetchHistory());
      const bytes = Buffer.from(`${JSON.stringify(history, null, 2)}\n`, "utf8");
      const metadata = replayHistoryMetadata(history);
      if (metadata.runId !== runId) throw new Error(`Fetched history run identity mismatch at run ${runIndex}`);
      await replayIssueHistory(history, input.workflowId);
      runs.push({ runId, history, bytes, metadata });
      runId = metadata.nextRunId;
    }
    if (runId) throw new Error(`Continue-As-New chain exceeded maxRuns=${maxRuns}`);
    if (!runs.length || runs.at(-1)?.metadata.currentPhase !== input.currentPhase) throw new Error(`Captured history phase ${runs.at(-1)?.metadata.currentPhase ?? "missing"} does not match requested ${input.currentPhase} for ${input.scenario}`);

    await mkdir(outputDir, { recursive: true });
    const manifestPath = join(outputDir, "manifest.json");
    let manifest: ReplayManifest = { manifestVersion: 1, workflowType: "issueWorkflow", fixtures: [] };
    try { manifest = ReplayManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))); } catch (error) { if (!(error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error; }
    const replaced = input.replace
      ? manifest.fixtures.find(({ id }) => id === input.replace) ?? manifest.fixtures.find(({ scenario }) => scenario === input.scenario)
      : undefined;
    if (input.replace && !replaced) throw new Error(`Unknown replacement fixture ${input.replace}`);
    if (!input.replace && manifest.fixtures.some(({ scenario }) => scenario === input.scenario)) throw new Error(`Fixture scenario ${input.scenario} already exists; pass --replace <fixture-id>`);
    const kept = replaced ? manifest.fixtures.filter(({ scenario }) => scenario !== replaced.scenario) : manifest.fixtures;
    const scenarioSlug = input.scenario.replaceAll("_", "-");
    const entries = runs.map((run, runIndex) => {
      const file = runs.length === 1 ? `issue-workflow-${scenarioSlug}.json` : `issue-workflow-${scenarioSlug}-run-${runIndex}.json`;
      const id = runs.length === 1 ? `${scenarioSlug}-v1` : `${scenarioSlug}-run-${runIndex}-v1`;
      return { id, scenario: input.scenario, currentPhase: run.metadata.currentPhase!, applicationVersion: "0.1.0" as const, sdkVersion: "1.22.0" as const, capturedBundleSha256, expectedReplayOutcome: "compatible" as const, sanitized: true as const, historySha256: sha256(run.bytes), file, workflowId: input.workflowId, runId: run.runId, firstExecutionRunId: run.metadata.firstExecutionRunId!, ...(runs.length > 1 ? { runIndex, ...(run.metadata.previousRunId ? { previousRunId: run.metadata.previousRunId } : {}), ...(run.metadata.nextRunId ? { nextRunId: run.metadata.nextRunId } : {}) } : {}) };
    });
    const nextManifest = ReplayManifestSchema.parse({ ...manifest, fixtures: [...kept, ...entries] });
    const staged = entries.map((entry, index) => ({ entry, bytes: runs[index]!.bytes, temporary: join(outputDir, `.${entry.file}.${process.pid}.tmp`) }));
    const manifestTemporary = `${manifestPath}.${process.pid}.tmp`;
    try {
      for (const file of staged) await writeFile(file.temporary, file.bytes, { flag: "wx" });
      await writeFile(manifestTemporary, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: "wx" });
      for (const file of staged) await readReplayHistory(file.temporary);
      for (const file of staged) await rename(file.temporary, join(outputDir, file.entry.file));
      for (const old of replaced ? manifest.fixtures.filter((fixture) => fixture.scenario === replaced.scenario && !entries.some(({ file }) => file === fixture.file)) : []) await unlink(join(outputDir, old.file)).catch(() => undefined);
      await rename(manifestTemporary, manifestPath);
    } catch (error) {
      await Promise.all([...staged.map(({ temporary }) => unlink(temporary).catch(() => undefined)), unlink(manifestTemporary).catch(() => undefined)]);
      throw error;
    }
    return nextManifest;
  } finally {
    await connection.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({ options: { address: { type: "string" }, namespace: { type: "string" }, "workflow-id": { type: "string" }, "first-run-id": { type: "string" }, scenario: { type: "string" }, "current-phase": { type: "string" }, "output-dir": { type: "string" }, "max-runs": { type: "string", default: "8" }, replace: { type: "string" } } });
  const required = (name: keyof typeof parsed.values): string => { const value = parsed.values[name]; if (typeof value !== "string" || !value) throw new Error(`Missing required argument --${name}`); return value; };
  const manifest = await captureWorkflowHistory({ address: required("address"), namespace: required("namespace"), workflowId: required("workflow-id"), firstRunId: required("first-run-id"), scenario: required("scenario"), currentPhase: required("current-phase"), outputDir: required("output-dir"), maxRuns: Number(parsed.values["max-runs"]), ...(parsed.values.replace ? { replace: parsed.values.replace } : {}) });
  console.log(JSON.stringify({ scenario: required("scenario"), fixtures: manifest.fixtures.filter(({ scenario }) => scenario === parsed.values.scenario).map(({ file }) => file) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

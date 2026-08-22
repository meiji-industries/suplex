import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import ts from "typescript";

import { defaultPayloadConverter, type Payload } from "@temporalio/common";
import { Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { z } from "zod";

import { buildProductionWorkflowBundle, temporalDataConverter } from "./workflow-bundle.js";
import { AuthorizedPlanSubjectSchema } from "../developer-contracts.js";
import { IssueWorkflowStateSchema, type IssueWorkflowState } from "./issue-contracts.js";
import { assertHistoryEventCountWithinLimit, encodedPayloadSize, WORKFLOW_PAYLOAD_LIMIT_BYTES } from "./policy.js";

const SDK_VERSION = "1.22.0";
const APPLICATION_VERSION = "0.1.0";
const forbiddenKey = /^(?:prompt|source|log|rawDiff|conflictDiff|taskBody|description|authorization|password|token|credential|secret|privateKey|apiKey)$/i;
const forbiddenValue = /-----BEGIN [^-]+-----|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b|(?:bearer|basic)\s+[a-z0-9+/=_-]{16,}/i;
const absolutePath = /(?:^|[\s"'])\/(?:Users|private|tmp|var\/folders|home)\//i;
const diffMarker = /^(?:diff --git|@@ |<{7}|={7}|>{7})/m;
const forbiddenFixtureTerms = /\b(?:password|secret|credential|authorization|prompt|source|description|image)\b|Bearer\s+\S+|api[_-]?key/i;
const forbiddenFixturePaths = /^(?:\/Users\/|\/private\/var\/folders\/|\/var\/folders\/)/;
const authorizationKeys = new Set(["authorizationId", "taskId", "companyId", "projectId", "workflowId", "planRevision", "planArtifactId", "planSha256", "authorizationKind", "approvalDecisionId", "authorizedAt"]);

function approvedAuthorizationEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !Object.keys(record).some((key) => !authorizationKeys.has(key)) && AuthorizedPlanSubjectSchema.safeParse(record).success;
}

export const ReplayFixtureManifestEntrySchema = z.object({
  id: z.string().min(1),
  scenario: z.string().min(1),
  currentPhase: z.string().min(1),
  applicationVersion: z.literal(APPLICATION_VERSION),
  sdkVersion: z.literal(SDK_VERSION),
  capturedBundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedReplayOutcome: z.enum(["compatible", "incompatible"]),
  sanitized: z.literal(true),
  historySha256: z.string().regex(/^[a-f0-9]{64}$/),
  file: z.string().regex(/^[A-Za-z0-9._-]+\.json$/),
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  firstExecutionRunId: z.string().min(1),
  runIndex: z.number().int().nonnegative().optional(),
  previousRunId: z.string().min(1).optional(),
  nextRunId: z.string().min(1).optional(),
});

export const ReplayManifestSchema = z.object({
  manifestVersion: z.literal(1),
  workflowType: z.literal("issueWorkflow"),
  fixtures: z.array(ReplayFixtureManifestEntrySchema).min(1),
});

export type ReplayFixtureManifestEntry = z.infer<typeof ReplayFixtureManifestEntrySchema>;
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;

export interface ReplayHistory {
  events: unknown[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPayload(value: unknown): value is Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.data === "string" && !!record.metadata && typeof record.metadata === "object";
}

function scanSafeValue(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (forbiddenValue.test(value) || forbiddenFixtureTerms.test(value) || absolutePath.test(value) || forbiddenFixturePaths.test(value) || diffMarker.test(value)) throw new Error(`Replay fixture contains forbidden content at ${path}`);
    if (value.length > 16_384) throw new Error(`Replay fixture contains an unbounded string at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSafeValue(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "authorization" && approvedAuthorizationEnvelope(child)) {
      scanSafeValue(child, `${path}.${key}`);
      continue;
    }
    if (forbiddenKey.test(key)) throw new Error(`Replay fixture contains forbidden field at ${path}.${key}`);
    scanSafeValue(child, `${path}.${key}`);
  }
}

function scanHistoryValue(value: unknown, path: string): void {
  if (isPayload(value)) {
    if (value.externalPayloads?.length) throw new Error(`Replay fixture uses external payloads at ${path}`);
    const payload = {
      ...value,
      data: Buffer.from((value as unknown as { data: string }).data, "base64"),
      metadata: Object.fromEntries(Object.entries(value.metadata ?? {}).map(([key, encoded]) => [key, Buffer.from(String(encoded), "base64")])),
    } as Payload;
    const encodedSize = encodedPayloadSize(payload);
    if (encodedSize > WORKFLOW_PAYLOAD_LIMIT_BYTES) throw new Error(`Replay fixture payload exceeds the hard cap at ${path}`);
    let decoded: unknown;
    try {
      decoded = defaultPayloadConverter.fromPayload(payload);
    } catch {
      throw new Error(`Replay fixture payload cannot be decoded at ${path}`);
    }
    scanSafeValue(decoded, `${path}.decoded`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanHistoryValue(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && (forbiddenValue.test(value) || absolutePath.test(value) || diffMarker.test(value))) throw new Error(`Replay fixture contains forbidden history text at ${path}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) scanHistoryValue(child, `${path}.${key}`);
}

function decodedPayload(value: Payload): unknown {
  return defaultPayloadConverter.fromPayload({
    ...value,
    data: Buffer.from((value as unknown as { data: string }).data, "base64"),
    metadata: Object.fromEntries(Object.entries(value.metadata ?? {}).map(([key, encoded]) => [key, Buffer.from(String(encoded), "base64")])),
  } as Payload);
}

function latestWorkflowState(value: unknown, found: IssueWorkflowState[] = []): IssueWorkflowState | undefined {
  if (isPayload(value)) {
    try { return latestWorkflowState(decodedPayload(value), found); } catch { return found.at(-1); }
  }
  if (Array.isArray(value)) {
    for (const item of value) latestWorkflowState(item, found);
    return found.at(-1);
  }
  if (!value || typeof value !== "object") return found.at(-1);
  const parsed = IssueWorkflowStateSchema.safeParse(value);
  if (parsed.success) {
    found.push(parsed.data);
    return found.at(-1);
  }
  if ("workflowId" in value && "phase" in value && typeof value.workflowId === "string" && typeof value.phase === "string") {
    found.push({ phase: value.phase } as IssueWorkflowState);
    return found.at(-1);
  }
  const continuation = IssueWorkflowStateSchema.safeParse((value as { continuationState?: unknown }).continuationState);
  if (continuation.success) found.push(continuation.data);
  for (const child of Object.values(value)) latestWorkflowState(child, found);
  return found.at(-1);
}

export function replayHistoryMetadata(history: ReplayHistory): { runId?: string | undefined; firstExecutionRunId?: string | undefined; previousRunId?: string | undefined; nextRunId?: string | undefined; currentPhase?: IssueWorkflowState["phase"] | undefined } {
  const started = history.events.find((item) => item && typeof item === "object" && "workflowExecutionStartedEventAttributes" in item) as { workflowExecutionStartedEventAttributes?: { originalExecutionRunId?: string; firstExecutionRunId?: string; continuedExecutionRunId?: string } } | undefined;
  const continued = [...history.events].reverse().find((item) => item && typeof item === "object" && "workflowExecutionContinuedAsNewEventAttributes" in item) as { workflowExecutionContinuedAsNewEventAttributes?: { newExecutionRunId?: string } } | undefined;
  return { runId: started?.workflowExecutionStartedEventAttributes?.originalExecutionRunId, firstExecutionRunId: started?.workflowExecutionStartedEventAttributes?.firstExecutionRunId, previousRunId: started?.workflowExecutionStartedEventAttributes?.continuedExecutionRunId, nextRunId: continued?.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId, currentPhase: latestWorkflowState(history)?.phase };
}

function workflowType(history: ReplayHistory): string | undefined {
  const event = history.events.find((item) => item && typeof item === "object" && "workflowExecutionStartedEventAttributes" in item) as { workflowExecutionStartedEventAttributes?: { workflowType?: { name?: string } } } | undefined;
  return event?.workflowExecutionStartedEventAttributes?.workflowType?.name;
}

function assertSafeFixtureValue(value: unknown, path = "", seen = new Set<object>()): void {
  if (typeof value === "string") {
    if (forbiddenFixtureTerms.test(value) || forbiddenFixturePaths.test(value)) {
      throw new Error(`Replay fixture contains forbidden history text or substantive content at ${path}`);
    }
    if (path.endsWith(".data")) {
      try {
        const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
        assertSafeFixtureValue(decoded, `${path}#decoded`, seen);
      } catch {
        // Non-JSON payload bytes are opaque to this safety check.
      }
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeFixtureValue(item, `${path}[${index}]`, seen));
    return;
  }
  Object.entries(value).forEach(([key, child]) => assertSafeFixtureValue(child, path ? `${path}.${key}` : key, seen));
}

export async function readReplayHistory(filename: string): Promise<ReplayHistory> {
  const history = JSON.parse(await readFile(filename, "utf8")) as ReplayHistory;
  if (!history || !Array.isArray(history.events)) throw new Error("Replay fixture must contain an events array");
  assertSafeFixtureValue(history);
  assertHistoryEventCountWithinLimit(history.events.length);
  scanHistoryValue(history, "history");
  if (workflowType(history) !== "issueWorkflow") throw new Error("Replay fixture has the wrong Workflow type");
  return history;
}

function validateUniqueManifestEntries(manifest: ReplayManifest): void {
  const fields = ["id", "file"] as const;
  for (const field of fields) {
    const values = manifest.fixtures.map((fixture) => fixture[field]);
    if (new Set(values).size !== values.length) throw new Error(`Replay manifest contains duplicate ${field}`);
  }
  const workflowRuns = manifest.fixtures.map((fixture) => `${fixture.workflowId}:${fixture.runId}`);
  if (new Set(workflowRuns).size !== workflowRuns.length) throw new Error("Replay manifest contains duplicate workflow/run identity");
  const scenarioRuns = manifest.fixtures.filter((fixture) => fixture.runIndex !== undefined).map((fixture) => `${fixture.scenario}:${fixture.runIndex}`);
  if (new Set(scenarioRuns).size !== scenarioRuns.length) throw new Error("Replay manifest contains duplicate scenario/run index");
  const byRun = new Map(manifest.fixtures.map((fixture) => [fixture.runId, fixture]));
  for (const fixture of manifest.fixtures) {
    if (fixture.previousRunId && byRun.get(fixture.previousRunId)?.nextRunId !== fixture.runId) throw new Error(`Replay manifest has a broken previous link for ${fixture.id}`);
    if (fixture.nextRunId && byRun.get(fixture.nextRunId)?.previousRunId !== fixture.runId) throw new Error(`Replay manifest has a broken next link for ${fixture.id}`);
  }
  const hashes = manifest.fixtures.map((fixture) => fixture.historySha256);
  if (new Set(hashes).size !== hashes.length) throw new Error("Replay manifest contains duplicate history content");
}

export async function readReplayManifest(filename = resolve(process.cwd(), ".scratch/forge-mvp/replay/manifest.json")): Promise<ReplayManifest> {
  const manifest = ReplayManifestSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  validateUniqueManifestEntries(manifest);
  const directory = dirname(filename);
  const jsonFiles = new Set((await readdir(directory)).filter((file) => file.endsWith(".json") && file !== basename(filename)));
  const listedFiles = new Set(manifest.fixtures.map((fixture) => fixture.file));
  if (jsonFiles.size !== listedFiles.size || [...jsonFiles].some((file) => !listedFiles.has(file))) throw new Error("Replay manifest does not consume every history JSON file");
  for (const fixture of manifest.fixtures) {
    const historyPath = resolve(directory, fixture.file);
    const bytes = await readFile(historyPath);
    if (sha256(bytes) !== fixture.historySha256) throw new Error(`Replay history SHA mismatch for ${fixture.id}`);
    const history = await readReplayHistory(historyPath);
    const identity = replayHistoryMetadata(history);
    if (identity.runId !== fixture.runId || identity.firstExecutionRunId !== fixture.firstExecutionRunId || identity.previousRunId !== fixture.previousRunId || identity.nextRunId !== fixture.nextRunId) throw new Error(`Replay history identity mismatch for ${fixture.id}`);
    const latest = latestWorkflowState(history)?.phase;
    if (latest !== fixture.currentPhase) throw new Error(`Replay history phase mismatch for ${fixture.id}: expected ${fixture.currentPhase}, got ${latest}`);
    if (fixture.expectedReplayOutcome === "compatible" && workflowType(history) !== manifest.workflowType) throw new Error(`Replay fixture Workflow type mismatch for ${fixture.id}`);
  }
  return manifest;
}

export function workflowBundleSha256(bundle: WorkflowBundleWithSourceMap): string {
  return sha256(Buffer.from(bundle.code, "utf8"));
}

const forbiddenWorkflowImports = /^(?:node:|fs$|path$|os$|child_process$|crypto$|@temporalio\/(?:activity|client|worker|testing))/;

export async function auditProductionWorkflowBundle(bundle: WorkflowBundleWithSourceMap, rootFile = resolve(process.cwd(), "src/temporal/workflows.ts")): Promise<string[]> {
  const visited = new Set<string>();
  const modules: string[] = [];
  const visit = async (filename: string): Promise<void> => {
    const normalized = filename.replace(/\.js$/, ".ts");
    if (visited.has(normalized)) return;
    visited.add(normalized);
    const source = await readFile(normalized, "utf8");
    modules.push(normalized);
    const file = ts.createSourceFile(normalized, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const imported = statement.moduleSpecifier.text;
      if (forbiddenWorkflowImports.test(imported)) throw new Error(`Forbidden Workflow import ${imported} in ${normalized}`);
      if (!imported.startsWith(".")) continue;
      const candidate = resolve(dirname(normalized), imported.replace(/\.js$/, "") + ".ts");
      try { await visit(candidate); } catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; }
    }
    if (/\bprocess\.|\bfetch\(|Math\.random|randomUUID/.test(source)) throw new Error(`Forbidden Workflow operation in ${normalized}`);
  };
  const defaultRoot = resolve(process.cwd(), "src/temporal/workflows.ts");
  if (resolve(rootFile) === defaultRoot) {
    const match = bundle.code.match(/sourceMappingURL=data:application\/json[^,]*,([^\n]+)/);
    if (!match?.[1]) throw new Error("Production Workflow bundle has no inline source map for module audit");
    const sourceMap = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as { sources?: unknown };
    if (!Array.isArray(sourceMap.sources)) throw new Error("Production Workflow bundle source map has no sources");
    const projectSourceRoot = `${resolve(process.cwd(), "src")}/`;
    const included = sourceMap.sources.filter((source): source is string => typeof source === "string" && source.startsWith(projectSourceRoot) && !source.endsWith("-autogenerated-entrypoint.cjs"));
    if (!included.includes(defaultRoot)) throw new Error("Production Workflow entrypoint is absent from its bundle source map");
    for (const source of included) await visit(source);
  } else {
    await visit(rootFile);
  }
  return modules;
}

export async function replayIssueHistory(history: ReplayHistory, workflowId = "workflow-replay-issue-history"): Promise<void> {
  assertHistoryEventCountWithinLimit(history.events.length);
  const bundle = await buildProductionWorkflowBundle();
  await Worker.runReplayHistory({ workflowBundle: bundle, dataConverter: temporalDataConverter }, history, workflowId);
}

export async function replayIssueHistoryFile(filename: string, workflowId?: string): Promise<void> {
  await replayIssueHistory(await readReplayHistory(filename), workflowId);
}

export async function replayManifest(filename = resolve(process.cwd(), ".scratch/forge-mvp/replay/manifest.json")): Promise<void> {
  const manifest = await readReplayManifest(filename);
  const bundle = await buildProductionWorkflowBundle();
  const directory = dirname(filename);
  const histories = [];
  const fixtureByExecution = new Map<string, ReplayFixtureManifestEntry>();
  for (const fixture of manifest.fixtures) {
    histories.push({ workflowId: fixture.workflowId, history: await readReplayHistory(resolve(directory, fixture.file)) });
    fixtureByExecution.set(`${fixture.workflowId}:${fixture.runId}`, fixture);
  }
  for await (const result of Worker.runReplayHistories({ workflowBundle: bundle, dataConverter: temporalDataConverter }, histories)) {
    if (result.error) {
      const fixture = fixtureByExecution.get(`${result.workflowId}:${result.runId}`);
      throw new Error(`Replay failed for ${fixture?.id ?? "unknown-fixture"} (${fixture?.scenario ?? "unknown-scenario"}) ${result.workflowId}/${result.runId}: ${result.error.constructor.name}: ${result.error.message}`);
    }
  }
}

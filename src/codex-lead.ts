import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { ForgeConfig } from "./config.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { ForgeDatabase } from "./database.js";
import { redact } from "./logging.js";
import { PlanMaterialCategorySchema, classifyPlanMateriality, materialitySummary, type PlanMaterialCategory } from "./plan-governance.js";
import { CiRepairPlanSchema, DeliveryRepairPlanInputSchema, DeliveryRepairPlanResultSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, MergeConflictPlanSchema, type CiRepairPlanActivityInput, type CiRepairPlanActivityResult, type DeliveryFinding, type DeliveryRepairPlanActivityInput, type DeliveryRepairPlanResult, type DeliveryReview, type DeliveryReviewActivityInput, type DeliveryReviewActivityResult, type ConsolidateLeadPlanActivityInput, type MergeConflictPlanActivityInput, type MergeConflictPlanActivityResult, type SupplementalReviewActivityInput, type SupplementalReviewResult } from "./temporal/issue-contracts.js";
import { ForwardMergeConflictArtifactSchema, type ForwardMergeConflictArtifact } from "./forward-merge.js";
import { parseAcceptedProjectRevision } from "./projects.js";

const execFileAsync = promisify(execFile);

type MergeConflictPlanInput = MergeConflictPlanActivityInput;

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const LeadPlanSchema = z.object({
  kind: z.literal("plan"),
  summary: z.string().min(1).max(2_000),
  reproduction: z.string().max(20_000).nullable(),
  rootCauseAnalysis: z.string().max(20_000).nullable(),
  steps: z.array(z.object({ number: z.number().int().positive(), instruction: z.string().min(1).max(4_000), verification: z.string().min(1).max(4_000) })).min(1).max(64),
  compatibilityAnalysis: z.string().min(1).max(20_000),
  operationalAnalysis: z.string().min(1).max(20_000),
  verificationStrategy: z.string().min(1).max(20_000),
  unresolvedTechnicalQuestions: z.array(z.string().max(2_000)).max(32).length(0),
  materialCategories: z.array(PlanMaterialCategorySchema).max(6).default([]),
  preservedWorktreeCompatibility: z.boolean().nullable().default(null),
});

export const DecisionBlockerSchema = z.object({
  kind: z.literal("decision_blocker"),
  summary: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(10_000),
  owner: z.literal("human"),
  question: z.string().min(1).max(4_000),
  nextAction: z.string().min(1).max(4_000),
});

export const LeadOutputSchema = z.discriminatedUnion("kind", [LeadPlanSchema, DecisionBlockerSchema]);
export const SupplementalReviewSchema = z.object({
  kind: z.literal("review"),
  summary: z.string().min(1).max(2_000),
  opinion: z.enum(["approve", "request_changes"]),
  concerns: z.array(z.string().max(4_000)).max(16),
  requiredChanges: z.array(z.string().max(4_000)).max(16),
});

const DeliveryRepairLeadOutputSchema = z.object({
  kind: z.literal("delivery_repair_plan"),
  summary: z.string().min(1).max(2_000),
  steps: z.array(z.object({ number: z.number().int().positive(), instruction: z.string().min(1).max(4_000), verification: z.string().min(1).max(4_000) })).min(1).max(32),
  verificationStrategy: z.string().min(1).max(12_000),
  unresolvedTechnicalQuestions: z.array(z.string().max(2_000)).max(16).length(0),
});

export const LeadPlanningActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  imageArtifactIds: z.array(durableId).max(32),
  roleProfiles: z.object({ lead: durableId.optional(), developer: durableId.optional(), reviewer: durableId.optional() }),
  revision: z.number().int().nonnegative(),
  revisionRequestId: durableId.optional(),
  resumeLeadSessionRef: durableId.optional(),
});

export type LeadPlan = z.infer<typeof LeadPlanSchema>;
export type DecisionBlocker = z.infer<typeof DecisionBlockerSchema>;
export type LeadOutput = z.infer<typeof LeadOutputSchema>;
export type SupplementalReview = z.infer<typeof SupplementalReviewSchema>;
export type LeadPlanningActivityInput = z.infer<typeof LeadPlanningActivityInputSchema>;

export interface LeadPlanningResult {
  leadSessionRef: string;
  leadExecutionId: string;
  leadEvidenceArtifactId: string;
  leadOutputArtifactId: string;
  leadOutputKind: "plan" | "decision_blocker";
  leadSummary: string;
  materialCategories: PlanMaterialCategory[];
  material: boolean;
  preservedWorktreeCompatibility?: boolean | null;
}

export interface LeadInvocation {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  onStart: (pid: number, startedAt: string) => Promise<void>;
  onLine: (line: string) => Promise<void>;
}

export interface LeadProcessResult {
  exitCode: number;
  stderr: string;
}

export type LeadProcessRunner = (invocation: LeadInvocation) => Promise<LeadProcessResult>;

export function resolveAgentCommand(command: string, executablePath = process.env.PATH ?? ""): string {
  if (command !== "codex") return command;
  let fallback: string | undefined;
  for (const directory of executablePath.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      fallback ??= candidate;
      if (!/^mise(?:\.exe)?$/i.test(basename(realpathSync(candidate)))) return candidate;
    } catch { /* Continue to the next PATH entry. */ }
  }
  return fallback ?? command;
}

export class AgentFailure extends Error {
  readonly code: string;
  readonly nonRetryable: boolean;

  constructor(code: string, message: string, options: { nonRetryable?: boolean } = {}) {
    super(message);
    this.name = "AgentFailure";
    this.code = code;
    this.nonRetryable = options.nonRetryable ?? false;
  }
}

export interface SessionStore {
  create(rawSessionId: string): Promise<string>;
  read(sessionRef: string): Promise<string>;
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly root: string) {}

  async create(rawSessionId: string): Promise<string> {
    const sessionRef = `session_${randomBytes(12).toString("hex")}`;
    await mkdir(join(this.root, "sessions"), { recursive: true, mode: 0o700 });
    await writeFile(join(this.root, "sessions", `${sessionRef}.json`), JSON.stringify({ sessionId: rawSessionId }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return sessionRef;
  }

  async read(sessionRef: string): Promise<string> {
    if (!/^session_[a-f0-9]{24}$/.test(sessionRef)) throw new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
    const parsed = JSON.parse(await readFile(join(this.root, "sessions", `${sessionRef}.json`), "utf8")) as { sessionId?: unknown };
    if (typeof parsed.sessionId !== "string" || !parsed.sessionId) throw new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
    return parsed.sessionId;
  }
}

function defaultProcessRunner(invocation: LeadInvocation): Promise<LeadProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, detached: invocation.detached, stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = new Date().toISOString();
    let stderr = "";
    let buffer = "";
    let settled = false;
    let hookChain = Promise.resolve();
    const queueLine = (line: string): void => {
      hookChain = hookChain.then(() => invocation.onLine(line));
    };
    const finish = (result: LeadProcessResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    if (!child.pid) {
      reject(new AgentFailure("process-start-failed", "Codex process could not be started"));
      return;
    }
    hookChain = hookChain.then(() => invocation.onStart(child.pid!, startedAt));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) queueLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
    });
    child.once("close", (code) => {
      if (buffer.trim()) queueLine(buffer);
      void hookChain.then(() => finish({ exitCode: code ?? -1, stderr: redact(stderr) as string })).catch((error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  });
}

export const runCodexProcess: LeadProcessRunner = defaultProcessRunner;

function safeJsonLine(line: string): string {
  try {
    return JSON.stringify(redact(JSON.parse(line))) ?? JSON.stringify({ type: "empty" });
  } catch {
    return JSON.stringify({ type: "text", text: redact(line) });
  }
}

function eventValue(line: string): { type: string | undefined; threadId: string | undefined; itemText: string | undefined } {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const item = event.item as Record<string, unknown> | undefined;
    return {
      type: typeof event.type === "string" ? event.type : undefined,
      threadId: typeof event.thread_id === "string" ? event.thread_id : typeof event.threadId === "string" ? event.threadId : undefined,
      itemText: item && item.type === "agent_message" && typeof item.text === "string" ? item.text : undefined,
    };
  } catch {
    return { type: undefined, threadId: undefined, itemText: undefined };
  }
}

function parseLeadOutput(lines: string[]): LeadOutput {
  const messages = lines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" ? [event.item.text] : [];
    } catch {
      return [];
    }
  });
  const text = messages.at(-1);
  if (!text) throw new AgentFailure("missing-output", "Codex did not return a Lead result");
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new AgentFailure("malformed-output", "Codex returned malformed Lead JSON");
  }
  const result = LeadOutputSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-output-schema", "Codex returned a Lead result that does not satisfy the required schema");
  return result.data;
}

function parseSupplementalReview(lines: string[]): SupplementalReview {
  const messages = lines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" ? [event.item.text] : [];
    } catch {
      return [];
    }
  });
  const text = messages.at(-1);
  if (!text) throw new AgentFailure("missing-output", "Supplemental review did not return an opinion");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-output", "Supplemental review returned malformed JSON"); }
  const result = SupplementalReviewSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-output-schema", "Supplemental review did not satisfy the required schema");
  return result.data;
}

function parseDeliveryReview(lines: string[]): DeliveryReview {
  const messages = lines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" ? [event.item.text] : [];
    } catch {
      return [];
    }
  });
  const text = messages.at(-1);
  if (!text) throw new AgentFailure("missing-review-output", "Codex Lead did not return a delivery review");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-review-output", "Codex Lead returned malformed delivery review JSON"); }
  const result = DeliveryReviewSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "review"}: ${issue.message}`).join("; ").slice(0, 1_000);
    throw new AgentFailure("invalid-review-output", `Codex Lead returned a delivery review outside the required schema. ${issues}`);
  }
  return result.data;
}

function parseDeliveryRepairPlan(lines: string[]): z.infer<typeof DeliveryRepairLeadOutputSchema> {
  const messages = lines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" ? [event.item.text] : [];
    } catch { return [];
    }
  });
  const text = messages.at(-1);
  if (!text) throw new AgentFailure("missing-repair-plan-output", "Codex Lead did not return a delivery repair plan");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-repair-plan-output", "Codex Lead returned malformed delivery repair plan JSON"); }
  const result = DeliveryRepairLeadOutputSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-repair-plan-output", "Codex Lead returned a delivery repair plan outside the required schema");
  return result.data;
}

function parseMergeConflictPlan(lines: string[]): import("./temporal/issue-contracts.js").MergeConflictPlan {
  const messages = lines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" ? [event.item.text] : [];
    } catch {
      return [];
    }
  });
  const text = messages.at(-1);
  if (!text) throw new AgentFailure("missing-merge-conflict-plan", "Codex Lead did not return a merge-conflict plan");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-merge-conflict-plan", "Codex Lead returned malformed merge-conflict plan JSON"); }
  const result = MergeConflictPlanSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-merge-conflict-plan", "Codex Lead returned a merge-conflict plan outside the required schema");
  return result.data;
}

function parseCiRepairPlan(lines: string[]): import("./temporal/issue-contracts.js").CiRepairPlan {
  const messages = lines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" ? [event.item.text] : [];
    } catch { return []; }
  });
  const text = messages.at(-1);
  if (!text) throw new AgentFailure("missing-ci-repair-plan", "Codex Lead did not return a CI repair plan");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-ci-repair-plan", "Codex Lead returned malformed CI repair plan JSON"); }
  const result = CiRepairPlanSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-ci-repair-plan", "Codex Lead returned a CI repair plan outside the required schema");
  return result.data;
}

async function readOptionalInstruction(filename: string): Promise<string | undefined> {
  try {
    const value = await readFile(filename, "utf8");
    return value.length > 100_000 ? `${value.slice(0, 100_000)}\n[truncated]` : value;
  } catch {
    return undefined;
  }
}

async function readDeliveryGitEvidence(worktreePath: string, targetBaseSha: string, subjectCommit: string, repositoryPath: string): Promise<{ targetBaseSha: string; subjectCommit: string; subjectTree: string; status: string; branch: string; head: string; tree: string; diff: string; commit: string; instructions: string }> {
  const run = async (args: string[], maxBuffer: number): Promise<string> => (await execFileAsync("git", args, { cwd: worktreePath, timeout: 20_000, maxBuffer })).stdout;
  const [status, branch, head, tree, diff, commit] = await Promise.all([
    run(["status", "--porcelain=v1", "--untracked-files=all"], 64 * 1024),
    run(["symbolic-ref", "--short", "HEAD"], 4 * 1024),
    run(["rev-parse", "HEAD"], 4 * 1024),
    run(["rev-parse", "HEAD^{tree}"], 4 * 1024),
    run(["diff", "--no-ext-diff", "--binary", `${targetBaseSha}..${subjectCommit}`], 2 * 1024 * 1024),
    run(["show", "--no-ext-diff", "--format=fuller", "--stat", "--summary", subjectCommit], 128 * 1024),
  ]);
  const instructionPaths = [
    join(repositoryPath, "AGENTS.md"),
    join(repositoryPath, "CLAUDE.md"),
    join(worktreePath, "AGENTS.md"),
    join(worktreePath, "CLAUDE.md"),
  ];
  const instructionEntries = await Promise.all([...new Set(instructionPaths)].map(async (filename) => {
    const contents = await readOptionalInstruction(filename);
    return contents === undefined ? undefined : `--- ${filename} ---\n${contents}`;
  }));
  return {
    targetBaseSha,
    subjectCommit,
    subjectTree: tree.trim(),
    status: redact(status.trim()) as string,
    branch: branch.trim(),
    head: head.trim(),
    tree: tree.trim(),
    diff: redact(diff) as string,
    commit: redact(commit) as string,
    instructions: instructionEntries.filter((entry): entry is string => entry !== undefined).join("\n"),
  };
}

export function agentProcessFailure(result: LeadProcessResult, outputLines: string[] = [], model?: string): AgentFailure {
  const diagnosticText = `${result.stderr}\n${outputLines.join("\n")}`;
  if (/not logged in|login required|authentication required|unauthenticated|oauth authorization required/i.test(diagnosticText)) {
    return new AgentFailure("login-expired", "Agent provider authentication is unavailable. Sign in again, then retry.", { nonRetryable: true });
  }
  if (/rate[ -]?limit|too many requests|\b429\b/i.test(diagnosticText)) {
    return new AgentFailure("rate-limited", "Agent provider rate limiting prevented this invocation from completing.");
  }
  if (/model .*not supported|unsupported model|invalid model|unknown model|model_not_found|model metadata .*not found|model .*does not exist/i.test(diagnosticText)) {
    const configuredModel = model ? ` “${model}”` : "";
    return new AgentFailure("model-unavailable", `The configured model${configuredModel} is unavailable for the active provider account. Select a supported model, then retry.`, { nonRetryable: true });
  }
  return new AgentFailure(result.exitCode === 0 ? "process-output-failed" : "process-exited", "The agent invocation did not complete.");
}

function deliveryBlockCode(failure: AgentFailure): import("./temporal/issue-contracts.js").DeliveryOperationBlockCode {
  if (failure.code === "login-expired" || failure.code === "authentication-required") return "authentication-required";
  if (failure.code === "rate-limited") return "rate-limited";
  if (failure.code === "evidence-too-large") return "evidence-too-large";
  if (failure.code === "session-identity-conflict" || failure.code === "session-conflict") return "session-conflict";
  if (failure.code === "delivery-revision-changed" || failure.code === "unsafe-working-directory") return "subject-changed";
  if (failure.code === "malformed-review-output" || failure.code === "missing-review-output" || failure.code === "invalid-review-output") return "invalid-output";
  return "process-failed";
}

function safeBlockSummary(code: import("./temporal/issue-contracts.js").DeliveryOperationBlockCode, correctionExhausted = false): string {
  if (correctionExhausted) return "The Lead returned invalid review output after one format correction; retry the review.";
  const summaries: Record<import("./temporal/issue-contracts.js").DeliveryOperationBlockCode, string> = {
    "invalid-output": "The Lead review was not machine-readable; retry the review.",
    "correction-exhausted": "The Lead returned invalid review output after one format correction; retry the review.",
    "session-conflict": "The Lead review returned a different session identity; retry the review.",
    "authentication-required": "Agent provider authentication is unavailable; sign in again, then retry.",
    "rate-limited": "Agent provider rate limiting prevented the review from completing; retry later.",
    "process-failed": "The Lead review process did not complete; inspect the evidence and retry.",
    "evidence-too-large": "Lead review evidence exceeded the local artifact limit; retry with bounded output.",
    "subject-changed": "The exact delivery subject changed before review; produce a fresh delivery.",
    "repair-incomplete": "The repair did not address every open blocking finding.",
    "repair-scope": "The repair exceeded the supplied blocking-finding scope.",
    "worktree-unsafe": "The Developer worktree is not the exact clean reviewed revision.",
    "repair-cap-exhausted": "The configured repair-cycle limit has been reached.",
  };
  return summaries[code];
}

async function taskScopedPath(root: string, candidate: string): Promise<string> {
  const absoluteRoot = await realpath(root);
  const absoluteCandidate = await realpath(resolve(candidate));
  const relativePath = relative(absoluteRoot, absoluteCandidate);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") throw new AgentFailure("unsafe-working-directory", "Lead working directory is outside the configured repository root");
  return absoluteCandidate;
}

function pinnedRepositoryPath(normalizedJson: string): string {
  try {
    const parsed = JSON.parse(normalizedJson) as { repositoryPath?: unknown };
    if (typeof parsed.repositoryPath === "string" && parsed.repositoryPath.length > 0) return parsed.repositoryPath;
  } catch {
    // Keep revision failures redacted at the activity boundary.
  }
  throw new AgentFailure("pinned-revision-missing", "The accepted project revision does not contain a repository path");
}

interface PlanningRow {
  title: string;
  normalized_json: string;
  brief_storage_path: string;
  brief_sha256: string;
}

interface ProfileSettings {
  id: string;
  name: string;
  provider: string;
  model: string;
  reasoningLevel: string;
  servicePriority: string;
  capacity: number;
}

interface ImageRow {
  storage_path: string;
  sha256: string;
  filename: string;
}

interface DeliveryReviewContext {
  title: string;
  normalizedJson: string;
  briefStoragePath: string;
  briefSha256: string;
  planStoragePath: string;
  planSha256: string;
  deliveryStoragePath: string;
  deliverySha256: string;
  evidenceStoragePath: string;
  evidenceSha256: string;
  developerSessionRef: string;
}

export interface AgentServiceOptions {
  command?: string;
  processRunner?: LeadProcessRunner;
  sessionStore?: SessionStore;
  now?: () => Date;
}

export class AgentService {
  private readonly artifacts: ArtifactStore;
  private readonly command: string;
  private readonly processRunner: LeadProcessRunner;
  private readonly sessionStore: SessionStore;
  private readonly now: () => Date;

  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig, options: AgentServiceOptions = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot);
    this.command = resolveAgentCommand(options.command ?? process.env.FORGE_CODEX_COMMAND ?? "codex");
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.sessionStore = options.sessionStore ?? new FileSessionStore(config.runtimeRoot);
    this.now = options.now ?? (() => new Date());
  }

  async planDeliveryRepair(rawInput: DeliveryRepairPlanActivityInput): Promise<DeliveryRepairPlanResult> {
    const input = DeliveryRepairPlanInputSchema.parse(rawInput);
    const scoped = this.database.authQuery((db) => db.prepare(`SELECT t.id
      FROM forge_tasks t
      JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ? AND t.project_revision_id = ?`).get(input.taskId, input.companyId, input.projectId, input.workflowId, input.projectRevisionId) as { id: string } | undefined);
    if (!scoped) throw new AgentFailure("scoped-input-missing", "Delivery repair planning evidence is unavailable");
    const openFindings = input.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
    if (!openFindings.length) throw new AgentFailure("repair-plan-invalid", "Delivery repair planning requires an open blocking finding");
    const rawSessionId = await this.sessionStore.read(input.leadSessionRef);
    const worktreePath = await taskScopedPath(this.config.worktreeRoot, input.worktreePath);
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const evidenceLines: string[] = [];
    const outputLines: string[] = [];
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'lead', 'starting', 1, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.leadSessionRef, startedAt));
    let output: z.infer<typeof DeliveryRepairLeadOutputSchema>;
    try {
      const result = await this.processRunner({ command: this.command, args: ["exec", "resume", rawSessionId, "--json", "--skip-git-repo-check", this.deliveryRepairPlanPrompt(input, openFindings)], cwd: worktreePath, onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); }, onLine: async (line) => { evidenceLines.push(safeJsonLine(line)); outputLines.push(line); await this.databaseHeartbeat(executionId, "running"); } });
      if (result.exitCode !== 0) throw agentProcessFailure(result, outputLines, "delivery-repair-plan");
      output = parseDeliveryRepairPlan(outputLines);
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("repair-plan-failed", "Codex Lead delivery repair planning failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      this.database.authTransaction((db) => { db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt); db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId); });
      throw failure;
    }
    const summary = output.summary;
    const authorityEvidence = {
      source: input.source,
      planRevision: input.planRevision,
      exactContext: {
        taskId: input.taskId,
        companyId: input.companyId,
        workflowId: input.workflowId,
        projectId: input.projectId,
        projectRevisionId: input.projectRevisionId,
        releaseId: input.releaseId ?? null,
        deliveryReviewId: input.deliveryReviewId ?? null,
        finalReviewId: input.finalReviewId ?? null,
        ciRunId: input.ciRunId ?? null,
        acceptanceId: input.acceptanceId ?? null,
        reasonArtifactId: input.reasonArtifactId ?? null,
        branchName: input.branchName,
        targetBaseSha: input.targetBaseSha,
        subjectCommit: input.subjectCommit,
        subjectTree: input.subjectTree,
        leadSessionRef: input.leadSessionRef,
      },
      findingIds: openFindings.map((finding) => finding.findingId),
    };
    const planText = [`<!-- forge-repair-authority ${JSON.stringify(authorityEvidence)} -->`, "", summary, "", ...output.steps.map((step) => `${step.number}. ${step.instruction}\n   Verify: ${step.verification}`), "", `Verification: ${output.verificationStrategy}`, "Unresolved technical questions: none."].join("\n");
    const evidenceText = JSON.stringify({
      ...authorityEvidence,
      evidenceArtifactIds: input.evidenceArtifactIds,
    }, null, 2);
    const [planArtifact, evidenceArtifact] = await Promise.all([
      this.artifacts.put(input.companyId, "delivery-repair-plan", { filename: `${input.source}-${input.planRevision}.md`, mimeType: "text/markdown", bytes: Buffer.from(planText, "utf8") }),
      this.artifacts.put(input.companyId, "agent-evidence", { filename: `${input.source}-${input.planRevision}-repair.json`, mimeType: "application/json", bytes: Buffer.from(evidenceText, "utf8") }),
    ]);
    const planId = `repair_plan_${createHash("sha256").update(JSON.stringify({ workflowId: input.workflowId, source: input.source, planRevision: input.planRevision, leadSessionRef: input.leadSessionRef, findings: openFindings.map((finding) => finding.findingId), subjectCommit: input.subjectCommit, subjectTree: input.subjectTree })).digest("hex").slice(0, 32)}`;
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        planArtifact.id, planArtifact.companyId, planArtifact.kind, planArtifact.filename, planArtifact.mimeType, planArtifact.byteSize, planArtifact.sha256, planArtifact.storagePath, planArtifact.createdAt,
        evidenceArtifact.id, evidenceArtifact.companyId, evidenceArtifact.kind, evidenceArtifact.filename, evidenceArtifact.mimeType, evidenceArtifact.byteSize, evidenceArtifact.sha256, evidenceArtifact.storagePath, evidenceArtifact.createdAt,
      );
    });
    this.database.authTransaction((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), evidenceArtifact.id, executionId));
    return DeliveryRepairPlanResultSchema.parse({ planId, planArtifactId: planArtifact.id, planSha256: planArtifact.sha256, evidenceArtifactId: evidenceArtifact.id, leadSessionRef: input.leadSessionRef, summary, findings: openFindings });
  }

  async runLeadPlanning(rawInput: LeadPlanningActivityInput): Promise<LeadPlanningResult> {
    const input = LeadPlanningActivityInputSchema.parse(rawInput);
    const row = this.database.authQuery((db) => db.prepare(`SELECT t.title, r.normalized_json, b.storage_path AS brief_storage_path, b.sha256 AS brief_sha256
      FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ? AND t.project_revision_id = ? AND b.id = ?`).get(input.taskId, input.companyId, input.projectId, input.workflowId, input.projectRevisionId, input.briefArtifactId) as PlanningRow | undefined);
    if (!row) throw new AgentFailure("scoped-input-missing", "Lead planning evidence is unavailable");
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(pinnedRepositoryPath(row.normalized_json)));
    const brief = (await this.artifacts.read({ companyId: input.companyId, storagePath: row.brief_storage_path, sha256: row.brief_sha256 })).toString("utf8");
    const images = this.database.authQuery((db) => {
      if (!input.imageArtifactIds.length) return [] as ImageRow[];
      const placeholders = input.imageArtifactIds.map(() => "?").join(",");
      return db.prepare(`SELECT storage_path, sha256, filename FROM forge_artifacts WHERE company_id = ? AND kind = 'task-image' AND id IN (${placeholders})`).all(input.companyId, ...input.imageArtifactIds) as ImageRow[];
    });
    if (images.length !== input.imageArtifactIds.length) throw new AgentFailure("scoped-input-missing", "Lead image evidence is unavailable");
    for (const image of images) await this.artifacts.read({ companyId: input.companyId, storagePath: image.storage_path, sha256: image.sha256 });
    const profileSettings = this.database.authQuery((db) => {
      const profileIds = Object.values(input.roleProfiles).filter((value): value is string => typeof value === "string");
      if (!profileIds.length) return [] as ProfileSettings[];
      const placeholders = profileIds.map(() => "?").join(",");
      return db.prepare(`SELECT id, name, provider, model, reasoning_level AS reasoningLevel, service_priority AS servicePriority, capacity FROM forge_profiles WHERE id IN (${placeholders})`).all(...profileIds) as ProfileSettings[];
    });
    if (!input.roleProfiles.lead) throw new AgentFailure("profile-unavailable", "Lead planning requires a configured Lead profile");
    const leadProfile = profileSettings.find((profile) => profile.id === input.roleProfiles.lead);
    if (!leadProfile || leadProfile.provider !== "codex") throw new AgentFailure("profile-unavailable", "The configured Lead profile is unavailable");
    const revisionRequest = input.revisionRequestId ? this.database.authQuery((db) => db.prepare(`SELECT r.disposition, r.worktree_path AS worktreePath, r.branch_name AS branchName, r.base_sha AS baseSha, r.head_sha AS headSha, r.tree_sha AS treeSha, r.exact_base_sha AS exactBaseSha, a.storage_path AS reasonPath, a.sha256 AS reasonSha
      FROM forge_plan_revision_requests r JOIN forge_artifacts a ON a.id = r.reason_artifact_id AND a.company_id = r.company_id AND a.kind = 'plan-revision-reason'
      WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ?`).get(input.revisionRequestId, input.taskId, input.companyId, input.workflowId) as { disposition: "reuse" | "new"; worktreePath: string | null; branchName: string | null; baseSha: string | null; headSha: string | null; treeSha: string | null; exactBaseSha: string | null; reasonPath: string; reasonSha: string } | undefined) : undefined;
    if (input.revisionRequestId && !revisionRequest) throw new AgentFailure("revision-request-missing", "The plan revision request is unavailable");
    const revisionContext = revisionRequest ? { ...revisionRequest, reason: (await this.artifacts.read({ companyId: input.companyId, storagePath: revisionRequest.reasonPath, sha256: revisionRequest.reasonSha })).toString("utf8") } : undefined;
    const repositoryEvidence = await this.repositoryEvidence(repositoryPath);
    let executionId = `agent_${randomBytes(12).toString("hex")}`;
    let sessionRef: string | undefined;
    let rawSessionId: string | undefined;
    const startedAt = this.now().toISOString();
    try {
      const active = this.database.authQuery((db) => db.prepare("SELECT id, status, attempt, session_ref, heartbeat_at FROM forge_agent_executions WHERE task_id = ? AND role = 'lead' AND status IN ('starting', 'running') ORDER BY started_at DESC LIMIT 1").get(input.taskId) as { id: string; status: string; attempt: number; session_ref: string | null; heartbeat_at: string | null } | undefined);
      if (active) {
        const heartbeatAge = active.heartbeat_at ? Date.now() - Date.parse(active.heartbeat_at) : Number.POSITIVE_INFINITY;
        if (heartbeatAge < 30_000) throw new AgentFailure("active-lease", "A Lead execution is already active for this issue");
        executionId = active.id;
        sessionRef = active.session_ref ?? undefined;
        rawSessionId = sessionRef ? await this.sessionStore.read(sessionRef) : undefined;
        this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'starting', attempt = ?, heartbeat_at = ?, finished_at = NULL, failure_code = NULL, failure_summary = NULL WHERE id = ?").run(active.attempt + 1, startedAt, executionId));
      } else if (input.resumeLeadSessionRef) {
        const prior = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_agent_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND role = 'lead' AND session_ref = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.resumeLeadSessionRef) as { id: string } | undefined);
        if (!prior) throw new AgentFailure("lead-session-ownership", "The prior Lead session cannot be resumed for this issue");
        rawSessionId = await this.sessionStore.read(input.resumeLeadSessionRef);
        sessionRef = input.resumeLeadSessionRef;
        this.database.authTransaction((db) => db.prepare(`INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'lead', 'starting', 1, ?, ?)`).run(executionId, input.taskId, input.companyId, input.workflowId, input.resumeLeadSessionRef, startedAt));
      } else {
        this.database.authTransaction((db) => {
          db.prepare(`INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES (?, ?, ?, ?, 'lead', 'starting', 1, ?)`).run(executionId, input.taskId, input.companyId, input.workflowId, startedAt);
        });
      }
    } catch (error) {
      if (error instanceof AgentFailure) throw error;
      if (error instanceof Error && /forge_agent_active_lease_idx|UNIQUE constraint/i.test(error.message)) throw new AgentFailure("active-lease", "A Lead execution is already active for this issue");
      throw error;
    }

    const evidenceLines: string[] = [];
    let evidenceBytes = 0;
    let lastFailure: AgentFailure | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt = attempt === 0 ? this.initialPrompt(row.title, brief, row.normalized_json, profileSettings, repositoryEvidence, revisionContext) : this.correctionPrompt();
        const imagePaths = images.map((image) => resolve(this.config.artifactRoot, image.storage_path));
        const args = rawSessionId
          ? ["exec", "resume", rawSessionId, "--json", "--skip-git-repo-check", ...imagePaths.flatMap((path) => ["--image", path]), prompt]
          : ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--model", leadProfile.model, ...imagePaths.flatMap((path) => ["--image", path]), prompt];
        const lines: string[] = [];
        await this.databaseHeartbeat(executionId, "running");
        const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 5_000);
        const result = await this.processRunner({
          command: this.command,
          args,
          cwd: repositoryPath,
          onStart: async (pid, processStartedAt) => {
            await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId));
          },
          onLine: async (line) => {
            const sanitized = safeJsonLine(line);
            evidenceBytes += Buffer.byteLength(sanitized, "utf8") + 1;
            if (evidenceBytes > 6 * 1024 * 1024) throw new AgentFailure("evidence-too-large", "Codex evidence exceeded the local artifact limit");
            evidenceLines.push(sanitized);
            lines.push(line);
            const event = eventValue(line);
            if (event.threadId && !sessionRef) {
              rawSessionId = event.threadId;
              sessionRef = await this.sessionStore.create(rawSessionId);
              await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId));
            }
            await this.databaseHeartbeat(executionId, "running");
          },
        }).finally(() => clearInterval(heartbeat));
        if (result.exitCode !== 0) {
          lastFailure = agentProcessFailure(result, lines, leadProfile.model);
          break;
        }
        try {
          const output = parseLeadOutput(lines);
          if (!sessionRef || !rawSessionId) throw new AgentFailure("missing-session", "Codex did not return a Lead session reference");
          const artifacts = await this.persistOutput(input, executionId, sessionRef, evidenceLines, output);
          await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), artifacts.evidence.id, executionId));
          return artifacts.result;
        } catch (error) {
          lastFailure = error instanceof AgentFailure ? error : new AgentFailure("invalid-output", "Codex Lead output was invalid");
          if (!rawSessionId || attempt === 1) break;
        }
      }
      throw lastFailure ?? new AgentFailure("lead-failed", "Codex Lead execution failed");
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("lead-failed", "Codex Lead execution failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      this.database.authQuery((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt));
      await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId));
      throw failure;
    }
  }

  async planMergeConflict(rawInput: MergeConflictPlanInput): Promise<MergeConflictPlanActivityResult> {
    const input = rawInput;
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, r.normalized_json AS normalizedJson, b.storage_path AS briefStoragePath, b.sha256 AS briefSha256, pa.storage_path AS planStoragePath, pa.sha256 AS planSha256
      FROM forge_tasks t
      JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id AND b.id = ?
      JOIN forge_issue_outputs io ON io.task_id = t.id AND io.company_id = t.company_id AND io.workflow_id = t.workflow_id AND io.output_artifact_id = ? AND io.revision = ?
      JOIN forge_artifacts pa ON pa.id = io.output_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ?`).get(input.briefArtifactId, input.leadOutputArtifactId, input.planRevision, input.taskId, input.companyId, input.projectId, input.projectRevisionId) as { title: string; normalizedJson: string; briefStoragePath: string; briefSha256: string; planStoragePath: string; planSha256: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Merge-conflict planning evidence is unavailable");
    let conflict: ForwardMergeConflictArtifact;
    const conflictRow = this.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a JOIN forge_forward_merges f ON f.conflict_artifact_id = a.id AND f.id = ? AND f.task_id = ? AND f.company_id = ? AND f.project_revision_id = ? WHERE a.id = ? AND a.company_id = ? AND a.kind = 'forward-merge-conflict'").get(input.forwardMergeId, input.taskId, input.companyId, input.projectRevisionId, input.conflictArtifact.id, input.companyId) as { storagePath: string; sha256: string } | undefined);
    if (!conflictRow || conflictRow.sha256 !== input.conflictArtifact.sha256) throw new AgentFailure("scoped-input-missing", "Forward-merge conflict evidence is unavailable");
    try {
      conflict = ForwardMergeConflictArtifactSchema.parse(JSON.parse((await this.artifacts.read({ companyId: input.companyId, storagePath: conflictRow.storagePath, sha256: conflictRow.sha256 })).toString("utf8")));
    } catch {
      throw new AgentFailure("scoped-input-corrupt", "Forward-merge conflict evidence failed integrity validation");
    }
    if (conflict.priorHead.toLowerCase() !== input.priorHead.toLowerCase() || conflict.observedBaseSha.toLowerCase() !== input.targetBaseSha.toLowerCase() || conflict.conflictFiles.length !== input.conflictFileCount) throw new AgentFailure("merge-conflict-identity-mismatch", "Forward-merge conflict evidence does not match the recorded merge");
    let pinnedCommands: { setupCommand: string; verificationCommand: string };
    try {
      const revision = parseAcceptedProjectRevision(context.normalizedJson);
      pinnedCommands = { setupCommand: revision.setupCommand, verificationCommand: revision.verificationCommand };
    } catch {
      throw new AgentFailure("scoped-input-missing", "The accepted project revision has no valid pinned verification commands");
    }
    const worktreePath = await taskScopedPath(this.config.worktreeRoot, input.worktreePath);
    const [brief, plan] = await Promise.all([
      this.artifacts.read({ companyId: input.companyId, storagePath: context.briefStoragePath, sha256: context.briefSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.read({ companyId: input.companyId, storagePath: context.planStoragePath, sha256: context.planSha256 }).then((bytes) => bytes.toString("utf8")),
    ]);
    const rawSessionId = await this.sessionStore.read(input.leadSessionRef);
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'lead', 'starting', 1, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.leadSessionRef, startedAt));
    const evidenceLines: string[] = [];
    const expectedRawSessionId = rawSessionId;
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 5_000);
    try {
      const result = await this.processRunner({
        command: this.command,
        args: ["exec", "resume", rawSessionId, "--json", "--skip-git-repo-check", this.mergeConflictPlanPrompt(context.title, brief, plan, input, conflict, pinnedCommands)],
        cwd: worktreePath,
        onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); },
        onLine: async (line) => {
          const event = eventValue(line);
          if (event.threadId && event.threadId !== expectedRawSessionId) throw new AgentFailure("session-identity-conflict", "Merge-conflict planning returned a different Lead session identity");
          evidenceLines.push(safeJsonLine(line));
          await this.databaseHeartbeat(executionId, "running");
        },
      });
      if (result.exitCode !== 0) throw agentProcessFailure(result, evidenceLines);
      const output = parseMergeConflictPlan(evidenceLines);
      if (output.resolutions.some((resolution) => resolution.number === undefined || !resolution.intendedResult || !resolution.issueInvariant || !resolution.baseInvariant || !resolution.compatibilityConcern) || output.resolutions.some((resolution, index) => resolution.number !== index + 1)) throw new AgentFailure("invalid-merge-conflict-plan", "The Lead conflict plan must number each resolution and state both invariants plus compatibility concerns");
      const plannedFiles = new Set(output.resolutions.map((resolution) => resolution.file));
      const missingFiles = conflict.conflictFiles.filter((file) => !plannedFiles.has(file));
      const extraFiles = output.resolutions.filter((resolution) => !conflict.conflictFiles.includes(resolution.file));
      if (missingFiles.length || extraFiles.length || plannedFiles.size !== output.resolutions.length) throw new AgentFailure("incomplete-merge-conflict-plan", "The Lead plan must cover each conflict file exactly once");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const planArtifact = await this.artifacts.put(input.companyId, "merge-conflict-plan", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(output, null, 2), "utf8") });
      const planId = `merge_plan_${createHash("sha256").update(`${input.workflowId}:${input.priorHead}:${input.targetBaseSha}`).digest("hex").slice(0, 32)}`;
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, planArtifact.id, planArtifact.companyId, planArtifact.kind, planArtifact.filename, planArtifact.mimeType, planArtifact.byteSize, planArtifact.sha256, planArtifact.storagePath, planArtifact.createdAt);
        db.prepare("INSERT INTO forge_merge_conflict_resolutions (id, task_id, company_id, workflow_id, forward_merge_id, prior_head, target_base_sha, conflict_files_json, plan_artifact_id, plan_evidence_artifact_id, lead_execution_id, lead_session_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?) ON CONFLICT(workflow_id, prior_head, target_base_sha) DO UPDATE SET plan_artifact_id = excluded.plan_artifact_id, plan_evidence_artifact_id = excluded.plan_evidence_artifact_id, lead_execution_id = excluded.lead_execution_id, lead_session_ref = excluded.lead_session_ref, status = 'planned', updated_at = excluded.updated_at").run(planId, input.taskId, input.companyId, input.workflowId, input.forwardMergeId, input.priorHead, input.targetBaseSha, JSON.stringify(conflict.conflictFiles), planArtifact.id, evidence.id, executionId, input.leadSessionRef, now, now);
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(now, now, evidence.id, executionId);
      });
      return { planId, planArtifactId: planArtifact.id, evidenceArtifactId: evidence.id, leadExecutionId: executionId, leadSessionRef: input.leadSessionRef, summary: output.summary };
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("merge-conflict-plan-failed", "Codex Lead merge-conflict planning failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId);
      });
      throw failure;
    } finally { clearInterval(heartbeat); }
  }

  private async blockedDeliveryReviewPreflight(input: DeliveryReviewActivityInput, failure: AgentFailure): Promise<DeliveryReviewActivityResult> {
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const attemptId = `review_attempt_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    const code = deliveryBlockCode(failure);
    const summary = safeBlockSummary(code);
    const references = this.database.authQuery((db) => ({
      task: db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId) as { id: string } | undefined,
      developerExecution: db.prepare("SELECT id FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.subject.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string } | undefined,
      deliveryArtifact: db.prepare("SELECT id FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.subject.deliveryArtifactId, input.companyId) as { id: string } | undefined,
      developerEvidence: db.prepare("SELECT id FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.subject.developerEvidenceArtifactId, input.companyId) as { id: string } | undefined,
    }));
    if (!references.task || !references.developerExecution || !references.deliveryArtifact || !references.developerEvidence) throw failure;
    const { developerExecution, deliveryArtifact, developerEvidence } = references;
    const evidence = await this.persistEvidence(input.companyId, executionId, [JSON.stringify({ type: "forge.review-preflight-blocked", code })]);
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, failure_code, failure_summary, evidence_artifact_id) VALUES (?, ?, ?, ?, 'lead', 'blocked', 1, ?, ?, ?, ?, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.subject.leadSessionRef, startedAt, this.now().toISOString(), code, summary, evidence.id);
      db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id, lead_session_ref, developer_session_ref, status, correction_attempts, evidence_artifact_id, failure_code, failure_summary, supersedes_review_id, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', 0, ?, ?, ?, ?, ?, ?)").run(attemptId, input.taskId, input.companyId, input.workflowId, input.subject.planRevision, input.subject.targetBaseSha, input.subject.subjectCommit, input.subject.subjectTree, developerExecution.id, deliveryArtifact.id, developerEvidence.id, executionId, input.subject.leadSessionRef, input.subject.developerSessionRef, evidence.id, code, summary, input.supersedesReviewId, startedAt, this.now().toISOString());
    });
    return DeliveryReviewActivityResultSchema.parse({ outcome: "blocked", attemptId, code, summary, evidenceArtifactId: evidence.id, executionId, sessionRef: input.subject.leadSessionRef, correctionAttempts: 0, subject: input.subject });
  }

  async planCiRepair(rawInput: CiRepairPlanActivityInput): Promise<CiRepairPlanActivityResult> {
    const input = rawInput;
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, t.role_profiles_json AS roleProfiles, a.outcome, a.observed_head_sha AS observedHeadSha, a.evidence_artifact_id AS evidenceArtifactId
      FROM forge_tasks t
      JOIN forge_ci_runs c ON c.id = ? AND c.task_id = t.id AND c.company_id = t.company_id AND c.superseded_at IS NULL
      JOIN forge_ci_attempts a ON a.id = ? AND a.run_id = c.id AND a.observed_head_sha = c.expected_head_sha
      WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_id = ? AND t.project_revision_id = ?
        AND c.expected_head_sha = ?
        AND EXISTS (SELECT 1 FROM forge_issue_outputs original WHERE original.task_id = t.id AND original.company_id = t.company_id AND original.workflow_id = t.workflow_id AND original.session_ref = ?)`)
      .get(input.ciRunId, input.ciAttemptId, input.taskId, input.companyId, input.workflowId, input.projectId, input.projectRevisionId, input.failedHeadSha, input.leadSessionRef) as { title: string; roleProfiles: string; outcome: string; observedHeadSha: string; evidenceArtifactId: string | null } | undefined);
    if (!context || context.outcome !== "failed" || context.evidenceArtifactId !== input.evidenceArtifactId) throw new AgentFailure("ci-repair-attempt-mismatch", "CI repair planning input does not identify the exact failed attempt");
    const failedChecks = this.database.authQuery((db) => db.prepare("SELECT name, conclusion, summary FROM forge_ci_attempt_checks WHERE attempt_id = ? AND selected_for_evaluation = 1 AND conclusion = 'failure' ORDER BY name").all(input.ciAttemptId) as Array<{ name: string; conclusion: string; summary: string | null }>);
    if (!failedChecks.length) throw new AgentFailure("ci-repair-not-authorized", "Only exact-head failed checks can enter CI repair planning");
    const existingPlan = this.database.authQuery((db) => db.prepare("SELECT id, plan_artifact_id AS planArtifactId, evidence_artifact_id AS evidenceArtifactId, lead_execution_id AS leadExecutionId, lead_session_ref AS leadSessionRef, summary FROM forge_ci_repair_plans WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND ci_run_id = ? AND ci_attempt_id = ? AND status = 'planned' ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.ciRunId, input.ciAttemptId) as { id: string; planArtifactId: string; evidenceArtifactId: string; leadExecutionId: string; leadSessionRef: string; summary: string } | undefined);
    if (existingPlan) return { planId: existingPlan.id, planArtifactId: existingPlan.planArtifactId, evidenceArtifactId: existingPlan.evidenceArtifactId, leadExecutionId: existingPlan.leadExecutionId, leadSessionRef: existingPlan.leadSessionRef, summary: existingPlan.summary };
    const revision = this.database.authQuery((db) => db.prepare("SELECT normalized_json FROM forge_project_revisions WHERE id = ? AND project_id = ? AND state = 'accepted'").get(input.projectRevisionId, input.projectId) as { normalized_json: string } | undefined);
    if (!revision) throw new AgentFailure("scoped-input-missing", "Accepted project revision is unavailable");
    let revisionConfig: { requiredChecks?: unknown; verificationCommand?: unknown };
    try {
      revisionConfig = JSON.parse(revision.normalized_json) as { requiredChecks?: unknown; verificationCommand?: unknown };
    } catch {
      throw new AgentFailure("invalid-project-revision", "The accepted project revision is malformed");
    }
    const requiredChecks = input.requiredChecks.length ? input.requiredChecks : Array.isArray(revisionConfig.requiredChecks) ? revisionConfig.requiredChecks.filter((check): check is string => typeof check === "string") : [];
    const localVerification = input.localVerification.length ? input.localVerification : typeof revisionConfig.verificationCommand === "string" ? [revisionConfig.verificationCommand] : [];
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(pinnedRepositoryPath(revision.normalized_json)));
    const rawSessionId = await this.sessionStore.read(input.leadSessionRef);
    if (!rawSessionId) throw new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'lead', 'starting', 1, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.leadSessionRef, startedAt));
    const evidenceLines: string[] = [];
    const outputLines: string[] = [];
    const prompt = this.ciRepairPrompt(context.title, { ...input, requiredChecks, localVerification }, failedChecks);
    let plan: import("./temporal/issue-contracts.js").CiRepairPlan | undefined;
    let failure: AgentFailure | undefined;
    try {
      for (let turn = 0; turn < 2 && !plan; turn += 1) {
        const result = await this.processRunner({ command: this.command, args: ["exec", "resume", rawSessionId, "--json", "--skip-git-repo-check", turn === 0 ? prompt : `${prompt}\n\nReturn one corrected schema-valid object only.`], cwd: repositoryPath, onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); }, onLine: async (line) => { const event = eventValue(line); if (event.threadId && event.threadId !== rawSessionId) throw new AgentFailure("session-identity-conflict", "CI repair planning returned a different Lead session identity"); evidenceLines.push(safeJsonLine(line)); outputLines.push(line); await this.databaseHeartbeat(executionId, "running"); } });
        if (result.exitCode !== 0) throw agentProcessFailure(result, outputLines);
        try {
          plan = parseCiRepairPlan(outputLines);
          const expectedFailedNames = new Set(failedChecks.map((failed) => failed.name));
          if (plan.ciRunId !== input.ciRunId || plan.ciAttemptId !== input.ciAttemptId || plan.failedHeadSha.toLowerCase() !== input.failedHeadSha.toLowerCase() || plan.failedChecks.length !== expectedFailedNames.size || new Set(plan.failedChecks.map((check) => check.name)).size !== expectedFailedNames.size || plan.failedChecks.some((check) => !expectedFailedNames.has(check.name) || check.evidenceArtifactId !== input.evidenceArtifactId)) throw new AgentFailure("ci-repair-plan-identity-mismatch", "CI repair plan is not bounded to the exact failed attempt");
        } catch (error) { failure = error instanceof AgentFailure ? error : new AgentFailure("invalid-ci-repair-plan", "CI repair plan is invalid"); if (turn === 1) throw failure; }
      }
      if (!plan) throw failure ?? new AgentFailure("invalid-ci-repair-plan", "CI repair plan is unavailable");
      const validatedPlan = plan;
      const evidence = await this.artifacts.put(input.companyId, "ci-repair-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      const planArtifact = await this.artifacts.put(input.companyId, "ci-repair-plan", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(validatedPlan, null, 2), "utf8") });
      const planId = `ci_plan_${randomBytes(12).toString("hex")}`;
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, planArtifact.id, planArtifact.companyId, planArtifact.kind, planArtifact.filename, planArtifact.mimeType, planArtifact.byteSize, planArtifact.sha256, planArtifact.storagePath, planArtifact.createdAt);
        db.prepare("INSERT INTO forge_ci_repair_plans (id, task_id, company_id, workflow_id, ci_run_id, ci_attempt_id, failed_head_sha, lead_execution_id, lead_session_ref, plan_artifact_id, evidence_artifact_id, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)").run(planId, input.taskId, input.companyId, input.workflowId, input.ciRunId, input.ciAttemptId, input.failedHeadSha, executionId, input.leadSessionRef, planArtifact.id, evidence.id, validatedPlan.rootCause, this.now().toISOString(), this.now().toISOString());
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), evidence.id, executionId);
      });
      return { planId, planArtifactId: planArtifact.id, evidenceArtifactId: evidence.id, leadExecutionId: executionId, leadSessionRef: input.leadSessionRef, summary: validatedPlan.rootCause };
    } catch (error) {
      const reason = error instanceof AgentFailure ? error : new AgentFailure("ci-repair-plan-failed", "CI repair planning failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      this.database.authTransaction((db) => { db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt); db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), reason.code, reason.message, evidence.id, executionId); });
      throw reason;
    }
  }

  async reviewDelivery(rawInput: DeliveryReviewActivityInput): Promise<DeliveryReviewActivityResult>;
  async reviewDelivery(rawInput: DeliveryReviewActivityInput): Promise<DeliveryReviewActivityResult> {
    const input = DeliveryReviewActivityInputSchema.parse(rawInput);
    const subject = input.subject;
    const targetBaseSha = subject.targetBaseSha;
    const subjectCommit = subject.subjectCommit;
    const subjectTree = subject.subjectTree;
    const leadSessionRef = subject.leadSessionRef;
    const isFinalReview = input.reviewKind === "final";
    if (isFinalReview && (!input.releaseId || !input.ciRunId || !input.deliveryReviewId)) throw new AgentFailure("scoped-input-missing", "Final review requires the exact release, delivery review, and CI run");
    const finalContext = isFinalReview ? this.database.authQuery((db) => db.prepare("SELECT r.id, r.base_sha AS baseSha, r.head_sha AS headSha, r.head_tree AS headTree, c.status FROM forge_releases r JOIN forge_ci_runs c ON c.id = ? AND c.release_id = r.id WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.superseded_at IS NULL AND c.superseded_at IS NULL AND c.project_revision_id = ? AND c.policy_hash IS NOT NULL AND EXISTS (SELECT 1 FROM forge_ci_attempts ca WHERE ca.run_id = c.id AND ca.attempt_number = (SELECT MAX(latest.attempt_number) FROM forge_ci_attempts latest WHERE latest.run_id = c.id) AND ca.outcome = 'passed' AND ca.observed_head_sha = r.head_sha)").get(input.ciRunId, input.releaseId, input.taskId, input.companyId, input.workflowId, input.projectRevisionId) as { id: string; baseSha: string; headSha: string; headTree: string; status: string } | undefined) : undefined;
    if (isFinalReview && (!finalContext || finalContext.status !== "passed" || finalContext.headSha.toLowerCase() !== subjectCommit.toLowerCase() || finalContext.headTree.toLowerCase() !== subjectTree.toLowerCase() || finalContext.baseSha.toLowerCase() !== targetBaseSha.toLowerCase())) {
      throw new AgentFailure("ci-not-authoritative", "Final review requires passed CI for the exact reviewed release head");
    }
    if (isFinalReview) {
      const exactDelivery = this.database.authQuery((db) => db.prepare(`SELECT dr.id
        FROM forge_delivery_reviews dr
        JOIN forge_developer_executions de ON de.id = ? AND de.id = ? AND de.task_id = dr.task_id AND de.company_id = dr.company_id AND de.workflow_id = dr.workflow_id
        WHERE dr.id = ? AND dr.task_id = ? AND dr.company_id = ? AND dr.workflow_id = ? AND dr.outcome = 'approved'
          AND dr.plan_revision = ? AND lower(dr.base_sha) = lower(?) AND lower(dr.subject_commit) = lower(?) AND lower(dr.subject_tree) = lower(?) AND dr.session_ref = ?`).get(subject.developerExecutionId, subject.developerExecutionId, input.deliveryReviewId, input.taskId, input.companyId, input.workflowId, subject.planRevision, targetBaseSha, subjectCommit, subjectTree, leadSessionRef) as { id: string } | undefined);
      if (!exactDelivery) throw new AgentFailure("delivery-review-not-authoritative", "Final review requires the exact approved delivery review and Developer execution");
    }
    const existingFinal = isFinalReview ? this.database.authQuery((db) => db.prepare("SELECT id, lead_execution_id AS leadExecutionId, session_ref AS sessionRef, opinion_artifact_id AS opinionArtifactId, evidence_artifact_id AS evidenceArtifactId, outcome, summary FROM forge_final_reviews WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND release_id = ? AND ci_run_id = ? AND delivery_review_id = ? AND developer_execution_id = ? AND subject_commit = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.releaseId, input.ciRunId, input.deliveryReviewId, subject.developerExecutionId, subjectCommit) as { id: string; leadExecutionId: string; sessionRef: string; opinionArtifactId: string; evidenceArtifactId: string; outcome: "approved" | "blocking"; summary: string } | undefined) : undefined;
    if (existingFinal) {
      const findings = this.database.authQuery((db) => db.prepare("SELECT id AS findingId, severity, rationale, evidence_ref AS evidenceRef, disposition, repair_instruction AS repairInstruction FROM forge_final_review_findings WHERE review_id = ? ORDER BY id").all(existingFinal.id) as DeliveryReview["findings"]);
      return DeliveryReviewActivityResultSchema.parse({ outcome: "completed", attemptId: `review_attempt_existing_${existingFinal.id}`, correctionAttempts: 0, subject, review: { reviewId: existingFinal.id, leadExecutionId: existingFinal.leadExecutionId, leadSessionRef: existingFinal.sessionRef, opinionArtifactId: existingFinal.opinionArtifactId, evidenceArtifactId: existingFinal.evidenceArtifactId, opinion: existingFinal.outcome, summary: existingFinal.summary, repairPlan: null, findings, supersedesReviewId: input.supersedesReviewId } });
    }
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, r.normalized_json AS normalizedJson,
      b.storage_path AS briefStoragePath, b.sha256 AS briefSha256,
      pa.storage_path AS planStoragePath, pa.sha256 AS planSha256,
      da.storage_path AS deliveryStoragePath, da.sha256 AS deliverySha256,
      ea.storage_path AS evidenceStoragePath, ea.sha256 AS evidenceSha256,
      de.session_ref AS developerSessionRef
      FROM forge_tasks t
      JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id
      JOIN forge_issue_outputs io ON io.task_id = t.id AND io.workflow_id = t.workflow_id AND io.output_artifact_id = ? AND io.revision = ?
      JOIN forge_artifacts pa ON pa.id = io.output_artifact_id
      JOIN forge_developer_executions de ON de.id = ? AND de.task_id = t.id AND de.company_id = t.company_id AND de.workflow_id = t.workflow_id AND de.delivery_artifact_id = ? AND de.evidence_artifact_id = ?
      JOIN forge_artifacts da ON da.id = de.delivery_artifact_id
      JOIN forge_artifacts ea ON ea.id = de.evidence_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ? AND b.id = ?`).get(
      input.leadOutputArtifactId,
      input.planRevision,
      subject.developerExecutionId,
      subject.deliveryArtifactId,
      subject.developerEvidenceArtifactId,
      input.taskId,
      input.companyId,
      input.projectId,
      input.projectRevisionId,
      input.briefArtifactId,
    ) as DeliveryReviewContext | undefined);
    if (!context || !context.developerSessionRef) {
      const failure = new AgentFailure("scoped-input-missing", "Exact Developer delivery evidence is unavailable");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    if (context.developerSessionRef !== subject.developerSessionRef) {
      const failure = new AgentFailure("delivery-revision-changed", "The Developer session no longer matches the immutable review subject");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    if (context.developerSessionRef === leadSessionRef) {
      const failure = new AgentFailure("session-identity-conflict", "Lead review must reuse the Lead session and remain distinct from Developer");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    let repositoryPath: string;
    let worktreePath: string;
    try {
      repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(pinnedRepositoryPath(context.normalizedJson)));
      worktreePath = await taskScopedPath(this.config.worktreeRoot, input.worktreePath);
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("unsafe-working-directory", "The delivery worktree is outside the configured scope");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    let brief: string;
    let plan: string;
    let delivery: string;
    let developerEvidence: string;
    let gitEvidence: Awaited<ReturnType<typeof readDeliveryGitEvidence>>;
    try {
      [brief, plan, delivery, developerEvidence, gitEvidence] = await Promise.all([
        this.artifacts.read({ companyId: input.companyId, storagePath: context.briefStoragePath, sha256: context.briefSha256 }).then((bytes) => bytes.toString("utf8")),
        this.artifacts.read({ companyId: input.companyId, storagePath: context.planStoragePath, sha256: context.planSha256 }).then((bytes) => bytes.toString("utf8")),
        this.artifacts.read({ companyId: input.companyId, storagePath: context.deliveryStoragePath, sha256: context.deliverySha256 }).then((bytes) => bytes.toString("utf8")),
        this.artifacts.read({ companyId: input.companyId, storagePath: context.evidenceStoragePath, sha256: context.evidenceSha256 }).then((bytes) => bytes.toString("utf8")),
        readDeliveryGitEvidence(worktreePath, targetBaseSha, subjectCommit, repositoryPath),
      ]);
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("delivery-revision-changed", "The exact Developer delivery evidence could not be verified");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    if (gitEvidence.branch !== input.branchName || gitEvidence.head.toLowerCase() !== subjectCommit.toLowerCase() || gitEvidence.tree.toLowerCase() !== subjectTree.toLowerCase() || gitEvidence.status.trim()) {
      const failure = new AgentFailure("delivery-revision-changed", "The Developer delivery no longer matches its recorded clean exact revision");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    if (!isFinalReview && input.supersedesReviewId) {
      const superseded = this.database.authQuery((db) => db.prepare(`
        SELECT r.id,
          EXISTS (
            SELECT 1 FROM forge_delivery_repairs p
            WHERE p.review_id = r.id AND p.task_id = r.task_id AND p.company_id = r.company_id AND p.workflow_id = r.workflow_id
              AND p.status = 'completed' AND p.result_commit = ? AND p.result_tree = ?
              AND p.developer_execution_id = ? AND p.delivery_artifact_id = ? AND p.evidence_artifact_id = ?
          ) AS repaired
        FROM forge_delivery_reviews r
        WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ?
          AND r.plan_revision = ? AND r.base_sha = ? AND r.outcome = 'blocking'
          AND NOT EXISTS (SELECT 1 FROM forge_delivery_reviews successor WHERE successor.supersedes_review_id = r.id)
      `).get(subjectCommit, subjectTree, subject.developerExecutionId, subject.deliveryArtifactId, subject.developerEvidenceArtifactId, input.supersedesReviewId, input.taskId, input.companyId, input.workflowId, subject.planRevision, targetBaseSha) as { id: string; repaired: number } | undefined);
      if (!superseded || superseded.repaired !== 1) {
        const failure = new AgentFailure("delivery-revision-changed", "The fresh review is not linked to the immediately repaired blocking review subject");
        if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
        throw failure;
      }
    }
    const leadProfile = this.database.authQuery((db) => db.prepare("SELECT model, provider FROM forge_profiles WHERE id = ?").get(input.roleProfiles.lead) as { model: string; provider: string } | undefined);
    if (!leadProfile || leadProfile.provider !== "codex") {
      const failure = new AgentFailure("profile-unavailable", "Lead review requires the configured Codex Lead profile");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    let rawSessionId: string;
    try {
      rawSessionId = await this.sessionStore.read(leadSessionRef);
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    if (!rawSessionId) {
      const failure = new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    const attemptId = `review_attempt_${randomBytes(12).toString("hex")}`;
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'lead', 'starting', 1, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, leadSessionRef, startedAt);
      if (!isFinalReview) db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id, lead_session_ref, developer_session_ref, status, correction_attempts, supersedes_review_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)").run(attemptId, input.taskId, input.companyId, input.workflowId, subject.planRevision, targetBaseSha, subjectCommit, subjectTree, subject.developerExecutionId, subject.deliveryArtifactId, subject.developerEvidenceArtifactId, executionId, leadSessionRef, context.developerSessionRef, input.supersedesReviewId, startedAt);
    });
    const evidenceLines: string[] = [];
    const outputLines: string[] = [];
    let correctionAttempts = 0;
    let evidenceBytes = 0;
    const expectedRawSessionId = rawSessionId;
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 5_000);
    try {
      const initialPrompt = this.deliveryReviewPrompt(context.title, brief, plan, delivery, developerEvidence, gitEvidence) + (isFinalReview ? `\n\nExact required CI context: ${JSON.stringify({ releaseId: input.releaseId, ciRunId: input.ciRunId, status: finalContext?.status, headSha: finalContext?.headSha, headTree: finalContext?.headTree })}` : "");
      const runTurn = async (turn: number, prompt: string): Promise<void> => {
        evidenceLines.push(JSON.stringify({ type: "forge.review-turn-start", turn }));
        const result = await this.processRunner({
          command: this.command,
          args: ["exec", "resume", rawSessionId, "--json", "--skip-git-repo-check", prompt],
          cwd: worktreePath,
          onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); },
          onLine: async (line) => {
            const sanitized = safeJsonLine(line);
            evidenceBytes += Buffer.byteLength(sanitized, "utf8") + 1;
            if (evidenceBytes > 6 * 1024 * 1024) throw new AgentFailure("evidence-too-large", "Codex evidence exceeded the local artifact limit");
            const event = eventValue(line);
            if (event.threadId && event.threadId !== expectedRawSessionId) throw new AgentFailure("session-identity-conflict", "Lead delivery review returned a different session identity");
            evidenceLines.push(sanitized);
            outputLines.push(line);
            await this.databaseHeartbeat(executionId, "running");
          },
        });
        if (result.exitCode !== 0) throw agentProcessFailure(result, outputLines, leadProfile.model);
        evidenceLines.push(JSON.stringify({ type: "forge.review-turn-end", turn }));
      };
      let review: DeliveryReview;
      try {
        await runTurn(1, initialPrompt);
        review = DeliveryReviewSchema.parse(parseDeliveryReview(outputLines));
      } catch (firstError) {
        const firstFailure = firstError instanceof AgentFailure ? firstError : new AgentFailure("invalid-review-output", "Lead review output did not satisfy the required format");
        if (isFinalReview) throw firstFailure;
        if (!["missing-review-output", "malformed-review-output", "invalid-review-output"].includes(firstFailure.code)) throw firstFailure;
        correctionAttempts = 1;
        outputLines.length = 0;
        const correctionPrompt = (`The prior Lead response was not machine-readable. Format-only correction; do not change the review substance or scope. Validation issue: ${firstFailure.code}: ${firstFailure.message}\nReturn only the required delivery_review JSON object described in the prior prompt.`).slice(0, 2_000);
        await runTurn(2, correctionPrompt);
        try { review = DeliveryReviewSchema.parse(parseDeliveryReview(outputLines)); }
        catch { throw new AgentFailure("correction-exhausted", safeBlockSummary("correction-exhausted", true)); }
      }
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const opinion = await this.artifacts.put(input.companyId, "delivery-review", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(review, null, 2), "utf8") });
      const repairPlanArtifact = review.repairPlan ? await this.artifacts.put(input.companyId, "delivery-repair-plan", { filename: `${executionId}-repair-plan.md`, mimeType: "text/markdown", bytes: Buffer.from(review.repairPlan, "utf8") }) : undefined;
      const reviewId = `delivery_review_${randomBytes(12).toString("hex")}`;
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, opinion.id, opinion.companyId, opinion.kind, opinion.filename, opinion.mimeType, opinion.byteSize, opinion.sha256, opinion.storagePath, opinion.createdAt);
        if (repairPlanArtifact) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(repairPlanArtifact.id, repairPlanArtifact.companyId, repairPlanArtifact.kind, repairPlanArtifact.filename, repairPlanArtifact.mimeType, repairPlanArtifact.byteSize, repairPlanArtifact.sha256, repairPlanArtifact.storagePath, repairPlanArtifact.createdAt);
        if (isFinalReview) {
          db.prepare("INSERT INTO forge_final_reviews (id, task_id, company_id, workflow_id, release_id, ci_run_id, delivery_review_id, developer_execution_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.releaseId, input.ciRunId, input.deliveryReviewId, subject.developerExecutionId, subject.planRevision, targetBaseSha, subjectCommit, subjectTree, executionId, leadSessionRef, review.outcome, review.summary, opinion.id, evidence.id, this.now().toISOString());
          for (const finding of review.findings) db.prepare("INSERT INTO forge_final_review_findings (id, review_id, task_id, company_id, severity, rationale, evidence_ref, disposition, repair_instruction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(finding.findingId, reviewId, input.taskId, input.companyId, finding.severity, finding.rationale, finding.evidenceRef, finding.disposition, finding.repairInstruction);
        } else {
          db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, supersedes_review_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.planRevision, targetBaseSha, subjectCommit, subjectTree, executionId, leadSessionRef, review.outcome, review.summary, opinion.id, evidence.id, input.supersedesReviewId, this.now().toISOString());
          for (const finding of review.findings) db.prepare("INSERT INTO forge_delivery_findings (id, review_id, task_id, company_id, severity, rationale, evidence_ref, disposition, repair_instruction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`delivery_finding_${reviewId}_${finding.findingId}`, reviewId, input.taskId, input.companyId, finding.severity, finding.rationale, finding.evidenceRef, finding.disposition, finding.repairInstruction, this.now().toISOString());
        }
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), evidence.id, executionId);
        if (!isFinalReview) db.prepare("UPDATE forge_delivery_review_attempts SET status = 'completed', correction_attempts = ?, evidence_artifact_id = ?, completed_review_id = ?, finished_at = ? WHERE id = ?").run(correctionAttempts, evidence.id, reviewId, this.now().toISOString(), attemptId);
      });
      const completed = DeliveryReviewActivityResultSchema.parse({ outcome: "completed", attemptId, correctionAttempts, subject: { ...subject, developerSessionRef: context.developerSessionRef }, review: { reviewId, leadExecutionId: executionId, leadSessionRef, opinionArtifactId: opinion.id, evidenceArtifactId: evidence.id, opinion: review.outcome, summary: review.summary, repairPlan: review.repairPlan, repairPlanArtifactId: repairPlanArtifact?.id ?? null, repairPlanSha256: repairPlanArtifact?.sha256 ?? null, findings: review.findings, supersedesReviewId: input.supersedesReviewId } });
      return completed;
    } catch (error) {
      const expectedFailure = error instanceof AgentFailure;
      const failure = error instanceof AgentFailure ? error : new AgentFailure("delivery-review-failed", "Codex Lead delivery review failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const code = failure.code === "correction-exhausted" ? "correction-exhausted" : deliveryBlockCode(failure);
      const summary = safeBlockSummary(code, code === "correction-exhausted");
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(isFinalReview || !expectedFailure ? "failed" : "blocked", this.now().toISOString(), this.now().toISOString(), code, summary, evidence.id, executionId);
        if (!isFinalReview) db.prepare("UPDATE forge_delivery_review_attempts SET status = ?, correction_attempts = ?, evidence_artifact_id = ?, failure_code = ?, failure_summary = ?, finished_at = ? WHERE id = ?").run(expectedFailure ? "blocked" : "failed", correctionAttempts, evidence.id, code, summary, this.now().toISOString(), attemptId);
      });
      if (!expectedFailure || isFinalReview) throw error;
      return DeliveryReviewActivityResultSchema.parse({ outcome: "blocked", attemptId, code, summary, evidenceArtifactId: evidence.id, executionId, sessionRef: leadSessionRef, correctionAttempts, subject: { ...subject, developerSessionRef: context.developerSessionRef } });
    } finally { clearInterval(heartbeat); }
  }

  async runSupplementalReview(rawInput: SupplementalReviewActivityInput): Promise<SupplementalReviewResult> {
    const input = rawInput;
    const profile = this.database.authQuery((db) => db.prepare("SELECT id, model, provider FROM forge_profiles WHERE id = ?").get(input.roleProfiles.reviewer) as { id: string; model: string; provider: string } | undefined);
    if (!profile || profile.provider !== "codex") throw new AgentFailure("reviewer-profile-unavailable", "Supplemental review requires an allowed profile");
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, r.normalized_json, b.storage_path AS brief_storage_path, b.sha256 AS brief_sha256, oa.storage_path AS output_storage_path, oa.sha256 AS output_sha256, e.storage_path AS evidence_storage_path, e.sha256 AS evidence_sha256
      FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id JOIN forge_issue_outputs io ON io.task_id = t.id AND io.output_artifact_id = ?
      JOIN forge_artifacts oa ON oa.id = io.output_artifact_id JOIN forge_artifacts e ON e.id = io.evidence_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ? AND b.id = ?`).get(input.leadOutputArtifactId, input.taskId, input.companyId, input.projectId, input.projectRevisionId, input.briefArtifactId) as { title: string; normalized_json: string; brief_storage_path: string; brief_sha256: string; output_storage_path: string; output_sha256: string; evidence_storage_path: string; evidence_sha256: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Supplemental review evidence is unavailable");
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(pinnedRepositoryPath(context.normalized_json)));
    const brief = (await this.artifacts.read({ companyId: input.companyId, storagePath: context.brief_storage_path, sha256: context.brief_sha256 })).toString("utf8");
    const draft = (await this.artifacts.read({ companyId: input.companyId, storagePath: context.output_storage_path, sha256: context.output_sha256 })).toString("utf8");
    const priorEvidence = (await this.artifacts.read({ companyId: input.companyId, storagePath: context.evidence_storage_path, sha256: context.evidence_sha256 })).toString("utf8");
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES (?, ?, ?, ?, 'reviewer', 'starting', 1, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, startedAt));
    const lines: string[] = [];
    let sessionRef: string | undefined;
    let rawSessionId: string | undefined;
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 5_000);
    try {
      const result = await this.processRunner({
        command: this.command,
        args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--model", profile.model, this.reviewPrompt(context.title, brief, context.normalized_json, draft, priorEvidence)],
        cwd: repositoryPath,
        onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); },
        onLine: async (line) => {
          const sanitized = safeJsonLine(line);
          lines.push(sanitized);
          const event = eventValue(line);
          if (event.threadId && !sessionRef) { rawSessionId = event.threadId; sessionRef = await this.sessionStore.create(rawSessionId); await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId)); }
          await this.databaseHeartbeat(executionId, "running");
        },
      });
      if (result.exitCode !== 0) throw agentProcessFailure(result, lines, profile.model);
      const review = parseSupplementalReview(lines);
      if (!sessionRef) throw new AgentFailure("missing-session", "Supplemental review did not return a session reference");
      const evidence = await this.persistEvidence(input.companyId, executionId, lines);
      const reviewArtifact = await this.artifacts.put(input.companyId, "supplemental-review", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(review, null, 2), "utf8") });
      const reviewId = `review_${randomBytes(12).toString("hex")}`;
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, reviewArtifact.id, reviewArtifact.companyId, reviewArtifact.kind, reviewArtifact.filename, reviewArtifact.mimeType, reviewArtifact.byteSize, reviewArtifact.sha256, reviewArtifact.storagePath, reviewArtifact.createdAt);
        db.prepare("INSERT INTO forge_plan_reviews (id, task_id, company_id, workflow_id, plan_revision, profile_id, execution_id, session_ref, opinion_artifact_id, evidence_artifact_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.revision, profile.id, executionId, sessionRef, reviewArtifact.id, evidence.id, review.summary, this.now().toISOString());
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), evidence.id, executionId);
      });
      return { reviewId, reviewArtifactId: reviewArtifact.id, evidenceArtifactId: evidence.id, executionId, sessionRef, summary: review.summary };
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("review-failed", "Supplemental review failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, lines);
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId);
      });
      throw failure;
    } finally { clearInterval(heartbeat); }
  }

  async consolidateLeadPlan(rawInput: ConsolidateLeadPlanActivityInput): Promise<LeadPlanningResult> {
    const rawSessionId = await this.sessionStore.read(rawInput.leadSessionRef);
    const lead = this.database.authQuery((db) => db.prepare("SELECT model, provider FROM forge_profiles WHERE id = ?").get(rawInput.roleProfiles.lead) as { model: string; provider: string } | undefined);
    if (!lead || lead.provider !== "codex") throw new AgentFailure("profile-unavailable", "Lead profile is unavailable for consolidation");
    const draft = this.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a WHERE a.id = ? AND a.company_id = ?").get(rawInput.leadOutputArtifactId, rawInput.companyId) as { storagePath: string; sha256: string } | undefined);
    const review = this.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a WHERE a.id = ? AND a.company_id = ?").get(rawInput.supplementalReviewArtifactId, rawInput.companyId) as { storagePath: string; sha256: string } | undefined);
    if (!draft || !review) throw new AgentFailure("scoped-input-missing", "Consolidation evidence is unavailable");
    const repositoryPath = await this.consolidationRepositoryPath(rawInput);
    const draftText = (await this.artifacts.read({ ...draft, companyId: rawInput.companyId })).toString("utf8");
    const reviewText = (await this.artifacts.read({ ...review, companyId: rawInput.companyId })).toString("utf8");
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'lead', 'starting', 1, ?, ?)").run(executionId, rawInput.taskId, rawInput.companyId, rawInput.workflowId, rawInput.leadSessionRef, startedAt));
    const lines: string[] = [];
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 5_000);
    try {
      const result = await this.processRunner({ command: this.command, args: ["exec", "resume", rawSessionId, "--json", "--skip-git-repo-check", this.consolidationPrompt(draftText, reviewText)], cwd: repositoryPath, onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); }, onLine: async (line) => { lines.push(safeJsonLine(line)); await this.databaseHeartbeat(executionId, "running"); } });
      if (result.exitCode !== 0) throw agentProcessFailure(result, lines, lead.model);
      const output = parseLeadOutput(lines);
      const persisted = await this.persistOutput({ taskId: rawInput.taskId, companyId: rawInput.companyId, workflowId: rawInput.workflowId, projectId: rawInput.projectId, projectRevisionId: rawInput.projectRevisionId, briefArtifactId: rawInput.briefArtifactId, imageArtifactIds: rawInput.imageArtifactIds, roleProfiles: rawInput.roleProfiles, revision: rawInput.revision }, executionId, rawInput.leadSessionRef, lines, output);
      await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), persisted.evidence.id, executionId));
      return persisted.result;
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("consolidation-failed", "Lead consolidation failed");
      const evidence = await this.persistEvidence(rawInput.companyId, executionId, lines);
      this.database.authTransaction((db) => { db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt); db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId); });
      throw failure;
    } finally { clearInterval(heartbeat); }
  }

  private deliveryRepairPlanPrompt(input: DeliveryRepairPlanActivityInput, findings: DeliveryFinding[]): string {
    return [
      "Continue the existing Forge Lead session. Produce one bounded delivery repair plan only; do not modify files, run provider commands, or invent facts.",
      'Return exactly one JSON object with no markdown fences: {"kind":"delivery_repair_plan","summary":"...","steps":[{"number":1,"instruction":"...","verification":"..."}],"verificationStrategy":"...","unresolvedTechnicalQuestions":[]}.',
      "Unresolved technical questions must be empty. Address every open blocking finding exactly once and preserve the exact task, project revision, branch, target base, subject commit, and subject tree.",
      `Exact context: ${JSON.stringify({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectId: input.projectId, projectRevisionId: input.projectRevisionId, source: input.source, leadSessionRef: input.leadSessionRef, releaseId: input.releaseId ?? null, deliveryReviewId: input.deliveryReviewId ?? null, finalReviewId: input.finalReviewId ?? null, ciRunId: input.ciRunId ?? null, acceptanceId: input.acceptanceId ?? null, branchName: input.branchName, worktreePath: input.worktreePath, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree })}`,
      `Open blocking findings: ${JSON.stringify(findings)}`,
    ].join("\n\n");
  }

  private mergeConflictPlanPrompt(title: string, brief: string, plan: string, input: MergeConflictPlanInput, conflict: ForwardMergeConflictArtifact, pinnedCommands: { setupCommand: string; verificationCommand: string }): string {
    return [
      "You are Forge's Lead resolving a target-base forward-merge conflict. Continue the existing Lead session and work read-only. Do not modify files, abort the merge, use GitHub/provider commands, or invent facts.",
      'Return exactly one JSON object with no markdown fences or commentary matching: {"kind":"merge_conflict_plan","summary":"...","resolutions":[{"number":1,"file":"path","resolution":"specific resolution grounded in both sides","intendedResult":"...","issueInvariant":"...","baseInvariant":"...","compatibilityConcern":"..."}],"verificationStrategy":"complete local verification after the merge commit","unresolvedQuestions":[]}. Number every resolution from 1; every conflict file must appear exactly once and unresolvedQuestions must be empty.',
      "Task: " + title + "\nBrief:\n" + brief,
      "Approved plan:\n" + plan,
      "Forward-merge identity:\n" + JSON.stringify({ branchName: input.branchName, priorHead: input.priorHead, targetBaseSha: input.targetBaseSha }),
      "Conflict files:\n" + conflict.conflictFiles.join("\n"),
      "Combined conflict evidence:\n" + conflict.combinedDiff,
      "Pinned deterministic commands:\n" + JSON.stringify(pinnedCommands),
    ].join("\n\n");
  }

  private ciRepairPrompt(title: string, input: CiRepairPlanActivityInput, failedChecks: Array<{ name: string; conclusion: string; summary: string | null }>): string {
    return `You are Forge's Lead diagnosing one exact failed CI observation. Resume the same Lead session. Use only the bounded check names and summaries below; do not request a new session, branch, worktree, pull request, provider rerun, merge, rebase, amend, force push, or history rewrite. Return exactly one JSON object matching the ci-repair-plan schema with contiguous steps, complete pinned local verification, and no unresolved questions.\n\nTask: ${title}\nExact identity: ${JSON.stringify({ ciRunId: input.ciRunId, ciAttemptId: input.ciAttemptId, failedHeadSha: input.failedHeadSha })}\nFailed exact-head checks: ${JSON.stringify(failedChecks)}\nRequired checks: ${JSON.stringify(input.requiredChecks)}\nPinned local verification: ${JSON.stringify(input.localVerification)}\nThe evidenceArtifactId for every failed check is exactly: ${input.evidenceArtifactId}`;
  }

  private deliveryReviewPrompt(title: string, brief: string, plan: string, delivery: string, developerEvidence: string, gitEvidence: { targetBaseSha: string; subjectCommit: string; subjectTree: string; status: string; branch: string; head: string; tree: string; diff: string; commit: string; instructions: string }): string {
    return [
      'You are Forge\'s Lead reviewer continuing the existing Lead session. Review the exact local Developer delivery; do not redesign or expand the approved plan. Do not modify files, commit, run CI, use GitHub/provider commands, or treat CI as available.',
      'Return exactly one JSON object with no markdown fences or commentary matching: {"kind":"delivery_review","summary":"...","outcome":"approved|blocking","findings":[{"findingId":"finding_...","severity":"blocking|advisory","rationale":"...","evidenceRef":"diff hunk, file, test, or report reference","disposition":"open|accepted|repaired","repairInstruction":null}],"repairPlan":null}. Blocking findings are limited to correctness, acceptance, security/privacy/data loss, compatibility, operational safety, unintended scope, or missing mandatory proof. Advisory findings never block. An approved result cannot contain an open blocking finding. A blocking result must identify each open blocking finding and provide a bounded repairPlan when repair is possible; use null only when a member decision is required. Ground every finding in the supplied exact revision and evidence.',
      `Task: ${title}\nBrief:\n${brief}`,
      `Authorized approved plan:\n${plan}`,
      `Developer delivery report:\n${delivery}`,
      `Developer verification evidence:\n${developerEvidence}`,
      `Exact Git subject (base, branch, commit, tree, clean state):\n${JSON.stringify({ targetBaseSha: gitEvidence.targetBaseSha, branch: gitEvidence.branch, subjectCommit: gitEvidence.subjectCommit, subjectTree: gitEvidence.subjectTree, observedHead: gitEvidence.head, observedTree: gitEvidence.tree, dirtyState: gitEvidence.status ? "dirty" : "clean" })}`,
      `Repository instructions:\n${gitEvidence.instructions || "(none found)"}`,
      `Exact diff from target base to subject commit:\n${gitEvidence.diff}`,
      `Subject commit details:\n${gitEvidence.commit}`,
    ].join("\n\n");
  }

  private reviewPrompt(title: string, brief: string, revision: string, draft: string, evidence: string): string {
    return `You are Forge's independent supplemental reviewer. Do not modify files, review implementation, or become the plan owner. Return exactly one JSON object: {"kind":"review","summary":"...","opinion":"approve"|"request_changes","concerns":[],"requiredChanges":[]}. Read the complete draft and scoped evidence below. Identify only concrete correctness, acceptance, security/privacy, compatibility, operational, or unintended-scope concerns.\n\nTask: ${title}\nBrief:\n${brief}\n\nPinned Project revision:\n${revision}\n\nDraft Lead plan:\n${draft}\n\nLead evidence:\n${evidence}`;
  }

  private consolidationPrompt(draft: string, review: string): string {
    return `Reconsider the complete Lead plan in this same session after an independent supplemental review. Return exactly one consolidated JSON plan or one decision_blocker matching the required schema. Preserve correct steps, address concrete review concerns, and do not leave unresolved technical questions. Do not include markdown fences or commentary.\n\nDraft plan:\n${draft}\n\nSupplemental review:\n${review}`;
  }

  private async consolidationRepositoryPath(input: ConsolidateLeadPlanActivityInput): Promise<string> {
    const row = this.database.authQuery((db) => db.prepare("SELECT r.normalized_json FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ?").get(input.taskId, input.companyId, input.projectId, input.projectRevisionId) as { normalized_json: string } | undefined);
    if (!row) throw new AgentFailure("scoped-input-missing", "Consolidation repository is unavailable");
    return taskScopedPath(this.config.repositoryRoot, await realpath(pinnedRepositoryPath(row.normalized_json)));
  }

  private async databaseHeartbeat(executionId: string, status: "running"): Promise<void> {
    this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = ?, heartbeat_at = ? WHERE id = ?").run(status, this.now().toISOString(), executionId));
  }

  private async repositoryEvidence(repositoryPath: string): Promise<string> {
    const [status, head] = await Promise.all([
      execFileAsync("git", ["status", "--short", "--branch"], { cwd: repositoryPath, timeout: 8_000, maxBuffer: 16 * 1024 }),
      execFileAsync("git", ["log", "-1", "--format=%H%n%s"], { cwd: repositoryPath, timeout: 8_000, maxBuffer: 4 * 1024 }),
    ]);
    return JSON.stringify({ status: redact(status.stdout), head: redact(head.stdout) });
  }

  private initialPrompt(title: string, brief: string, revision: string, profiles: ProfileSettings[], repositoryEvidence: string, revisionContext?: Record<string, unknown>): string {
    return `You are Forge's Lead planner. Work read-only in the provided repository. Do not modify files, reveal credentials, or invent provider facts.\n\nReturn exactly one JSON object matching one of these shapes:\n{"kind":"plan","summary":"...","reproduction":null,"rootCauseAnalysis":null,"steps":[{"number":1,"instruction":"...","verification":"..."}],"compatibilityAnalysis":"...","operationalAnalysis":"...","verificationStrategy":"...","unresolvedTechnicalQuestions":[],"materialCategories":[],"preservedWorktreeCompatibility":null}\n{"kind":"decision_blocker","summary":"...","evidence":"...","owner":"human","question":"...","nextAction":"..."}\nUse decision_blocker only for one unresolved human/business choice. A plan must have numbered prescriptive steps, compatibility and operational analysis, a complete verification strategy, zero unresolved technical questions, and a materialCategories array containing only the categories directly implicated: architecture_dependencies, schema_data_migration, security_permissions, external_integration, production_operation, user_visible_behavior. For a revised reuse request, set preservedWorktreeCompatibility to true only when the preserved coordinates remain safe for the plan; otherwise set it to false and explain why in compatibilityAnalysis. Ordinary and new-worktree plans set it to null.\n\nTask: ${title}\nBrief:\n${brief}\n\nPinned Project revision:\n${revision}\n\nRole profile settings:\n${JSON.stringify(profiles)}\n\nRepository read evidence:\n${repositoryEvidence}${revisionContext ? `\n\nRevision request:\n${JSON.stringify(revisionContext)}` : ""}`;
  }

  private correctionPrompt(): string {
    return "Your previous Lead response did not satisfy the required JSON schema. Continue the same session, do not redo discovery, and return exactly one corrected JSON object matching the plan or decision_blocker shape. Do not include markdown fences or commentary.";
  }

  private async persistEvidence(companyId: string, executionId: string, lines: string[]): Promise<StoredArtifact> {
    const content = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    return this.artifacts.put(companyId, "agent-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: content.length ? content : Buffer.from("{\"type\":\"empty\"}\n") });
  }

  private async persistOutput(input: LeadPlanningActivityInput, executionId: string, sessionRef: string, lines: string[], output: LeadOutput): Promise<{ evidence: StoredArtifact; result: LeadPlanningResult }> {
    const evidence = await this.persistEvidence(input.companyId, executionId, lines);
    const outputKind = output.kind === "plan" ? "lead-plan" : "decision-blocker";
    const outputArtifact = await this.artifacts.put(input.companyId, outputKind, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(output, null, 2), "utf8") });
    const categories = output.kind === "plan" ? classifyPlanMateriality(`${output.summary}\n${output.steps.map((step) => step.instruction).join("\n")}`, output.materialCategories) : [];
    const summary = output.kind === "plan" ? `${output.summary} (${materialitySummary(categories)})` : output.summary;
    this.database.authTransaction((db) => {
      db.prepare(`INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt,
        outputArtifact.id, outputArtifact.companyId, outputArtifact.kind, outputArtifact.filename, outputArtifact.mimeType, outputArtifact.byteSize, outputArtifact.sha256, outputArtifact.storagePath, outputArtifact.createdAt,
      );
      db.prepare(`INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`output_${randomBytes(12).toString("hex")}`, input.taskId, input.companyId, input.workflowId, executionId, input.revision, output.kind, outputArtifact.id, evidence.id, sessionRef, summary, this.now().toISOString());
    });
    return { evidence, result: { leadSessionRef: sessionRef, leadExecutionId: executionId, leadEvidenceArtifactId: evidence.id, leadOutputArtifactId: outputArtifact.id, leadOutputKind: output.kind, leadSummary: summary, materialCategories: categories, material: categories.length > 0, preservedWorktreeCompatibility: output.kind === "plan" ? output.preservedWorktreeCompatibility : null } };
  }
}

export function hashLeadOutput(output: LeadOutput): string {
  return createHash("sha256").update(JSON.stringify(output)).digest("hex");
}

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { ForgeConfig } from "./config.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { AgentFailure } from "./agent-failure.js";
import { resolveAgentProvider } from "./agent-providers/index.js";
import type { AgentProvider, AgentTurnWrapperRequest, LeadProcessResult, LeadProcessRunner, PreparedAgentTurnWrapper } from "./agent-providers/provider.js";
import { DecisionBlockerSchema, LeadOutputSchema, LeadPlanningActivityInputSchema, PersistedLeadOutputSchema, type LeadOutput, type LeadPlanningActivityInput, type LeadPlanningResult } from "./lead-contracts.js";
import { CodexLeadOutputJsonSchema } from "./lead-contracts.js";
import type { SessionStore } from "./session-store.js";
import { ForgeDatabase } from "./database.js";
import { CapacityManager } from "./capacity.js";
import { redact } from "./logging.js";
import { cleanupAgentWrapper } from "./agent-wrapper.js";
import { classifyPlanMateriality, materialitySummary } from "./plan-governance.js";
import { CiRepairPlanSchema, DeliveryRepairPlanInputSchema, DeliveryRepairPlanResultSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, MergeConflictPlanSchema, type CiRepairPlanActivityInput, type CiRepairPlanActivityResult, type DeliveryFinding, type DeliveryRepairPlanActivityInput, type DeliveryRepairPlanResult, type DeliveryReview, type DeliveryReviewActivityInput, type DeliveryReviewActivityResult, type ConsolidateLeadPlanActivityInput, type MergeConflictPlanActivityInput, type MergeConflictPlanActivityResult, type SupplementalReviewActivityInput, type SupplementalReviewResult } from "./temporal/issue-contracts.js";
import { ForwardMergeConflictArtifactSchema, type ForwardMergeConflictArtifact } from "./forward-merge.js";
import { parseAcceptedProjectRevision } from "./projects.js";
import { PlanGovernanceRepository } from "./plan-governance-repository.js";
import { defaultProcessController, type ProcessController, type ProcessInspection } from "./process-manager.js";

const execFileAsync = promisify(execFile);
const LEAD_OUTPUT_IDLE_TIMEOUT_MS = 5 * 60_000;

type MergeConflictPlanInput = MergeConflictPlanActivityInput;

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const LeadReviewResponseSchema = z.object({
  version: z.literal(1),
  originalPlanRevision: z.number().int().nonnegative(),
  reviewArtifactId: durableId,
  reviewResponse: z.string().min(1).max(20_000),
  result: LeadOutputSchema,
}).strict();
export { AskUserQuestionSchema, DecisionBlockerSchema, LeadOutputSchema, LeadPlanSchema, LeadPlanningActivityInputSchema, PersistedLeadOutputSchema, type AskUserQuestion, type PersistedLeadOutput } from "./lead-contracts.js";
export type { DecisionBlocker, LeadOutput, LeadPlan, LeadPlanningActivityInput, LeadPlanningResult, LegacyLeadPlanningResult } from "./lead-contracts.js";
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
export type SupplementalReview = z.infer<typeof SupplementalReviewSchema>;

export type { LeadInvocation, LeadProcessResult, LeadProcessRunner } from "./agent-providers/provider.js";

export function resolveAgentCommand(command: string, executablePath = process.env.PATH ?? ""): string {
  return resolveAgentProvider().resolveCommand(command, executablePath);
}
export { AgentFailure } from "./agent-failure.js";
export { FileSessionStore } from "./session-store.js";
export type { SessionStore } from "./session-store.js";
export { runCodexProcess } from "./agent-providers/codex.js";

export function parseLeadOutput(lines: string[], provider: AgentProvider = resolveAgentProvider()): LeadOutput {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-output", "Codex did not return a Lead result");
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new AgentFailure("malformed-output", "Codex returned malformed Lead JSON");
  }
  const providerObject = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  if (providerObject?.kind === "plan") {
    const developerContext = providerObject.developerContext;
    if (developerContext && typeof developerContext === "object" && !Array.isArray(developerContext)) {
      const context = developerContext as Record<string, unknown>;
      if (Array.isArray(context.artifactStepNumbers)) {
        const mappings = new Map<string, unknown>();
        let validShape = true;
        for (const entry of context.artifactStepNumbers) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) { validShape = false; break; }
          const mapping = entry as Record<string, unknown>;
          if (typeof mapping.artifactIdOrPath !== "string" || mappings.has(mapping.artifactIdOrPath)) { validShape = false; break; }
          mappings.set(mapping.artifactIdOrPath, mapping.stepNumbers);
        }
        if (validShape) providerObject.developerContext = { ...context, artifactStepNumbers: Object.fromEntries(mappings) };
      }
    }
    if (Array.isArray(providerObject.affectedPaths) && Array.isArray(providerObject.materiality)) {
      const affectedPaths = new Set(providerObject.affectedPaths);
      for (const entry of providerObject.materiality) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const evidence = entry as Record<string, unknown>;
        if (Array.isArray(evidence.evidenceRefs)) evidence.evidenceRefs = evidence.evidenceRefs.map((ref) => typeof ref === "string" && affectedPaths.has(ref) ? `path:${ref}` : ref);
      }
    }
  }
  // The provider-compatible closed schema requires inactive discriminated
  // fields to be present even when the discriminator makes them inactive.
  // Remove that declared inactive set before canonical Zod validation, which
  // still rejects every omitted or malformed active field and every unknown key.
  const inactiveKeys = providerObject?.kind === "plan"
    ? new Set(["category", "evidence", "owner", "askUserQuestion", "nextAction", "resumePhase"])
    : providerObject?.kind === "decision_blocker"
      ? new Set(["gitPresentation", "reproduction", "rootCauseAnalysis", "steps", "compatibilityAnalysis", "operationalAnalysis", "verificationStrategy", "unresolvedTechnicalQuestions", "materialCategories", "preservedWorktreeCompatibility", "affectedPaths", "materiality", "developerContext"])
      : undefined;
  const canonicalInput = providerObject ? Object.fromEntries(Object.entries(providerObject).filter(([key]) => !inactiveKeys?.has(key))) : parsed;
  const result = LeadOutputSchema.safeParse(canonicalInput);
  if (!result.success) throw new AgentFailure("invalid-output-schema", "Codex returned a Lead result that does not satisfy the required schema");
  return result.data;
}

function parseLeadReviewResponse(lines: string[], provider: AgentProvider): z.infer<typeof LeadReviewResponseSchema> {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-review-response", "Codex did not return a Lead supplemental-review response");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-review-response", "Codex returned malformed Lead supplemental-review response JSON"); }
  const result = LeadReviewResponseSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-review-response", "Codex returned a Lead supplemental-review response outside the required schema");
  return result.data;
}

function parseSupplementalReview(lines: string[], provider: AgentProvider): SupplementalReview {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-output", "Supplemental review did not return an opinion");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-output", "Supplemental review returned malformed JSON"); }
  const result = SupplementalReviewSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-output-schema", "Supplemental review did not satisfy the required schema");
  return result.data;
}

function parseDeliveryReview(lines: string[], provider: AgentProvider): DeliveryReview {
  const text = provider.agentMessages(lines).at(-1);
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

function parseDeliveryRepairPlan(lines: string[], provider: AgentProvider): z.infer<typeof DeliveryRepairLeadOutputSchema> {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-repair-plan-output", "Codex Lead did not return a delivery repair plan");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-repair-plan-output", "Codex Lead returned malformed delivery repair plan JSON"); }
  const result = DeliveryRepairLeadOutputSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-repair-plan-output", "Codex Lead returned a delivery repair plan outside the required schema");
  return result.data;
}

export function parseMergeConflictPlan(lines: string[], provider: Pick<AgentProvider, "agentMessages">, conflictFiles: string[]): import("./temporal/issue-contracts.js").MergeConflictPlan {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-merge-conflict-plan", "Codex Lead did not return a merge-conflict plan");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-merge-conflict-plan", "Codex Lead returned malformed merge-conflict plan JSON"); }
  const result = MergeConflictPlanSchema.safeParse(parsed);
  if (result.success) return result.data;
  const blockerInput = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([key]) => !new Set(["gitPresentation", "reproduction", "rootCauseAnalysis", "steps", "compatibilityAnalysis", "operationalAnalysis", "verificationStrategy", "unresolvedTechnicalQuestions", "materialCategories", "preservedWorktreeCompatibility", "affectedPaths", "materiality", "developerContext"]).has(key)))
    : parsed;
  const blocker = DecisionBlockerSchema.safeParse(blockerInput);
  const recommendation = blocker.success ? blocker.data.askUserQuestion.options[0] : undefined;
  if (blocker.success && conflictFiles.length === 1 && recommendation?.label.endsWith(" (Recommended)")) {
    // A one-file, explicitly recommended resolution is actionable; preserve it
    // as the required plan instead of stopping the workflow on its old envelope.
    return MergeConflictPlanSchema.parse({
      kind: "merge_conflict_plan",
      summary: blocker.data.summary,
      resolutions: [{
        number: 1,
        file: conflictFiles[0],
        resolution: blocker.data.nextAction,
        intendedResult: blocker.data.summary,
        issueInvariant: blocker.data.evidence,
        baseInvariant: blocker.data.evidence,
        compatibilityConcern: recommendation.description,
      }],
      verificationStrategy: "Run the complete local verification suite after creating the merge commit.",
      unresolvedQuestions: [],
    });
  }
  throw new AgentFailure("invalid-merge-conflict-plan", "Codex Lead returned a merge-conflict plan outside the required schema");
}

function parseCiRepairPlan(lines: string[], provider: AgentProvider): import("./temporal/issue-contracts.js").CiRepairPlan {
  const text = provider.agentMessages(lines).at(-1);
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

function promptExcerpt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const tail = Math.min(4_000, Math.floor(limit / 5));
  return `${value.slice(0, limit - tail)}\n[truncated ${value.length - limit} characters]\n${value.slice(-tail)}`;
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
  return resolveAgentProvider().classifyProcessFailure(result, outputLines, model);
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
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") throw new AgentFailure("unsafe-working-directory", "Lead working directory is outside the configured repository root", { nonRetryable: true });
  return absoluteCandidate;
}

async function processStartIdentity(pid: number, fallback: string): Promise<string> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { maxBuffer: 4 * 1024 });
    const value = result.stdout.trim();
    return value ? `${pid}:${value}` : `${pid}:${fallback}`;
  } catch {
    return `${pid}:${fallback}`;
  }
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

interface ActiveLeadExecution {
  id: string;
  status: string;
  attempt: number;
  session_ref: string | null;
  heartbeat_at: string | null;
  wrapper_pid: number | null;
  wrapper_process_group: number | null;
  wrapper_start_identity: string | null;
  process_pid: number | null;
  process_start_identity: string | null;
  spool_relative_path: string | null;
  status_relative_path: string | null;
  resolved_model: string | null;
  resolved_reasoning_level: string | null;
  resolved_service_priority: string | null;
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
  id: string;
  storage_path: string;
  sha256: string;
  filename: string;
  mime_type: string;
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
  developerEvidenceArtifactId: string;
}

export interface AgentServiceOptions {
  command?: string;
  provider?: AgentProvider;
  processRunner?: LeadProcessRunner;
  sessionStore?: SessionStore;
  processController?: ProcessController;
  now?: () => Date;
  leadOutputIdleTimeoutMs?: number;
}

export class AgentService {
  private readonly artifacts: ArtifactStore;
  private readonly provider: AgentProvider;
  private readonly command: string;
  private readonly processRunner: LeadProcessRunner;
  private readonly sessionStore: SessionStore;
  private readonly processController: ProcessController;
  private readonly now: () => Date;
  private readonly leadOutputIdleTimeoutMs: number;

  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig, options: AgentServiceOptions = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot);
    this.provider = options.provider ?? resolveAgentProvider();
    this.command = this.provider.resolveCommand(options.command);
    this.processRunner = options.processRunner ?? this.provider.processRunner;
    this.sessionStore = options.sessionStore ?? this.provider.createSessionStore(config.runtimeRoot);
    this.processController = options.processController ?? defaultProcessController;
    this.now = options.now ?? (() => new Date());
    this.leadOutputIdleTimeoutMs = options.leadOutputIdleTimeoutMs ?? LEAD_OUTPUT_IDLE_TIMEOUT_MS;
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
    const profile = this.executionProfile(input, undefined);
    if (profile && profile.provider !== this.provider.id) throw new AgentFailure("profile-unavailable", "Lead profile is unavailable for delivery repair planning");
    const active = this.activeCapacityExecution(input, "planner");
    const executionId = active?.id ?? `agent_${randomBytes(12).toString("hex")}`;
    const evidenceLines: string[] = [];
    const outputLines: string[] = [];
    const startedAt = this.now().toISOString();
    if (!active) this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'planner', 'starting', 1, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.leadSessionRef, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, input.leadSessionRef, worktreePath);
    });
    let output: z.infer<typeof DeliveryRepairLeadOutputSchema>;
    try {
      const result = await this.processRunner({ command: this.command, args: this.provider.buildTurnArgs({ prompt: this.deliveryRepairPlanPrompt(input, openFindings), resumeSessionId: rawSessionId, profile }), cwd: worktreePath, durable: { runtimeRoot: this.config.runtimeRoot, executionId }, onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_group_id = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); }, onLine: async (line) => { evidenceLines.push(this.provider.sanitizeLine(line)); outputLines.push(line); await this.databaseHeartbeat(executionId, "running"); } });
      if (result.exitCode !== 0) throw this.provider.classifyProcessFailure(result, outputLines, "delivery-repair-plan");
      output = parseDeliveryRepairPlan(outputLines, this.provider);
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("repair-plan-failed", "Codex Lead delivery repair planning failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      this.database.authTransaction((db) => { db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt); db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId); });
      await this.cleanupTerminalWrapper(executionId);
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
    await this.cleanupTerminalWrapper(executionId);
    return DeliveryRepairPlanResultSchema.parse({ planId, leadExecutionId: executionId, planArtifactId: planArtifact.id, planSha256: planArtifact.sha256, evidenceArtifactId: evidenceArtifact.id, leadSessionRef: input.leadSessionRef, summary, findings: openFindings });
  }

  private bindCapacityInTransaction(db: import("better-sqlite3").Database, input: { capacityRequestId?: string | undefined }, executionId: string, sessionRef?: string, worktreePath?: string): void {
    if (!input.capacityRequestId) return;
    const request = new CapacityManager(this.database, this.config).bindExecutionInTransaction(db, input.capacityRequestId, { executionKind: "agent", executionId, ...(sessionRef ? { sessionRef } : {}), ...(worktreePath ? { worktreePath } : {}) });
    db.prepare("UPDATE forge_agent_executions SET capacity_request_id = ?, profile_id = ?, provider = ?, model = ?, reasoning_level = ?, service_priority = ?, wrapper_id = COALESCE(wrapper_id, ?), wrapper_path = COALESCE(wrapper_path, ?) WHERE id = ?").run(request.id, request.profileId, request.provider, request.model, request.reasoningLevel, request.servicePriority, `wrapper_${request.id}`, join(this.config.runtimeRoot, "agent-executions", executionId), executionId);
  }

  private executionProfile(input: { capacityRequestId?: string | undefined }, profileId: string | undefined): ProfileSettings | undefined {
    if (input.capacityRequestId) return this.database.authQuery((db) => db.prepare("SELECT profile_id AS id, profile_id AS name, model, provider, reasoning_level AS reasoningLevel, service_priority AS servicePriority, requested_capacity AS capacity FROM forge_capacity_requests WHERE id = ?").get(input.capacityRequestId) as ProfileSettings | undefined);
    if (!profileId) return undefined;
    return this.database.authQuery((db) => db.prepare("SELECT id, name, model, provider, reasoning_level AS reasoningLevel, service_priority AS servicePriority, capacity FROM forge_profiles WHERE id = ?").get(profileId) as ProfileSettings | undefined);
  }

  private activeCapacityExecution(input: { capacityRequestId?: string | undefined; taskId: string; companyId: string; workflowId: string }, role: "planner" | "reviewer" | "integrator"): { id: string; sessionRef: string | null } | undefined {
    if (!input.capacityRequestId) return undefined;
    return this.database.authQuery((db) => db.prepare(`SELECT id, session_ref AS sessionRef
      FROM forge_agent_executions
      WHERE capacity_request_id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND role = ?
        AND status IN ('starting', 'running')
      ORDER BY started_at DESC LIMIT 1`).get(input.capacityRequestId, input.taskId, input.companyId, input.workflowId, role) as { id: string; sessionRef: string | null } | undefined);
  }

  private async cleanupTerminalWrapper(executionId: string): Promise<void> {
    const terminal = this.database.authQuery((db) => db.prepare("SELECT 1 FROM forge_agent_executions WHERE id = ? AND status NOT IN ('starting', 'running', 'cancelling')").get(executionId));
    if (terminal) await cleanupAgentWrapper(this.config.runtimeRoot, executionId).catch(() => undefined);
  }

  async runLeadPlanning(rawInput: LeadPlanningActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<LeadPlanningResult> {
    const input = LeadPlanningActivityInputSchema.parse(rawInput);
    const row = this.database.authQuery((db) => db.prepare(`SELECT t.title, r.normalized_json, b.storage_path AS brief_storage_path, b.sha256 AS brief_sha256
      FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ? AND t.project_revision_id = ? AND b.id = ?`).get(input.taskId, input.companyId, input.projectId, input.workflowId, input.projectRevisionId, input.briefArtifactId) as PlanningRow | undefined);
    if (!row) throw new AgentFailure("scoped-input-missing", "Lead planning evidence is unavailable");
    const completed = await this.completedPlanningResult(input);
    if (completed) return completed;
    const active = this.database.authQuery((db) => db.prepare("SELECT id, status, attempt, session_ref, heartbeat_at, wrapper_pid, wrapper_process_group, wrapper_start_identity, process_pid, process_start_identity, spool_relative_path, status_relative_path, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority FROM forge_agent_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND role = 'planner' AND turn_key = ? AND status IN ('starting', 'running', 'cancelling', 'failed') ORDER BY started_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, `${input.workflowId}:lead-planning:${input.revision}`) as (ActiveLeadExecution & { profile_id: string | null }) | undefined);
    const turnSupervisor = this.provider.createTurnSupervisor(this.processController);
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(pinnedRepositoryPath(row.normalized_json)));
    const brief = (await this.artifacts.read({ companyId: input.companyId, storagePath: row.brief_storage_path, sha256: row.brief_sha256 })).toString("utf8");
    const revisionNote = input.revisionNoteArtifactId
      ? this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'plan-decision'").get(input.revisionNoteArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined)
      : undefined;
    if (input.revisionNoteArtifactId && !revisionNote) throw new AgentFailure("scoped-input-missing", "The member revision note is unavailable");
    const memberResponse = input.memberResponseArtifactId
      ? this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'plan-blocker-response'").get(input.memberResponseArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined)
      : undefined;
    if (input.memberResponseArtifactId && !memberResponse) throw new AgentFailure("scoped-input-missing", "The member blocker response is unavailable");
    const revisionNoteText = revisionNote ? (await this.artifacts.read({ companyId: input.companyId, storagePath: revisionNote.storagePath, sha256: revisionNote.sha256 })).toString("utf8") : undefined;
    const memberResponseText = memberResponse ? (await this.artifacts.read({ companyId: input.companyId, storagePath: memberResponse.storagePath, sha256: memberResponse.sha256 })).toString("utf8") : undefined;
    const images = this.database.authQuery((db) => {
      if (!input.imageArtifactIds.length) return [] as ImageRow[];
      const placeholders = input.imageArtifactIds.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, storage_path, sha256, filename, mime_type FROM forge_artifacts WHERE company_id = ? AND kind = 'task-image' AND id IN (${placeholders})`).all(input.companyId, ...input.imageArtifactIds) as Array<ImageRow & { id: string }>;
      const byId = new Map(rows.map((row) => [row.id, row]));
      return input.imageArtifactIds.flatMap((imageId) => { const row = byId.get(imageId); return row ? [row] : []; });
    });
    if (images.length !== input.imageArtifactIds.length) throw new AgentFailure("scoped-input-missing", "Lead image evidence is unavailable");
    for (const image of images) await this.artifacts.read({ companyId: input.companyId, storagePath: image.storage_path, sha256: image.sha256 });
    const profileSettings = this.database.authQuery((db) => {
      const profileIds = Object.values(input.roleProfiles).filter((value): value is string => typeof value === "string");
      if (!profileIds.length) return [] as ProfileSettings[];
      const placeholders = profileIds.map(() => "?").join(",");
      return db.prepare(`SELECT id, name, provider, model, reasoning_level AS reasoningLevel, service_priority AS servicePriority, capacity FROM forge_profiles WHERE id IN (${placeholders})`).all(...profileIds) as ProfileSettings[];
    });
    const pinnedLead = this.executionProfile(input, input.roleProfiles.planner);
    if (pinnedLead) {
      const index = profileSettings.findIndex((profile) => profile.id === input.roleProfiles.planner);
      const existing = index >= 0 ? profileSettings[index] : undefined;
      if (existing) profileSettings[index] = { ...existing, model: pinnedLead.model, provider: pinnedLead.provider, reasoningLevel: pinnedLead.reasoningLevel, servicePriority: pinnedLead.servicePriority, capacity: pinnedLead.capacity };
    }
    if (!input.roleProfiles.planner) throw new AgentFailure("profile-unavailable", "Lead planning requires a configured Lead profile");
    const resumeSessionRef = input.resume?.leadSessionRef ?? input.leadSessionRef ?? input.resumeLeadSessionRef;
    const pinned = resumeSessionRef ? this.database.authQuery((db) => db.prepare("SELECT profile_id AS profileId, resolved_model AS model, resolved_reasoning_level AS reasoningLevel, resolved_service_priority AS servicePriority FROM forge_agent_executions WHERE session_ref = ? AND company_id = ? AND role = 'planner' AND resolved_model IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(resumeSessionRef, input.companyId) as { profileId: string | null; model: string; reasoningLevel: string; servicePriority: string } | undefined) : undefined;
    const persisted = pinned ?? (active?.resolved_model && active.resolved_reasoning_level && active.resolved_service_priority ? { profileId: active.profile_id, model: active.resolved_model, reasoningLevel: active.resolved_reasoning_level, servicePriority: active.resolved_service_priority } : undefined);
    let leadProfile = persisted
      ? { id: persisted.profileId ?? input.roleProfiles.planner ?? "pinned-lead", name: "Pinned Lead", provider: this.provider.id, model: persisted.model, reasoningLevel: persisted.reasoningLevel, servicePriority: persisted.servicePriority, capacity: 0 }
      : profileSettings.find((profile) => profile.id === input.roleProfiles.planner);
    if (!leadProfile || leadProfile.provider !== this.provider.id) throw new AgentFailure("profile-unavailable", "The configured Lead profile is unavailable");
    const revisionRequest = input.revisionRequestId ? this.database.authQuery((db) => db.prepare(`SELECT r.disposition, r.worktree_path AS worktreePath, r.branch_name AS branchName, r.base_sha AS baseSha, r.head_sha AS headSha, r.tree_sha AS treeSha, r.exact_base_sha AS exactBaseSha, a.storage_path AS reasonPath, a.sha256 AS reasonSha
      FROM forge_plan_revision_requests r JOIN forge_artifacts a ON a.id = r.reason_artifact_id AND a.company_id = r.company_id AND a.kind = 'plan-revision-reason'
      WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ?`).get(input.revisionRequestId, input.taskId, input.companyId, input.workflowId) as { disposition: "reuse" | "new"; worktreePath: string | null; branchName: string | null; baseSha: string | null; headSha: string | null; treeSha: string | null; exactBaseSha: string | null; reasonPath: string; reasonSha: string } | undefined) : undefined;
    if (input.revisionRequestId && !revisionRequest) throw new AgentFailure("revision-request-missing", "The plan revision request is unavailable");
    const revisionContext = revisionRequest ? { ...revisionRequest, reason: (await this.artifacts.read({ companyId: input.companyId, storagePath: revisionRequest.reasonPath, sha256: revisionRequest.reasonSha })).toString("utf8") } : undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(leadProfile.model) || !["low", "medium", "high", "xhigh"].includes(leadProfile.reasoningLevel) || !["standard", "priority", "fast"].includes(leadProfile.servicePriority)) {
      throw new AgentFailure("scope_configuration", "The configured Lead profile has invalid turn settings", { nonRetryable: true });
    }
    await this.assertTurnCompatibility(leadProfile);
    const repositoryEvidence = await this.repositoryEvidence(repositoryPath);
    const repositoryEvidenceArtifact = await this.artifacts.put(input.companyId, "repository-evidence", { filename: `${input.taskId}-${input.revision}.json`, mimeType: "application/json", bytes: Buffer.from(repositoryEvidence, "utf8") });
    const planningManifest = {
      version: 1,
      companyId: input.companyId,
      issueId: input.taskId,
      workflowId: input.workflowId,
      projectId: input.projectId,
      taskBrief: { artifactId: input.briefArtifactId, sha256: row.brief_sha256 },
      taskImages: images.map((image) => ({ artifactId: image.id, sha256: image.sha256, mimeType: "image/*", filename: image.filename })),
      projectRevision: { id: input.projectRevisionId, identity: row.normalized_json, baseSha: JSON.parse(row.normalized_json).baseSha ?? "", targetSha: JSON.parse(row.normalized_json).targetSha ?? "" },
      profiles: { lead: leadProfile, reviewer: input.roleProfiles.reviewer ? profileSettings.find((profile) => profile.id === input.roleProfiles.reviewer) ?? null : null },
      repositoryEvidence: { artifactId: repositoryEvidenceArtifact.id, sha256: repositoryEvidenceArtifact.sha256 },
    };
    const manifestArtifact = await this.artifacts.put(input.companyId, "planning-evidence-manifest", { filename: `${input.taskId}-${input.revision}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(planningManifest), "utf8") });
    this.database.authTransaction((db) => {
      for (const artifact of [repositoryEvidenceArtifact, manifestArtifact]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    });
    let executionId = `agent_${randomBytes(12).toString("hex")}`;
    let sessionRef: string | undefined = resumeSessionRef;
    let rawSessionId: string | undefined = resumeSessionRef ? await this.sessionStore.read(resumeSessionRef) : undefined;
    let resumeInstruction = "";
    if (input.resume) {
      const instruction = this.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.resume!.instructionArtifactId, input.companyId) as { storage_path: string; sha256: string } | undefined);
      if (!instruction) throw new AgentFailure("scoped-input-missing", "The Lead resume instruction is unavailable");
      resumeInstruction = (await this.artifacts.read({ companyId: input.companyId, storagePath: instruction.storage_path, sha256: instruction.sha256 })).toString("utf8");
    }
    const startedAt = this.now().toISOString();
    if (!sessionRef && !rawSessionId && this.sessionStore.reserve) sessionRef = await this.sessionStore.reserve();
    try {
      if (active) {
        if (active.status !== "failed") {
          try {
            const storedStatus = JSON.parse(await readFile(this.runtimePath(active.status_relative_path), "utf8")) as { state?: string };
            if (storedStatus.state === "completed") return this.attachPlanningResult(input, active, runtime.signal);
          } catch (error) {
            if (error instanceof AgentFailure) throw error;
          }
          const wrapper = active.wrapper_pid && active.wrapper_process_group && active.wrapper_start_identity ? await this.processController.inspect(active.wrapper_pid) : undefined;
          const wrapperAlive = Boolean(wrapper && wrapper.processGroup === active.wrapper_process_group && `${active.wrapper_pid}:${wrapper.startTime}` === active.wrapper_start_identity);
          const child = active.process_pid ? await this.processController.inspect(active.process_pid) : undefined;
          const childAlive = Boolean(child && active.process_start_identity && `${active.process_pid}:${child.startTime}` === active.process_start_identity && child.processGroup === active.wrapper_process_group);
          const groupAlive = active.wrapper_process_group ? await this.processController.isProcessGroupAlive?.(active.wrapper_process_group) : false;
          if (wrapperAlive) return this.attachPlanningResult(input, active, runtime.signal, wrapper);
          if (childAlive && child) {
            const childOwnership = { name: "codex-child", pid: child.pid, command: child.command, startedAt, processGroup: child.processGroup, startTime: child.startTime, executable: child.executable, argv: child.argv };
            if (!await turnSupervisor.cancelOwnedProcess(childOwnership, child)) throw new AgentFailure("ownership_ambiguous", "The stale Lead child process could not be safely terminated");
          } else if (groupAlive) {
            throw new AgentFailure("ownership_ambiguous", "The stale Lead process group could not be safely identified");
          }
          if (!active.wrapper_pid || !active.wrapper_process_group || !active.wrapper_start_identity) throw new AgentFailure("ownership_ambiguous", "The stale Lead execution has incomplete process ownership or pinned settings");
        }
        if (!active.resolved_model || !active.resolved_reasoning_level || !active.resolved_service_priority) throw new AgentFailure("ownership_ambiguous", "The Lead execution has incomplete pinned settings");
        executionId = active.id;
        sessionRef = active.session_ref ?? undefined;
        rawSessionId = sessionRef ? await this.sessionStore.read(sessionRef) : undefined;
        leadProfile.model = active.resolved_model;
        leadProfile.reasoningLevel = active.resolved_reasoning_level;
        leadProfile.servicePriority = active.resolved_service_priority;
        const claim = this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'starting', attempt = ?, heartbeat_at = ?, finished_at = NULL, failure_code = NULL, failure_summary = NULL, cancellation_requested_at = NULL, cancelled_at = NULL WHERE id = ? AND status = ?").run(active.attempt + 1, startedAt, executionId, active.status));
        if (claim.changes !== 1) {
          const latest = this.database.authQuery((db) => db.prepare("SELECT status FROM forge_agent_executions WHERE id = ?").get(executionId) as { status: string } | undefined);
          if (latest?.status === "ownership_ambiguous") throw new AgentFailure("ownership_ambiguous", "Restart reconciliation could not prove ownership of the Lead execution");
          throw new AgentFailure("active-lease", "A Lead execution is already active for this issue");
        }
      } else {
        this.database.authTransaction((db) => {
          db.prepare(`INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at, event_offset) VALUES (?, ?, ?, ?, 'planner', 'starting', 1, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, 0)`).run(executionId, input.taskId, input.companyId, input.workflowId, `${input.workflowId}:lead-planning:${input.revision}`, input.revision, leadProfile.id, leadProfile.model, leadProfile.reasoningLevel, leadProfile.servicePriority, sessionRef ?? null, startedAt);
          this.bindCapacityInTransaction(db, input, executionId, sessionRef);
        });
      }
    } catch (error) {
      if (error instanceof AgentFailure) throw error;
      if (error instanceof Error && /forge_agent_active_lease_idx|UNIQUE constraint/i.test(error.message)) throw new AgentFailure("active-lease", "A Lead execution is already active for this issue");
      throw error;
    }

    if (input.capacityRequestId && sessionRef) {
      this.database.authTransaction((db) => this.bindCapacityInTransaction(db, input, executionId, sessionRef));
    }

    const evidenceLines: string[] = [];
    let evidenceBytes = 0;
    let lastFailure: AgentFailure | undefined;
    const schemaRoot = join(this.config.runtimeRoot, "agent-turns", executionId);
    const schemaPath = join(schemaRoot, "lead-output.schema.json");
    await mkdir(schemaRoot, { recursive: true, mode: 0o700 });
    await writeFile(schemaPath, JSON.stringify(CodexLeadOutputJsonSchema), { encoding: "utf8", mode: 0o600 });
    await chmod(schemaPath, 0o600);
    const executionRepositoryEvidenceArtifact = await this.artifacts.put(input.companyId, "agent-evidence", { filename: `${executionId}-repository.json`, mimeType: "application/json", bytes: Buffer.from(repositoryEvidence, "utf8") });
    const revisionIdentity = JSON.parse(row.normalized_json) as Record<string, unknown>;
    const inputManifestArtifact = await this.artifacts.put(input.companyId, "lead-input-manifest", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ companyId: input.companyId, taskId: input.taskId, projectId: input.projectId, workflowId: input.workflowId, briefArtifactId: input.briefArtifactId, briefSha256: row.brief_sha256, imageArtifacts: input.imageArtifactIds.map((id) => { const image = images.find((candidate) => candidate.id === id); return image ? { artifactId: id, sha256: image.sha256, mimeType: image.mime_type, filename: image.filename } : { artifactId: id }; }), projectRevisionId: input.projectRevisionId, normalizedRevisionSha256: createHash("sha256").update(row.normalized_json).digest("hex"), repositoryEvidenceArtifactId: executionRepositoryEvidenceArtifact.id, repositoryEvidenceSha256: executionRepositoryEvidenceArtifact.sha256, repository: { repository: revisionIdentity.repository, baseBranch: revisionIdentity.baseBranch, targetBranch: revisionIdentity.targetBranch, baseSha: revisionIdentity.baseSha, targetSha: revisionIdentity.targetSha }, leadProfile: { id: leadProfile.id, provider: leadProfile.provider, model: leadProfile.model, reasoningLevel: leadProfile.reasoningLevel, servicePriority: leadProfile.servicePriority }, ...(sessionRef ? { leadSessionRef: sessionRef } : {}), ...(input.resume ? { instructionArtifactId: input.resume.instructionArtifactId, instructionSha256: input.resume.instructionSha256, resumeReason: input.resume.reason } : {}) }, null, 2), "utf8") });
    this.database.authTransaction((db) => {
      for (const artifact of [executionRepositoryEvidenceArtifact, inputManifestArtifact]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("UPDATE forge_agent_executions SET session_ref = ? WHERE id = ?").run(sessionRef ?? null, executionId);
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt = attempt === 0
          ? `${revisionNoteText ? this.revisionPrompt(revisionNoteText) : memberResponseText ? this.revisionPrompt(`Human blocker answer:\n${memberResponseText}`) : `${this.initialPrompt(row.title, brief, row.normalized_json, profileSettings, repositoryEvidence, revisionContext)}\n\nPlan only work that can be completed and verified inside an isolated git worktree. Do not add steps for deployment, rollout, physical device checks or production verification — mention them in a 'Follow-up outside Forge' note instead.`}${resumeInstruction ? `\n\nMember instruction for this ${input.resume?.reason ?? "revision"}:\n${resumeInstruction}` : ""}`
          : this.correctionPrompt();
        const imagePaths = images.map((image) => resolve(this.config.artifactRoot, image.storage_path));
        const wrapper = await this.prepareTurnWrapper(executionId, { model: leadProfile.model, reasoningLevel: leadProfile.reasoningLevel as "low" | "medium" | "high" | "xhigh", servicePriority: leadProfile.servicePriority as "standard" | "priority" | "fast" }, repositoryPath, schemaPath, prompt, { ...(rawSessionId && sessionRef ? { resumeSessionRef: sessionRef } : {}), ...(sessionRef ? { sessionRef } : {}), ...(!rawSessionId && imagePaths.length ? { imagePaths } : {}) });
        const lines: string[] = [];
        await this.databaseHeartbeat(executionId, "running");
        const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 2_000);
        const stopCancellationTracking = this.trackCancellation(executionId, runtime.signal);
        const outputController = new AbortController();
        let providerSilent = false;
        let lastOutputAt = Date.now();
        const abortForRuntimeCancellation = () => outputController.abort();
        runtime.signal?.addEventListener("abort", abortForRuntimeCancellation, { once: true });
        const outputWatchdog = setInterval(() => {
          if (Date.now() - lastOutputAt >= this.leadOutputIdleTimeoutMs) {
            providerSilent = true;
            outputController.abort();
          }
        }, Math.min(1_000, Math.max(1, this.leadOutputIdleTimeoutMs)));
        let result: LeadProcessResult;
        try {
          result = await this.processRunner({
          command: wrapper.command,
          args: wrapper.args,
          cwd: repositoryPath,
          detached: true,
          signal: outputController.signal,
          onStart: async (pid, processStartedAt, inspection) => {
            await this.recordLeadProcessStart(executionId, pid, processStartedAt, inspection);
          },
          onLine: async (line) => {
            lastOutputAt = Date.now();
            await this.recordLeadChildStart(executionId, line);
            const sanitized = turnSupervisor.sanitizeLine(line);
            evidenceBytes += Buffer.byteLength(line, "utf8") + 1;
            if (evidenceBytes > 6 * 1024 * 1024) throw new AgentFailure("evidence-too-large", "Codex evidence exceeded the local artifact limit");
            evidenceLines.push(sanitized);
            lines.push(line);
            const event = this.provider.parseEvent(line);
            if (event.sessionRef) {
              try { turnSupervisor.assertSessionIdentity(sessionRef, event.sessionRef); } catch { throw new AgentFailure("session_identity_conflict", "Lead session identity changed"); }
              sessionRef = event.sessionRef;
              rawSessionId ??= await this.sessionStore.read(sessionRef);
              await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId));
            } else if (event.threadId) {
              try { turnSupervisor.assertSessionIdentity(rawSessionId, event.threadId); } catch { throw new AgentFailure("session_identity_conflict", "Lead session identity changed"); }
              rawSessionId = event.threadId;
              if (!sessionRef) sessionRef = await this.sessionStore.create(rawSessionId);
              else if (this.sessionStore.bind) await this.sessionStore.bind(sessionRef, rawSessionId);
              await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId));
            }
            await this.databaseHeartbeat(executionId, "running", evidenceLines.length);
          },
          });
        } catch (error) {
          if (providerSilent) throw new AgentFailure("provider-silent", "Codex Lead stopped producing progress and will be retried.");
          throw error;
        } finally {
          clearInterval(heartbeat);
          clearInterval(outputWatchdog);
          stopCancellationTracking();
          runtime.signal?.removeEventListener("abort", abortForRuntimeCancellation);
        }
        if (providerSilent) throw new AgentFailure("provider-silent", "Codex Lead stopped producing progress and will be retried.");
        if (result.exitCode !== 0) {
          lastFailure = this.provider.classifyProcessFailure(result, lines, leadProfile.model);
          break;
        }
        try {
          const output = parseLeadOutput(lines, this.provider);
          if (!sessionRef || !rawSessionId) throw new AgentFailure("missing-session", "Codex did not return a Lead session reference");
          const artifacts = await this.persistOutput(input, executionId, sessionRef, evidenceLines, output, { id: manifestArtifact.id, sha256: manifestArtifact.sha256 });
          await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), artifacts.evidence.id, executionId));
          Object.assign(artifacts.result, { leadInputManifestArtifactId: inputManifestArtifact.id, leadInputManifestSha256: inputManifestArtifact.sha256 });
          return artifacts.result;
        } catch (error) {
          lastFailure = error instanceof AgentFailure ? error : new AgentFailure("invalid-output", "Codex Lead output was invalid");
          if (!rawSessionId || attempt === 1) break;
          // The first child is terminal before the bounded correction turn.
        }
      }
      throw lastFailure ?? new AgentFailure("lead-failed", "Codex Lead execution failed");
    } catch (error) {
      const cancelled = runtime.signal?.aborted === true && !(error instanceof AgentFailure && error.code === "ownership_ambiguous");
      const failure = cancelled ? new AgentFailure("cancelled", "The Codex Lead turn was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("lead-failed", "Codex Lead execution failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      this.database.authQuery((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt));
      await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(cancelled ? "cancelled" : "failed", this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, cancelled ? this.now().toISOString() : null, evidence.id, executionId));
      throw failure;
    } finally {
      // Keep the sanitized spool/status pair available for retry
      // reconciliation and operational evidence. Remove only the prompt,
      // request, and schema inputs that are no longer needed.
      await Promise.all([
        rm(schemaPath, { force: true }),
        rm(join(schemaRoot, "prompt.txt"), { force: true }),
        rm(join(schemaRoot, "request.json"), { force: true }),
      ]);
      await this.cleanupTerminalWrapper(executionId);
    }
  }

  async planMergeConflict(rawInput: MergeConflictPlanActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<MergeConflictPlanActivityResult> {
    const input = rawInput;
    const executionRole = input.executionRole ?? "planner";
    const profile = this.executionProfile(input, undefined);
    if (profile && profile.provider !== this.provider.id) throw new AgentFailure("profile-unavailable", "Lead profile is unavailable for merge-conflict planning");
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
    if (!conflictRow) throw new AgentFailure("scoped-input-missing", "Forward-merge conflict evidence is unavailable");
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
    const planId = `merge_plan_${createHash("sha256").update(`${input.workflowId}:${input.priorHead}:${input.targetBaseSha}`).digest("hex").slice(0, 32)}`;
    const existingPlan = this.database.authQuery((db) => db.prepare("SELECT r.plan_artifact_id AS planArtifactId, r.plan_evidence_artifact_id AS evidenceArtifactId, r.lead_execution_id AS leadExecutionId, r.lead_session_ref AS leadSessionRef, p.storage_path AS planStoragePath, p.sha256 AS planSha256 FROM forge_merge_conflict_resolutions r JOIN forge_artifacts p ON p.id = r.plan_artifact_id WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.status = 'planned'").get(planId, input.taskId, input.companyId, input.workflowId) as { planArtifactId: string; evidenceArtifactId: string; leadExecutionId: string; leadSessionRef: string; planStoragePath: string; planSha256: string } | undefined);
    if (existingPlan) {
      const output = MergeConflictPlanSchema.parse(JSON.parse((await this.artifacts.read({ companyId: input.companyId, storagePath: existingPlan.planStoragePath, sha256: existingPlan.planSha256 })).toString("utf8")));
      return { planId, planArtifactId: existingPlan.planArtifactId, evidenceArtifactId: existingPlan.evidenceArtifactId, leadExecutionId: existingPlan.leadExecutionId, leadSessionRef: existingPlan.leadSessionRef, summary: output.summary };
    }
    const worktreePath = await taskScopedPath(this.config.worktreeRoot, input.worktreePath);
    const [brief, plan] = await Promise.all([
      this.artifacts.read({ companyId: input.companyId, storagePath: context.briefStoragePath, sha256: context.briefSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.read({ companyId: input.companyId, storagePath: context.planStoragePath, sha256: context.planSha256 }).then((bytes) => bytes.toString("utf8")),
    ]);
    const rawSessionId = await this.sessionStore.read(input.leadSessionRef);
    const leadProfile = await this.resolveTurnProfile(input.roleProfiles?.[executionRole] ?? input.roleProfiles?.planner, input.leadSessionRef, "Integrator", executionRole);
    const schemaPath = await this.ensureLeadSchema();
    const active = this.activeCapacityExecution(input, executionRole);
    const executionId = active?.id ?? `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    if (!active) this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at, event_offset) VALUES (?, ?, ?, ?, ?, 'starting', 1, ?, ?, 'merge-conflict-planning', ?, ?, ?, ?, ?, ?, 0)").run(executionId, input.taskId, input.companyId, input.workflowId, executionRole, `${input.workflowId}:merge-conflict:${input.priorHead}:${input.targetBaseSha}:${input.capacityRequestId ?? executionId}`, input.planRevision, leadProfile.id, leadProfile.model, leadProfile.reasoningLevel, leadProfile.servicePriority, input.leadSessionRef, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, input.leadSessionRef, worktreePath);
    });
    const evidenceLines: string[] = [];
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 2_000);
    const stopCancellationTracking = this.trackCancellation(executionId, runtime.signal);
    try {
      const wrapper = await this.prepareTurnWrapper(executionId, leadProfile, worktreePath, schemaPath, this.mergeConflictPlanPrompt(context.title, brief, plan, input, conflict, pinnedCommands), { ...(rawSessionId ? { resumeSessionRef: input.leadSessionRef } : {}), sessionRef: input.leadSessionRef });
      const result = await this.processRunner({
        command: wrapper.command,
        args: wrapper.args,
        cwd: worktreePath,
        detached: true,
        ...(runtime.signal ? { signal: runtime.signal } : {}),
        onStart: async (pid, processStartedAt, inspection) => { await this.recordLeadProcessStart(executionId, pid, processStartedAt, inspection); },
        onLine: async (line) => {
          await this.recordLeadChildStart(executionId, line);
          const event = this.provider.parseEvent(line);
          if (event.sessionRef && event.sessionRef !== input.leadSessionRef) throw new AgentFailure("session-identity-conflict", "Merge-conflict planning returned a different Lead session identity");
          evidenceLines.push(this.provider.sanitizeLine(line));
          await this.databaseHeartbeat(executionId, "running", evidenceLines.length);
        },
      });
      if (result.exitCode !== 0) throw this.provider.classifyProcessFailure(result, evidenceLines);
      const output = parseMergeConflictPlan(evidenceLines, this.provider, conflict.conflictFiles);
      if (output.resolutions.some((resolution) => resolution.number === undefined || !resolution.intendedResult || !resolution.issueInvariant || !resolution.baseInvariant || !resolution.compatibilityConcern) || output.resolutions.some((resolution, index) => resolution.number !== index + 1)) throw new AgentFailure("invalid-merge-conflict-plan", "The Lead conflict plan must number each resolution and state both invariants plus compatibility concerns");
      const plannedFiles = new Set(output.resolutions.map((resolution) => resolution.file));
      const missingFiles = conflict.conflictFiles.filter((file) => !plannedFiles.has(file));
      const extraFiles = output.resolutions.filter((resolution) => !conflict.conflictFiles.includes(resolution.file));
      if (missingFiles.length || extraFiles.length || plannedFiles.size !== output.resolutions.length) throw new AgentFailure("incomplete-merge-conflict-plan", "The Lead plan must cover each conflict file exactly once");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const planArtifact = await this.artifacts.put(input.companyId, "merge-conflict-plan", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(output, null, 2), "utf8") });
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, planArtifact.id, planArtifact.companyId, planArtifact.kind, planArtifact.filename, planArtifact.mimeType, planArtifact.byteSize, planArtifact.sha256, planArtifact.storagePath, planArtifact.createdAt);
        db.prepare("INSERT INTO forge_merge_conflict_resolutions (id, task_id, company_id, workflow_id, forward_merge_id, prior_head, target_base_sha, conflict_files_json, plan_artifact_id, plan_evidence_artifact_id, lead_execution_id, lead_session_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?) ON CONFLICT(workflow_id, prior_head, target_base_sha) DO UPDATE SET plan_artifact_id = excluded.plan_artifact_id, plan_evidence_artifact_id = excluded.plan_evidence_artifact_id, lead_execution_id = excluded.lead_execution_id, lead_session_ref = excluded.lead_session_ref, status = 'planned', updated_at = excluded.updated_at").run(planId, input.taskId, input.companyId, input.workflowId, input.forwardMergeId, input.priorHead, input.targetBaseSha, JSON.stringify(conflict.conflictFiles), planArtifact.id, evidence.id, executionId, input.leadSessionRef, now, now);
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(now, now, evidence.id, executionId);
      });
      return { planId, planArtifactId: planArtifact.id, evidenceArtifactId: evidence.id, leadExecutionId: executionId, leadSessionRef: input.leadSessionRef, summary: output.summary };
    } catch (error) {
      const failure = runtime.signal?.aborted && !(error instanceof AgentFailure && error.code === "ownership_ambiguous") ? new AgentFailure("cancelled", "The Codex Lead turn was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("merge-conflict-plan-failed", "Codex Lead merge-conflict planning failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const finalStatus = failure.code === "cancelled" ? "cancelled" : "failed";
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(finalStatus, this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, finalStatus === "cancelled" ? this.now().toISOString() : null, evidence.id, executionId);
      });
      throw failure;
    } finally { clearInterval(heartbeat); stopCancellationTracking(); await this.cleanupTerminalWrapper(executionId); }
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
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, failure_code, failure_summary, evidence_artifact_id) VALUES (?, ?, ?, ?, 'planner', 'blocked', 1, ?, ?, ?, ?, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.subject.leadSessionRef, startedAt, this.now().toISOString(), code, summary, evidence.id);
      db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id, lead_session_ref, developer_session_ref, status, correction_attempts, evidence_artifact_id, failure_code, failure_summary, supersedes_review_id, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', 0, ?, ?, ?, ?, ?, ?)").run(attemptId, input.taskId, input.companyId, input.workflowId, input.subject.planRevision, input.subject.targetBaseSha, input.subject.subjectCommit, input.subject.subjectTree, developerExecution.id, deliveryArtifact.id, developerEvidence.id, executionId, input.subject.leadSessionRef, input.subject.developerSessionRef, evidence.id, code, summary, input.supersedesReviewId, startedAt, this.now().toISOString());
    });
    return DeliveryReviewActivityResultSchema.parse({ outcome: "blocked", attemptId, code, summary, evidenceArtifactId: evidence.id, executionId, sessionRef: input.subject.leadSessionRef, correctionAttempts: 0, subject: input.subject });
  }

  async planCiRepair(rawInput: CiRepairPlanActivityInput): Promise<CiRepairPlanActivityResult> {
    const input = rawInput;
    const executionRole = input.executionRole ?? "planner";
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, t.role_agents_json AS roleProfiles, a.outcome, a.observed_head_sha AS observedHeadSha, a.evidence_artifact_id AS evidenceArtifactId
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
    const profile = await this.resolveTurnProfile(input.roleProfiles?.[executionRole] ?? input.roleProfiles?.planner, input.leadSessionRef, "Integrator", executionRole);
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at) VALUES (?, ?, ?, ?, ?, 'starting', 1, ?, ?, ?, ?, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, executionRole, profile.id, profile.model, profile.reasoningLevel, profile.servicePriority, input.leadSessionRef, startedAt));
    const evidenceLines: string[] = [];
    const outputLines: string[] = [];
    // Actions check-run summaries are empty; the failing job log tail recorded with the CI evidence is the real signal.
    const evidenceRow = this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.evidenceArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined);
    const failedLogs = evidenceRow ? await this.artifacts.read({ companyId: input.companyId, storagePath: evidenceRow.storagePath, sha256: evidenceRow.sha256 }).then((bytes) => (JSON.parse(bytes.toString("utf8")) as { failedCheckLogs?: Array<{ name: string; runId: string; log: string }> }).failedCheckLogs ?? []).catch(() => []) : [];
    const prompt = this.ciRepairPrompt(context.title, { ...input, requiredChecks, localVerification }, failedChecks, failedLogs);
    let plan: import("./temporal/issue-contracts.js").CiRepairPlan | undefined;
    let failure: AgentFailure | undefined;
    try {
      for (let turn = 0; turn < 2 && !plan; turn += 1) {
        const result = await this.processRunner({ command: this.command, args: this.provider.buildTurnArgs({ prompt: turn === 0 ? prompt : `${prompt}\n\nReturn one corrected schema-valid object only.`, resumeSessionId: rawSessionId, profile }), cwd: repositoryPath, onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); }, onLine: async (line) => { const event = this.provider.parseEvent(line); if (event.threadId && event.threadId !== rawSessionId) throw new AgentFailure("session-identity-conflict", "CI repair planning returned a different Lead session identity"); evidenceLines.push(this.provider.sanitizeLine(line)); outputLines.push(line); await this.databaseHeartbeat(executionId, "running"); } });
        if (result.exitCode !== 0) throw this.provider.classifyProcessFailure(result, outputLines);
        try {
          plan = parseCiRepairPlan(outputLines, this.provider);
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
      return { planId, planArtifactId: planArtifact.id, evidenceArtifactId: evidence.id, leadExecutionId: executionId, leadSessionRef: input.leadSessionRef, summary: validatedPlan.rootCause, disposition: validatedPlan.disposition };
    } catch (error) {
      const reason = error instanceof AgentFailure ? error : new AgentFailure("ci-repair-plan-failed", "CI repair planning failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      this.database.authTransaction((db) => { db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt); db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), reason.code, reason.message, evidence.id, executionId); });
      throw reason;
    }
  }

  async reviewDelivery(rawInput: DeliveryReviewActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<DeliveryReviewActivityResult> {
    const input = DeliveryReviewActivityInputSchema.parse(rawInput);
    let subject = input.subject;
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
      de.session_ref AS developerSessionRef,
      de.evidence_artifact_id AS developerEvidenceArtifactId
      FROM forge_tasks t
      JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id
      JOIN forge_issue_outputs io ON io.task_id = t.id AND io.workflow_id = t.workflow_id AND io.output_artifact_id = ? AND io.revision = ?
      JOIN forge_artifacts pa ON pa.id = io.output_artifact_id
      JOIN forge_developer_executions de ON de.id = ? AND de.task_id = t.id AND de.company_id = t.company_id AND de.workflow_id = t.workflow_id AND de.delivery_artifact_id = ? AND lower(de.result_commit) = lower(?) AND lower(de.result_tree) = lower(?) AND lower(de.target_base_sha) = lower(?)
      JOIN forge_artifacts da ON da.id = de.delivery_artifact_id
      JOIN forge_artifacts ea ON ea.id = de.evidence_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ? AND b.id = ?`).get(
      input.leadOutputArtifactId,
      input.planRevision,
      subject.developerExecutionId,
      subject.deliveryArtifactId,
      subjectCommit,
      subjectTree,
      targetBaseSha,
      input.taskId,
      input.companyId,
      input.projectId,
      input.projectRevisionId,
      input.briefArtifactId,
    ) as DeliveryReviewContext | undefined);
    if (context?.developerEvidenceArtifactId && context.developerEvidenceArtifactId !== subject.developerEvidenceArtifactId) {
      subject = { ...subject, developerEvidenceArtifactId: context.developerEvidenceArtifactId };
      input.subject = subject;
    }
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
    let leadProfile: Awaited<ReturnType<AgentService["resolveTurnProfile"]>>;
    let rawSessionId: string;
    try {
      leadProfile = await this.resolveTurnProfile(input.roleProfiles.planner, leadSessionRef, "Lead review");
      rawSessionId = await this.sessionStore.read(leadSessionRef);
      if (!rawSessionId) throw new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    const schemaPath = await this.ensureDeliveryReviewSchema();
    const active = this.activeCapacityExecution(input, "planner");
    const executionId = active?.id ?? `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    const activeAttempt = active && !isFinalReview ? this.database.authQuery((db) => db.prepare("SELECT id FROM forge_delivery_review_attempts WHERE lead_execution_id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at DESC LIMIT 1").get(executionId, input.taskId, input.companyId, input.workflowId) as { id: string } | undefined) : undefined;
    const attemptId = activeAttempt?.id ?? `review_attempt_${randomBytes(12).toString("hex")}`;
    if (!active) this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at, event_offset) VALUES (?, ?, ?, ?, 'planner', 'starting', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)").run(executionId, input.taskId, input.companyId, input.workflowId, `${input.workflowId}:delivery-review:${subjectCommit}:${attemptId}`, input.planRevision, isFinalReview ? "final-delivery-review" : "delivery-review", leadProfile.id, leadProfile.model, leadProfile.reasoningLevel, leadProfile.servicePriority, leadSessionRef, startedAt);
      if (!isFinalReview) db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id, lead_session_ref, developer_session_ref, status, correction_attempts, supersedes_review_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)").run(attemptId, input.taskId, input.companyId, input.workflowId, subject.planRevision, targetBaseSha, subjectCommit, subjectTree, subject.developerExecutionId, subject.deliveryArtifactId, subject.developerEvidenceArtifactId, executionId, leadSessionRef, context.developerSessionRef, input.supersedesReviewId, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, leadSessionRef, input.worktreePath);
    });
    const evidenceLines: string[] = [];
    const outputLines: string[] = [];
    let correctionAttempts = 0;
    let evidenceBytes = 0;
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 2_000);
    const stopCancellationTracking = this.trackCancellation(executionId, runtime.signal);
    try {
      const initialPrompt = this.deliveryReviewPrompt(context.title, brief, plan, delivery, developerEvidence, gitEvidence, delivery.includes('"priorHead"')) + (isFinalReview ? `\n\nYou are Forge's Integrator for this final review: your job is to get the Builder's branch merged - publish the pull request, watch CI, fix CI failures, and resolve merge conflicts against the current base.\n\nExact required CI context: ${JSON.stringify({ releaseId: input.releaseId, ciRunId: input.ciRunId, status: finalContext?.status, headSha: finalContext?.headSha, headTree: finalContext?.headTree })}` : "");
      const runTurn = async (turn: number, prompt: string): Promise<void> => {
        evidenceLines.push(JSON.stringify({ type: "forge.review-turn-start", turn }));
        const wrapper = await this.prepareTurnWrapper(executionId, leadProfile, worktreePath, schemaPath, prompt, { resumeSessionRef: leadSessionRef, sessionRef: leadSessionRef });
        const observed = await this.processRunner({
          command: wrapper.command,
          args: wrapper.args,
          cwd: worktreePath,
          detached: true,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
          onStart: async (pid, processStartedAt, inspection) => { await this.recordLeadProcessStart(executionId, pid, processStartedAt, inspection); },
          onLine: async (line) => {
            await this.recordLeadChildStart(executionId, line);
            const sanitized = this.provider.sanitizeLine(line);
            evidenceBytes += Buffer.byteLength(line, "utf8") + 1;
            if (evidenceBytes > 6 * 1024 * 1024) throw new AgentFailure("evidence-too-large", "Codex evidence exceeded the local artifact limit");
            const event = this.provider.parseEvent(line);
            if (event.sessionRef && event.sessionRef !== leadSessionRef) throw new AgentFailure("session-identity-conflict", "Lead delivery review returned a different session identity");
            if (event.threadId && event.threadId !== rawSessionId) throw new AgentFailure("session-identity-conflict", "Lead delivery review returned a different session identity");
            evidenceLines.push(sanitized);
            outputLines.push(line);
            await this.databaseHeartbeat(executionId, "running", evidenceLines.length);
          },
        });
        const result = await this.completedTurnResult(observed, wrapper);
        if (result.exitCode !== 0) {
          if (result.stderr.trim()) evidenceLines.push(JSON.stringify({ type: "forge.review-wrapper-stderr", diagnostic: this.provider.sanitizeLine(result.stderr).slice(0, 2_000) }));
          throw this.provider.classifyProcessFailure(result, outputLines, leadProfile.model);
        }
        evidenceLines.push(JSON.stringify({ type: "forge.review-turn-end", turn }));
      };
      let review: DeliveryReview;
      try {
        await runTurn(1, initialPrompt);
        review = DeliveryReviewSchema.parse(parseDeliveryReview(outputLines, this.provider));
      } catch (firstError) {
        const firstFailure = firstError instanceof AgentFailure ? firstError : new AgentFailure("invalid-review-output", "Lead review output did not satisfy the required format");
        if (isFinalReview) throw firstFailure;
        if (!["missing-review-output", "malformed-review-output", "invalid-review-output"].includes(firstFailure.code)) throw firstFailure;
        correctionAttempts = 1;
        outputLines.length = 0;
        await cleanupAgentWrapper(this.config.runtimeRoot, executionId);
        const correctionPrompt = (`The prior Lead response was not machine-readable. Format-only correction; do not change the review substance or scope. Validation issue: ${firstFailure.code}: ${firstFailure.message}\nReturn only the required delivery_review JSON object described in the prior prompt.`).slice(0, 2_000);
        await runTurn(2, correctionPrompt);
        try { review = DeliveryReviewSchema.parse(parseDeliveryReview(outputLines, this.provider)); }
        catch { throw new AgentFailure("correction-exhausted", safeBlockSummary("correction-exhausted", true)); }
      }
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const opinion = await this.artifacts.put(input.companyId, "delivery-review", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(review, null, 2), "utf8") });
      const repairPlanArtifact = review.repairPlan ? await this.artifacts.put(input.companyId, "delivery-repair-plan", { filename: `${executionId}-repair-plan.md`, mimeType: "text/markdown", bytes: Buffer.from(review.repairPlan, "utf8") }) : undefined;
      const priorReview = isFinalReview ? undefined : this.database.authQuery((db) => db.prepare("SELECT id FROM forge_delivery_reviews WHERE workflow_id = ? AND subject_commit = ?").get(input.workflowId, subjectCommit) as { id: string } | undefined);
      const reviewId = priorReview?.id ?? `delivery_review_${randomBytes(12).toString("hex")}`;
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, opinion.id, opinion.companyId, opinion.kind, opinion.filename, opinion.mimeType, opinion.byteSize, opinion.sha256, opinion.storagePath, opinion.createdAt);
        if (repairPlanArtifact) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(repairPlanArtifact.id, repairPlanArtifact.companyId, repairPlanArtifact.kind, repairPlanArtifact.filename, repairPlanArtifact.mimeType, repairPlanArtifact.byteSize, repairPlanArtifact.sha256, repairPlanArtifact.storagePath, repairPlanArtifact.createdAt);
        if (isFinalReview) {
          db.prepare("INSERT INTO forge_final_reviews (id, task_id, company_id, workflow_id, release_id, ci_run_id, delivery_review_id, developer_execution_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.releaseId, input.ciRunId, input.deliveryReviewId, subject.developerExecutionId, subject.planRevision, targetBaseSha, subjectCommit, subjectTree, executionId, leadSessionRef, review.outcome, review.summary, opinion.id, evidence.id, this.now().toISOString());
          for (const finding of review.findings) db.prepare("INSERT INTO forge_final_review_findings (id, review_id, task_id, company_id, severity, rationale, evidence_ref, disposition, repair_instruction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(finding.findingId, reviewId, input.taskId, input.companyId, finding.severity, finding.rationale, finding.evidenceRef, finding.disposition, finding.repairInstruction);
        } else {
          if (priorReview) {
            db.prepare("UPDATE forge_delivery_reviews SET lead_execution_id = ?, session_ref = ?, outcome = ?, summary = ?, opinion_artifact_id = ?, evidence_artifact_id = ?, repair_cycle = 0, supersedes_review_id = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").run(executionId, leadSessionRef, review.outcome, review.summary, opinion.id, evidence.id, input.supersedesReviewId, reviewId, input.taskId, input.companyId, input.workflowId);
            db.prepare("DELETE FROM forge_delivery_findings WHERE review_id = ? AND task_id = ? AND company_id = ?").run(reviewId, input.taskId, input.companyId);
          } else db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, supersedes_review_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.planRevision, targetBaseSha, subjectCommit, subjectTree, executionId, leadSessionRef, review.outcome, review.summary, opinion.id, evidence.id, input.supersedesReviewId, this.now().toISOString());
          for (const finding of review.findings) db.prepare("INSERT INTO forge_delivery_findings (id, review_id, task_id, company_id, severity, rationale, evidence_ref, disposition, repair_instruction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`delivery_finding_${reviewId}_${finding.findingId}`, reviewId, input.taskId, input.companyId, finding.severity, finding.rationale, finding.evidenceRef, finding.disposition, finding.repairInstruction, this.now().toISOString());
        }
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), evidence.id, executionId);
        if (!isFinalReview) db.prepare("UPDATE forge_delivery_review_attempts SET status = 'completed', correction_attempts = ?, evidence_artifact_id = ?, completed_review_id = ?, finished_at = ? WHERE id = ?").run(correctionAttempts, evidence.id, reviewId, this.now().toISOString(), attemptId);
      });
      const completed = DeliveryReviewActivityResultSchema.parse({ outcome: "completed", attemptId, correctionAttempts, subject: { ...subject, developerSessionRef: context.developerSessionRef }, review: { reviewId, leadExecutionId: executionId, leadSessionRef, opinionArtifactId: opinion.id, evidenceArtifactId: evidence.id, opinion: review.outcome, summary: review.summary, repairPlan: review.repairPlan, repairPlanArtifactId: repairPlanArtifact?.id ?? null, repairPlanSha256: repairPlanArtifact?.sha256 ?? null, findings: review.findings, supersedesReviewId: input.supersedesReviewId } });
      return completed;
    } catch (error) {
      const cancelled = runtime.signal?.aborted && !(error instanceof AgentFailure && error.code === "ownership_ambiguous");
      const expectedFailure = error instanceof AgentFailure && !cancelled;
      const failure = cancelled ? new AgentFailure("cancelled", "The Codex Lead turn was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("delivery-review-failed", "Codex Lead delivery review failed");
      evidenceLines.push(JSON.stringify({ type: "forge.review-turn-failed", code: failure.code }));
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const code = failure.code === "cancelled" ? "cancelled" : failure.code === "correction-exhausted" ? "correction-exhausted" : deliveryBlockCode(failure);
      const summary = code === "cancelled" ? failure.message : safeBlockSummary(code, code === "correction-exhausted");
      const finalStatus = failure.code === "cancelled" ? "cancelled" : isFinalReview || !expectedFailure ? "failed" : "blocked";
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(finalStatus, this.now().toISOString(), this.now().toISOString(), code, summary, finalStatus === "cancelled" ? this.now().toISOString() : null, evidence.id, executionId);
        if (!isFinalReview) db.prepare("UPDATE forge_delivery_review_attempts SET status = ?, correction_attempts = ?, evidence_artifact_id = ?, failure_code = ?, failure_summary = ?, finished_at = ? WHERE id = ?").run(finalStatus === "cancelled" ? "failed" : expectedFailure ? "blocked" : "failed", correctionAttempts, evidence.id, code, summary, this.now().toISOString(), attemptId);
      });
      if (!expectedFailure || isFinalReview) throw failure;
      if (code === "cancelled") throw failure;
      return DeliveryReviewActivityResultSchema.parse({ outcome: "blocked", attemptId, code, summary, evidenceArtifactId: evidence.id, executionId, sessionRef: leadSessionRef, correctionAttempts, subject: { ...subject, developerSessionRef: context.developerSessionRef } });
    } finally { clearInterval(heartbeat); stopCancellationTracking(); await this.cleanupTerminalWrapper(executionId); }
  }

  async runSupplementalReview(rawInput: SupplementalReviewActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<SupplementalReviewResult> {
    const input = rawInput;
    const profile = await this.resolveTurnProfile(input.roleProfiles.reviewer, undefined, "Supplemental reviewer");
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, r.normalized_json, b.storage_path AS brief_storage_path, b.sha256 AS brief_sha256, oa.storage_path AS output_storage_path, oa.sha256 AS output_sha256, e.storage_path AS evidence_storage_path, e.sha256 AS evidence_sha256
      FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id JOIN forge_issue_outputs io ON io.task_id = t.id AND io.output_artifact_id = ?
      JOIN forge_artifacts oa ON oa.id = io.output_artifact_id JOIN forge_artifacts e ON e.id = io.evidence_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ? AND b.id = ?`).get(input.leadOutputArtifactId, input.taskId, input.companyId, input.projectId, input.projectRevisionId, input.briefArtifactId) as { title: string; normalized_json: string; brief_storage_path: string; brief_sha256: string; output_storage_path: string; output_sha256: string; evidence_storage_path: string; evidence_sha256: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Supplemental review evidence is unavailable");
    let reviewerProfile = profile;
    if (input.originalPlanSubject) {
      if (!input.evidenceManifestArtifactId) throw new AgentFailure("scoped-input-missing", "The supplemental review manifest is unavailable");
      const pinnedManifest = this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'planning-evidence-manifest'").get(input.evidenceManifestArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined);
      if (!pinnedManifest) throw new AgentFailure("scoped-input-missing", "The supplemental review manifest is unavailable");
      try {
        const manifest = JSON.parse((await this.artifacts.read({ companyId: input.companyId, storagePath: pinnedManifest.storagePath, sha256: pinnedManifest.sha256 })).toString("utf8")) as { profiles?: { reviewer?: ProfileSettings | null } };
        const pinnedReviewer = manifest.profiles?.reviewer;
        if (!pinnedReviewer || pinnedReviewer.id !== profile.id || pinnedReviewer.provider !== this.provider.id || !pinnedReviewer.model) throw new AgentFailure("reviewer-profile-unavailable", "The reviewer settings are not present in the pinned manifest");
        reviewerProfile = { id: pinnedReviewer.id, model: pinnedReviewer.model, reasoningLevel: pinnedReviewer.reasoningLevel as "low" | "medium" | "high" | "xhigh", servicePriority: pinnedReviewer.servicePriority as "standard" | "priority" | "fast" };
      } catch (error) {
        if (error instanceof AgentFailure) throw error;
        throw new AgentFailure("scoped-input-missing", "The pinned supplemental review manifest is invalid");
      }
    }
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(pinnedRepositoryPath(context.normalized_json)));
    const brief = (await this.artifacts.read({ companyId: input.companyId, storagePath: context.brief_storage_path, sha256: context.brief_sha256 })).toString("utf8");
    const draft = (await this.artifacts.read({ companyId: input.companyId, storagePath: context.output_storage_path, sha256: context.output_sha256 })).toString("utf8");
    const active = this.activeCapacityExecution(input, "reviewer");
    const manifest = input.evidenceManifestArtifactId
      ? this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'planning-evidence-manifest'").get(input.evidenceManifestArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined)
      : undefined;
    if (input.evidenceManifestArtifactId && !manifest) throw new AgentFailure("scoped-input-missing", "Supplemental review manifest is unavailable");
    const manifestText = manifest ? (await this.artifacts.read({ companyId: input.companyId, storagePath: manifest.storagePath, sha256: manifest.sha256 })).toString("utf8") : "";
    const images = this.database.authQuery((db) => {
      if (!input.imageArtifactIds.length) return [] as ImageRow[];
      const placeholders = input.imageArtifactIds.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, storage_path, sha256, filename, mime_type FROM forge_artifacts WHERE company_id = ? AND kind = 'task-image' AND id IN (${placeholders})`).all(input.companyId, ...input.imageArtifactIds) as ImageRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return input.imageArtifactIds.flatMap((imageId) => { const row = byId.get(imageId); return row ? [row] : []; });
    });
    if (images.length !== input.imageArtifactIds.length) throw new AgentFailure("scoped-input-missing", "Supplemental review image evidence is unavailable");
    for (const image of images) await this.artifacts.read({ companyId: input.companyId, storagePath: image.storage_path, sha256: image.sha256 });
    const schemaPath = await this.ensureLeadSchema();
    const executionId = active?.id ?? `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    if (!active) this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority, started_at, event_offset) VALUES (?, ?, ?, ?, 'reviewer', 'starting', 1, ?, ?, 'supplemental-review', ?, ?, ?, ?, ?, 0)").run(executionId, input.taskId, input.companyId, input.workflowId, `${input.workflowId}:supplemental-review:${input.revision}`, input.revision, reviewerProfile.id, reviewerProfile.model, reviewerProfile.reasoningLevel, reviewerProfile.servicePriority, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, undefined, repositoryPath);
    });
    const lines: string[] = [];
    let sessionRef: string | undefined = active?.sessionRef ?? undefined;
    let rawSessionId: string | undefined;
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 2_000);
    const stopCancellationTracking = this.trackCancellation(executionId, runtime.signal);
    try {
      const reviewEvidence = input.originalPlanSubject ? manifestText : (await this.artifacts.read({ companyId: input.companyId, storagePath: context.evidence_storage_path, sha256: context.evidence_sha256 })).toString("utf8");
      const wrapper = await this.prepareTurnWrapper(executionId, reviewerProfile, repositoryPath, schemaPath, this.reviewPrompt(context.title, brief, context.normalized_json, draft, reviewEvidence), { ...(images.length ? { imagePaths: images.map((image) => resolve(this.config.artifactRoot, image.storage_path)) } : {}) });
      const result = await this.processRunner({
        command: wrapper.command,
        args: wrapper.args,
        cwd: repositoryPath,
        detached: true,
        ...(runtime.signal ? { signal: runtime.signal } : {}),
        onStart: async (pid, processStartedAt, inspection) => { await this.recordLeadProcessStart(executionId, pid, processStartedAt, inspection); },
        onLine: async (line) => {
          await this.recordLeadChildStart(executionId, line);
          const sanitized = this.provider.sanitizeLine(line);
          lines.push(sanitized);
          const event = this.provider.parseEvent(line);
          if (event.sessionRef) {
            if (sessionRef && sessionRef !== event.sessionRef) throw new AgentFailure("session-identity-conflict", "Supplemental review returned a different Lead session identity");
            sessionRef = event.sessionRef;
            rawSessionId ??= await this.sessionStore.read(sessionRef);
            await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId));
          } else if (event.threadId && !sessionRef) {
            rawSessionId = event.threadId;
            sessionRef = await this.sessionStore.create(rawSessionId);
            await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId));
          }
          await this.databaseHeartbeat(executionId, "running", lines.length);
        },
      });
      if (result.exitCode !== 0) throw this.provider.classifyProcessFailure(result, lines, reviewerProfile.model);
      const review = parseSupplementalReview(lines, this.provider);
      if (!sessionRef) throw new AgentFailure("missing-session", "Supplemental review did not return a session reference");
      if (input.primaryLeadSessionRef && sessionRef === input.primaryLeadSessionRef) throw new AgentFailure("session-identity-conflict", "Supplemental reviewer must use a fresh session");
      const evidence = await this.persistEvidence(input.companyId, executionId, lines);
      const reviewArtifact = await this.artifacts.put(input.companyId, "supplemental-review", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(review, null, 2), "utf8") });
      const reviewId = `review_${randomBytes(12).toString("hex")}`;
      const reviewSubject = input.originalPlanSubject && input.evidenceManifestArtifactId && input.evidenceManifestSha256
        ? { originalPlan: input.originalPlanSubject, reviewerProfileId: profile.id, evidenceManifestArtifactId: input.evidenceManifestArtifactId, evidenceManifestSha256: input.evidenceManifestSha256 }
        : undefined;
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, reviewArtifact.id, reviewArtifact.companyId, reviewArtifact.kind, reviewArtifact.filename, reviewArtifact.mimeType, reviewArtifact.byteSize, reviewArtifact.sha256, reviewArtifact.storagePath, reviewArtifact.createdAt);
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), evidence.id, executionId);
      });
      if (reviewSubject && sessionRef) {
        new PlanGovernanceRepository(this.database).appendSupplementalReview({ subject: reviewSubject, reviewId, executionId, reviewerSessionRef: sessionRef, opinionArtifactId: reviewArtifact.id, opinionArtifactSha256: reviewArtifact.sha256, evidenceArtifactId: evidence.id, evidenceArtifactSha256: evidence.sha256, summary: review.summary });
      } else {
        this.database.authTransaction((db) => db.prepare("INSERT INTO forge_plan_reviews (id, task_id, company_id, workflow_id, plan_revision, profile_id, execution_id, session_ref, opinion_artifact_id, evidence_artifact_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.revision, profile.id, executionId, sessionRef, reviewArtifact.id, evidence.id, review.summary, this.now().toISOString()));
      }
      return { reviewId, reviewArtifactId: reviewArtifact.id, evidenceArtifactId: evidence.id, executionId, sessionRef, summary: review.summary, ...(reviewSubject ? { subject: reviewSubject, reviewArtifactSha256: reviewArtifact.sha256, evidenceManifestArtifactId: reviewSubject.evidenceManifestArtifactId, evidenceManifestSha256: reviewSubject.evidenceManifestSha256 } : {}) };
    } catch (error) {
      const failure = runtime.signal?.aborted && !(error instanceof AgentFailure && error.code === "ownership_ambiguous") ? new AgentFailure("cancelled", "The Codex supplemental review was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("review-failed", "Supplemental review failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, lines);
      const finalStatus = failure.code === "cancelled" ? "cancelled" : "failed";
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(finalStatus, this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, finalStatus === "cancelled" ? this.now().toISOString() : null, evidence.id, executionId);
      });
      throw failure;
    } finally { clearInterval(heartbeat); stopCancellationTracking(); await this.cleanupTerminalWrapper(executionId); }
  }

  async consolidateLeadPlan(rawInput: ConsolidateLeadPlanActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<LeadPlanningResult> {
    const lead = await this.resolveTurnProfile(rawInput.roleProfiles.planner, rawInput.leadSessionRef, "Lead consolidation");
    await this.sessionStore.read(rawInput.leadSessionRef);
    const draft = this.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a WHERE a.id = ? AND a.company_id = ?").get(rawInput.leadOutputArtifactId, rawInput.companyId) as { storagePath: string; sha256: string } | undefined);
    const review = this.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a WHERE a.id = ? AND a.company_id = ?").get(rawInput.supplementalReviewArtifactId, rawInput.companyId) as { storagePath: string; sha256: string } | undefined);
    if (!draft || !review) throw new AgentFailure("scoped-input-missing", "Consolidation evidence is unavailable");
    const repositoryPath = await this.consolidationRepositoryPath(rawInput);
    const draftText = (await this.artifacts.read({ ...draft, companyId: rawInput.companyId })).toString("utf8");
    const reviewText = (await this.artifacts.read({ ...review, companyId: rawInput.companyId })).toString("utf8");
    const schemaPath = await this.ensureLeadSchema();
    const active = this.activeCapacityExecution(rawInput, "planner");
    const executionId = active?.id ?? `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    if (!active) this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at, event_offset) VALUES (?, ?, ?, ?, 'planner', 'starting', 1, ?, ?, 'lead-consolidation', ?, ?, ?, ?, ?, ?, 0)").run(executionId, rawInput.taskId, rawInput.companyId, rawInput.workflowId, `${rawInput.workflowId}:lead-consolidation:${rawInput.revision}`, rawInput.revision, lead.id, lead.model, lead.reasoningLevel, lead.servicePriority, rawInput.leadSessionRef, startedAt);
      this.bindCapacityInTransaction(db, rawInput, executionId, rawInput.leadSessionRef, repositoryPath);
    });
    const lines: string[] = [];
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 2_000);
    const stopCancellationTracking = this.trackCancellation(executionId, runtime.signal);
    try {
      let response: z.infer<typeof LeadReviewResponseSchema> | undefined;
      let lastFailure: AgentFailure | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const wrapper = await this.prepareTurnWrapper(executionId, lead, repositoryPath, schemaPath, this.consolidationPrompt(draftText, reviewText, attempt > 0), { resumeSessionRef: rawInput.leadSessionRef, sessionRef: rawInput.leadSessionRef });
        const result = await this.processRunner({ command: wrapper.command, args: wrapper.args, cwd: repositoryPath, detached: true, ...(runtime.signal ? { signal: runtime.signal } : {}), onStart: async (pid, processStartedAt, inspection) => { await this.recordLeadProcessStart(executionId, pid, processStartedAt, inspection); }, onLine: async (line) => { await this.recordLeadChildStart(executionId, line); lines.push(this.provider.sanitizeLine(line)); await this.databaseHeartbeat(executionId, "running", lines.length); } });
        if (result.exitCode !== 0) throw this.provider.classifyProcessFailure(result, lines, lead.model);
        try {
          const parsed = parseLeadReviewResponse(lines, this.provider);
          const expectedRevision = rawInput.originalPlanSubject?.originalPlanRevision ?? rawInput.revision;
          if (parsed.originalPlanRevision !== expectedRevision || parsed.reviewArtifactId !== rawInput.supplementalReviewArtifactId) throw new AgentFailure("invalid-review-response", "Lead supplemental-review response is not pinned to the exact review");
          response = parsed;
          break;
        } catch (error) {
          lastFailure = error instanceof AgentFailure ? error : new AgentFailure("invalid-review-response", "Lead supplemental-review response was invalid");
          if (attempt === 1) throw lastFailure;
        }
      }
      if (!response) throw lastFailure ?? new AgentFailure("missing-review-response", "Lead did not return a supplemental-review response");
      const output = response.result;
      const manifest = rawInput.evidenceManifestArtifactId && rawInput.evidenceManifestSha256
        ? { id: rawInput.evidenceManifestArtifactId, sha256: rawInput.evidenceManifestSha256 }
        : undefined;
      const persisted = await this.persistOutput({ taskId: rawInput.taskId, companyId: rawInput.companyId, workflowId: rawInput.workflowId, projectId: rawInput.projectId, projectRevisionId: rawInput.projectRevisionId, briefArtifactId: rawInput.briefArtifactId, imageArtifactIds: rawInput.imageArtifactIds, roleProfiles: rawInput.roleProfiles, revision: rawInput.revision }, executionId, rawInput.leadSessionRef, lines, output, manifest, { finalVersion: 2, ...(rawInput.originalPlanSubject ? { originalPlanRevision: rawInput.originalPlanSubject.originalPlanRevision, supersedesOutputId: rawInput.originalPlanSubject.outputId } : {}) });
      const responseArtifact = await this.artifacts.put(rawInput.companyId, "lead-review-response", { filename: `${executionId}-review-response.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(response, null, 2), "utf8") });
      this.database.authTransaction((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(responseArtifact.id, responseArtifact.companyId, responseArtifact.kind, responseArtifact.filename, responseArtifact.mimeType, responseArtifact.byteSize, responseArtifact.sha256, responseArtifact.storagePath, responseArtifact.createdAt));
      const reviewRow = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_plan_reviews WHERE opinion_artifact_id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(rawInput.supplementalReviewArtifactId, rawInput.taskId, rawInput.companyId, rawInput.workflowId) as { id: string } | undefined);
      if (reviewRow && rawInput.originalPlanSubject) new PlanGovernanceRepository(this.database).appendLeadReviewResponse({ reviewId: reviewRow.id, taskId: rawInput.taskId, companyId: rawInput.companyId, workflowId: rawInput.workflowId, originalPlanRevision: rawInput.originalPlanSubject.originalPlanRevision, leadExecutionId: executionId, leadSessionRef: rawInput.leadSessionRef, responseArtifactId: responseArtifact.id, responseArtifactSha256: responseArtifact.sha256, ...(persisted.result.planSubject ? { resultOutputId: persisted.result.planSubject.outputId } : {}), ...(persisted.result.blockerSubject ? { resultBlockerArtifactId: persisted.result.blockerSubject.artifactId } : {}) });
      await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), persisted.evidence.id, executionId));
      return { ...persisted.result, leadReviewResponseArtifactId: responseArtifact.id, leadReviewResponseArtifactSha256: responseArtifact.sha256 };
    } catch (error) {
      const failure = runtime.signal?.aborted && !(error instanceof AgentFailure && error.code === "ownership_ambiguous") ? new AgentFailure("cancelled", "The Codex Lead consolidation was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("consolidation-failed", "Lead consolidation failed");
      const evidence = await this.persistEvidence(rawInput.companyId, executionId, lines);
      const finalStatus = failure.code === "cancelled" ? "cancelled" : "failed";
      this.database.authTransaction((db) => { db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt); db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(finalStatus, this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, finalStatus === "cancelled" ? this.now().toISOString() : null, evidence.id, executionId); });
      throw failure;
    } finally { clearInterval(heartbeat); stopCancellationTracking(); await this.cleanupTerminalWrapper(executionId); }
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
      "You are Forge's Integrator: your job is to get the Builder's branch merged, which means resolving conflicts against the current base. Plan the resolution of this target-base forward-merge conflict. Continue the existing Lead session and work read-only. Do not modify files, abort the merge, use GitHub/provider commands, or invent facts.",
      'Return exactly one JSON object with no markdown fences or commentary matching: {"kind":"merge_conflict_plan","summary":"...","resolutions":[{"number":1,"file":"path","resolution":"specific resolution grounded in both sides","intendedResult":"...","issueInvariant":"...","baseInvariant":"...","compatibilityConcern":"..."}],"verificationStrategy":"complete local verification after the merge commit","unresolvedQuestions":[]}. Number every resolution from 1; every conflict file must appear exactly once and unresolvedQuestions must be empty.',
      "Task: " + title + "\nBrief:\n" + brief,
      "Approved plan:\n" + plan,
      "Forward-merge identity:\n" + JSON.stringify({ branchName: input.branchName, priorHead: input.priorHead, targetBaseSha: input.targetBaseSha }),
      "Conflict files:\n" + conflict.conflictFiles.join("\n"),
      "Combined conflict evidence:\n" + conflict.combinedDiff,
      "Pinned deterministic commands:\n" + JSON.stringify(pinnedCommands),
    ].join("\n\n");
  }

  private ciRepairPrompt(title: string, input: CiRepairPlanActivityInput, failedChecks: Array<{ name: string; conclusion: string; summary: string | null }>, failedLogs: Array<{ name: string; runId: string; log: string }> = []): string {
    return `You are Forge's Integrator: your job is to get the Builder's branch merged, which means watching CI and fixing what it reports. Diagnose one exact failed CI observation. Resume the same Lead session. Use only the bounded check names, summaries, and failing job logs below; do not request a new session, branch, worktree, pull request, merge, rebase, amend, force push, or history rewrite. Return exactly one JSON object with no markdown fences or commentary matching: {"kind":"ci-repair-plan","ciRunId":"...","ciAttemptId":"...","failedHeadSha":"...","rootCause":"...","disposition":"repair"|"rerun","failedChecks":[{"name":"exact failed check name","evidenceArtifactId":"...","diagnosis":"..."}],"steps":[{"number":1,"instruction":"...","verification":"..."}],"localVerification":["exact pinned command"],"unresolvedQuestions":[]}. Set disposition to "rerun" — and only then — when the evidence shows the failure is not caused by this delivery (a flake, infrastructure or runner outage, a rate limit, or a pre-existing failure on the base): Forge will re-run the failed provider jobs for you, at most twice per CI cycle, and then wait on CI again. Otherwise use "repair" and author the code fix. Either way, use the exact identity values supplied below, one failedChecks entry per failed exact-head check, contiguous step numbers starting at 1, the complete pinned local verification, and no unresolved questions; for a "rerun" the steps describe what to do if the re-run fails again. Use no other keys.\n\nTask: ${title}\nExact identity: ${JSON.stringify({ ciRunId: input.ciRunId, ciAttemptId: input.ciAttemptId, failedHeadSha: input.failedHeadSha })}\nFailed exact-head checks: ${JSON.stringify(failedChecks)}\nRequired checks: ${JSON.stringify(input.requiredChecks)}\nPinned local verification: ${JSON.stringify(input.localVerification)}\nThe evidenceArtifactId for every failed check is exactly: ${input.evidenceArtifactId}${failedLogs.length ? `\nFailing job logs (tail):\n${failedLogs.map((entry) => `--- ${entry.name} (run ${entry.runId}) ---\n${entry.log}`).join("\n\n")}` : ""}`;
  }

  private deliveryReviewPrompt(title: string, brief: string, plan: string, delivery: string, developerEvidence: string, gitEvidence: { targetBaseSha: string; subjectCommit: string; subjectTree: string; status: string; branch: string; head: string; tree: string; diff: string; commit: string; instructions: string }, isForwardMergeDelivery: boolean): string {
    return [
      'You are Forge\'s Lead reviewer continuing the existing Lead session. Review the exact local Developer delivery; do not redesign or expand the approved plan. Do not modify files, commit, run CI, use GitHub/provider commands, or treat CI as available.',
      'Return exactly one JSON object with no markdown fences or commentary matching: {"kind":"delivery_review","summary":"...","outcome":"approved|blocking","findings":[{"findingId":"finding_...","severity":"blocking|advisory","rationale":"...","evidenceRef":"diff hunk, file, test, or report reference","disposition":"open|accepted|repaired","repairInstruction":null}],"repairPlan":null}. Blocking findings are limited to correctness, acceptance, security/privacy/data loss, compatibility, operational safety, unintended scope, or missing mandatory proof. Advisory findings never block. Treat \`not_applicable_locally\` steps as acceptable when their note is reasonable. An approved result cannot contain an open blocking finding. A blocking result must identify each open blocking finding and provide a bounded repairPlan when repair is possible; use null only when a member decision is required. Ground every finding in the supplied exact revision and evidence.',
      `Task: ${title}\nBrief:\n${promptExcerpt(brief, 8_000)}`,
      `Authorized approved plan:\n${promptExcerpt(plan, 24_000)}`,
      `Developer delivery report:\n${promptExcerpt(delivery, 32_000)}`,
      `Developer verification evidence:\n${promptExcerpt(developerEvidence, 16_000)}`,
      ...(isForwardMergeDelivery ? ["This is a clean forward-merge delivery. Its pinned post-merge verification and the prior delivery proof remain authoritative for unchanged behavior. Do not block solely because broader checks or manual smoke steps were not repeated after the merge; report those as advisory unless the exact merge diff shows a concrete regression or new risk."] : []),
      `Exact Git subject (base, branch, commit, tree, clean state):\n${JSON.stringify({ targetBaseSha: gitEvidence.targetBaseSha, branch: gitEvidence.branch, subjectCommit: gitEvidence.subjectCommit, subjectTree: gitEvidence.subjectTree, observedHead: gitEvidence.head, observedTree: gitEvidence.tree, dirtyState: gitEvidence.status ? "dirty" : "clean" })}`,
      `Repository instructions:\n${promptExcerpt(gitEvidence.instructions || "(none found)", 12_000)}`,
      `Exact diff from target base to subject commit:\n${promptExcerpt(gitEvidence.diff, 72_000)}`,
      `Subject commit details:\n${promptExcerpt(gitEvidence.commit, 12_000)}`,
    ].join("\n\n");
  }

  private reviewPrompt(title: string, brief: string, revision: string, draft: string, evidence: string): string {
    return `You are Forge's independent supplemental reviewer. Do not modify files, review implementation, or become the plan owner. Return exactly one JSON object: {"kind":"review","summary":"...","opinion":"approve"|"request_changes","concerns":[],"requiredChanges":[]}. Read the complete draft and the scoped evidence manifest below. Identify only concrete correctness, acceptance, security/privacy, compatibility, operational, or unintended-scope concerns. Do not infer evidence from any source outside the pinned manifest.\n\nTask: ${title}\nBrief:\n${brief}\n\nPinned Project revision:\n${revision}\n\nDraft Lead plan:\n${draft}\n\nPinned planning evidence manifest (sole evidence source):\n${evidence}`;
  }

  private consolidationPrompt(draft: string, review: string, correction: boolean): string {
    const instruction = correction
      ? "Your previous response did not satisfy the exact envelope or pinned identifiers. Continue the same Lead session and return one corrected JSON object only."
      : "Reconsider the complete Lead plan in this same session after an independent supplemental review.";
    return `${instruction} Return exactly this strict envelope: {"version":1,"originalPlanRevision":0,"reviewArtifactId":"review_artifact_id","reviewResponse":"Describe how each concrete review concern was addressed.","result":{"kind":"plan","summary":"...","gitPresentation":{"branchSlug":"short-kebab-case-purpose","pullRequestTitle":"Polished imperative title","pullRequestDescription":"One to three sentences explaining the change and why it matters."},"reproduction":null,"rootCauseAnalysis":null,"steps":[{"number":1,"instruction":"...","verification":"...","verificationCommands":[]}],"compatibilityAnalysis":"...","operationalAnalysis":"...","verificationStrategy":"...","unresolvedTechnicalQuestions":[],"materialCategories":[],"affectedPaths":["path/to/affected/file"],"materiality":[{"category":"user_visible_behavior","rationale":"...","evidenceRefs":["step:1"]}],"developerContext":{"includeTaskBrief":false,"evidenceArtifactIds":[],"imageArtifactIds":[],"repositoryInstructionPaths":[],"artifactStepNumbers":[]}}}. The result may instead be a decision_blocker matching its required schema. Use the exact originalPlanRevision and reviewArtifactId supplied by Forge. Preserve correct steps, address concrete review concerns, and do not leave unresolved technical questions. Every plan must carry polished, developer-facing Git presentation: a lowercase kebab-case purpose slug with no issue or workflow identifiers, an imperative pull request title, and a concise description of what changes and why. Every step must declare exact verificationCommands. developerContext is the complete Developer evidence allowlist; each artifactStepNumbers entry has artifactIdOrPath and stepNumbers. Do not include markdown fences or commentary.\n\nDraft plan:\n${draft}\n\nSupplemental review:\n${review}`;
  }

  private async consolidationRepositoryPath(input: ConsolidateLeadPlanActivityInput): Promise<string> {
    const row = this.database.authQuery((db) => db.prepare("SELECT r.normalized_json FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ?").get(input.taskId, input.companyId, input.projectId, input.projectRevisionId) as { normalized_json: string } | undefined);
    if (!row) throw new AgentFailure("scoped-input-missing", "Consolidation repository is unavailable");
    return taskScopedPath(this.config.repositoryRoot, await realpath(pinnedRepositoryPath(row.normalized_json)));
  }

  private async databaseHeartbeat(executionId: string, status: "running", eventOffset?: number): Promise<void> {
    this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = CASE WHEN status = 'cancelling' THEN status ELSE ? END, heartbeat_at = ?, event_offset = COALESCE(?, event_offset) WHERE id = ?").run(status, this.now().toISOString(), eventOffset ?? null, executionId));
  }

  private trackCancellation(executionId: string, signal?: AbortSignal): () => void {
    if (!signal) return () => undefined;
    const mark = (): void => {
      this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'cancelling', cancellation_requested_at = ? WHERE id = ? AND status IN ('starting', 'running', 'cancelling')").run(this.now().toISOString(), executionId));
    };
    if (signal.aborted) mark();
    else signal.addEventListener("abort", mark, { once: true });
    return () => signal.removeEventListener("abort", mark);
  }

  private async resolveTurnProfile(profileId: string | undefined, sessionRef: string | undefined, label: string, role: "planner" | "integrator" = "planner"): Promise<{ id: string; model: string; reasoningLevel: "low" | "medium" | "high" | "xhigh"; servicePriority: "standard" | "priority" | "fast" }> {
    const pinned = sessionRef ? this.database.authQuery((db) => db.prepare("SELECT profile_id AS profileId, resolved_model AS model, resolved_reasoning_level AS reasoningLevel, resolved_service_priority AS servicePriority FROM forge_agent_executions WHERE session_ref = ? AND role = ? AND resolved_model IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(sessionRef, role) as { profileId: string | null; model: string; reasoningLevel: string; servicePriority: string } | undefined) : undefined;
    const profile = pinned ? undefined : this.database.authQuery((db) => (profileId
      ? db.prepare("SELECT id, provider, model, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_profiles WHERE id = ?").get(profileId)
      : db.prepare("SELECT id, provider, model, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_profiles WHERE provider = ? ORDER BY id LIMIT 1").get(this.provider.id)) as { id: string; provider: string; model: string; reasoningLevel: string; servicePriority: string } | undefined);
    if (!pinned && (!profile || profile.provider !== this.provider.id)) throw new AgentFailure("profile-unavailable", `${label} profile is unavailable`);
    const model = pinned?.model ?? profile!.model;
    const reasoningLevel = pinned?.reasoningLevel ?? profile!.reasoningLevel;
    const servicePriority = pinned?.servicePriority ?? profile!.servicePriority;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model) || !["low", "medium", "high", "xhigh"].includes(reasoningLevel) || !["standard", "priority", "fast"].includes(servicePriority)) {
      throw new AgentFailure("scope_configuration", `${label} profile has invalid pinned turn settings`, { nonRetryable: true });
    }
    const settings = { id: pinned?.profileId ?? profile!.id, model, reasoningLevel: reasoningLevel as "low" | "medium" | "high" | "xhigh", servicePriority: servicePriority as "standard" | "priority" | "fast" };
    await this.assertTurnCompatibility(settings);
    return settings;
  }

  private async assertTurnCompatibility(settings: Pick<ProfileSettings, "model" | "reasoningLevel" | "servicePriority">): Promise<void> {
    if (this.processRunner !== this.provider.processRunner) return;
    await this.provider.assertTurnCompatibility(this.command, settings);
  }

  private async prepareTurnWrapper(executionId: string, settings: { model: string; reasoningLevel: "low" | "medium" | "high" | "xhigh"; servicePriority: "standard" | "priority" | "fast" }, repositoryPath: string, outputSchemaPath: string, prompt: string, options: { imagePaths?: string[]; resumeSessionRef?: string; sessionRef?: string } = {}): Promise<PreparedAgentTurnWrapper> {
    const executionRoot = join(this.config.runtimeRoot, "agent-turns", executionId);
    const promptPath = join(executionRoot, "prompt.txt");
    const spoolPath = join(executionRoot, "spool.ndjson");
    const statusPath = join(executionRoot, "status.json");
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
    const request: AgentTurnWrapperRequest = { command: this.command, cwd: repositoryPath, outputSchemaPath, promptPath, repositoryPath, sessionStoreRoot: this.config.runtimeRoot, spoolPath, statusPath, ...settings, ...(options.imagePaths ? { imagePaths: options.imagePaths } : {}), ...(options.resumeSessionRef ? { resumeSessionRef: options.resumeSessionRef } : {}), ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}) };
    const prepared = await this.provider.prepareTurnWrapper(request, executionRoot);
    await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET spool_relative_path = ?, status_relative_path = ? WHERE id = ?").run(relative(this.config.runtimeRoot, prepared.spoolPath), relative(this.config.runtimeRoot, prepared.statusPath), executionId));
    return prepared;
  }

  private async recordLeadProcessStart(executionId: string, pid: number, fallback: string, inspection?: ProcessInspection): Promise<void> {
    if (this.processRunner === this.provider.processRunner && !inspection) throw new AgentFailure("ownership_ambiguous", "Codex wrapper identity could not be inspected at launch");
    const identity = inspection ? `${pid}:${inspection.startTime}` : await processStartIdentity(pid, fallback);
    const processGroup = inspection?.processGroup ?? pid;
    await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', wrapper_pid = ?, wrapper_process_group = ?, wrapper_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, processGroup, identity, this.now().toISOString(), executionId));
    if (this.processRunner !== this.provider.processRunner) {
      await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET process_start_identity = ? WHERE id = ?").run(identity, executionId));
    }
  }

  private async recordLeadChildStart(executionId: string, line: string): Promise<void> {
    let event: { type?: string; childPid?: number; childProcessGroup?: number; childStartIdentity?: string; child?: { pid?: number; processGroup?: number; startIdentity?: string } };
    try { event = JSON.parse(line) as typeof event; } catch { return; }
    const childPid = event.child?.pid ?? event.childPid;
    const childProcessGroup = event.child?.processGroup ?? event.childProcessGroup;
    const childStartIdentity = event.child?.startIdentity ?? event.childStartIdentity;
    if (event.type !== "forge.wrapper_started" || !childPid || !childProcessGroup || !childStartIdentity) return;
    const recorded = this.database.authQuery((db) => db.prepare("SELECT wrapper_process_group FROM forge_agent_executions WHERE id = ?").get(executionId) as { wrapper_process_group: number | null } | undefined);
    const inspection = await defaultProcessController.inspect(childPid);
    if (!inspection || inspection.processGroup !== childProcessGroup || (recorded?.wrapper_process_group !== null && recorded?.wrapper_process_group !== undefined && inspection.processGroup !== recorded.wrapper_process_group) || `${childPid}:${inspection.startTime}` !== childStartIdentity) {
      throw new AgentFailure("ownership_ambiguous", "Codex child ownership could not be verified");
    }
    await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(childPid, childStartIdentity, this.now().toISOString(), executionId));
  }

  private async ensureLeadSchema(): Promise<string> {
    const directory = join(this.config.runtimeRoot, "schemas");
    const filename = join(directory, "lead-output.schema.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(filename, JSON.stringify(CodexLeadOutputJsonSchema), { encoding: "utf8", mode: 0o600 });
    await chmod(filename, 0o600);
    return filename;
  }

  private async ensureDeliveryReviewSchema(): Promise<string> {
    const directory = join(this.config.runtimeRoot, "schemas");
    const filename = join(directory, "delivery-review.schema.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(filename, JSON.stringify(z.toJSONSchema(DeliveryReviewSchema)), { encoding: "utf8", mode: 0o600 });
    await chmod(filename, 0o600);
    return filename;
  }

  private async completedTurnResult(result: LeadProcessResult, wrapper: PreparedAgentTurnWrapper): Promise<LeadProcessResult> {
    if (result.exitCode === 0) return result;
    try {
      const status = JSON.parse(await readFile(wrapper.statusPath, "utf8")) as { state?: unknown; exitCode?: unknown };
      if (status.state === "completed" && status.exitCode === 0) return { ...result, exitCode: 0 };
    } catch { /* The observed process result remains authoritative when no terminal wrapper status exists. */ }
    return result;
  }

  private async repositoryEvidence(repositoryPath: string): Promise<string> {
    const [status, head] = await Promise.all([
      execFileAsync("git", ["status", "--short", "--branch"], { cwd: repositoryPath, timeout: 8_000, maxBuffer: 16 * 1024 }),
      execFileAsync("git", ["log", "-1", "--format=%H%n%s"], { cwd: repositoryPath, timeout: 8_000, maxBuffer: 4 * 1024 }),
    ]);
    return JSON.stringify({ status: redact(status.stdout), head: redact(head.stdout) });
  }

  private initialPrompt(title: string, brief: string, revision: string, profiles: ProfileSettings[], repositoryEvidence: string, revisionContext?: Record<string, unknown>): string {
    return `You are Forge's Lead planner. Work read-only in the provided repository. Do not modify files, reveal credentials, or invent provider facts.\n\nReturn exactly one JSON object matching one of these shapes:\n{"kind":"plan","summary":"...","gitPresentation":{"branchSlug":"short-kebab-case-purpose","pullRequestTitle":"Polished imperative title","pullRequestDescription":"One to three sentences explaining the change and why it matters."},"reproduction":null,"rootCauseAnalysis":null,"steps":[{"number":1,"instruction":"...","entryPoint":null,"completionCriterion":"...","verification":"...","verificationCommands":["exact command"]}],"compatibilityAnalysis":"...","operationalAnalysis":"...","verificationStrategy":"...","unresolvedTechnicalQuestions":[],"materialCategories":[],"affectedPaths":["path/to/affected/file"],"materiality":[{"category":"user_visible_behavior","rationale":"...","evidenceRefs":["step:1"]}],"preservedWorktreeCompatibility":null,"developerContext":{"includeTaskBrief":false,"evidenceArtifactIds":[],"imageArtifactIds":[],"repositoryInstructionPaths":[],"artifactStepNumbers":[]}}\n{"kind":"decision_blocker","category":"human_decision","summary":"...","evidence":"...","owner":"human","askUserQuestion":{"header":"Decision","id":"decision","question":"...","options":[{"label":"Best option (Recommended)","description":"Why this is the recommended choice."},{"label":"Alternative","description":"The tradeoff of this choice."},{"label":"Defer","description":"What remains blocked if this is chosen."}],"isOther":true,"isSecret":false},"nextAction":"...","resumePhase":"planning"}\nUse decision_blocker only for one unresolved human/business choice. Its askUserQuestion must follow Codex request_user_input semantics: always offer exactly three concrete, mutually exclusive recommendations that the member can select as written; never use a restatement of the blocker or a request for free-form input as an option. Put the strongest recommendation first and suffix its label with (Recommended); Forge adds the fourth Other free-text choice. A plan must have numbered prescriptive steps with exact verificationCommands, compatibility and operational analysis, a complete verification strategy, zero unresolved technical questions, a non-empty affectedPaths list naming repository-relative paths, materiality evidence whose categories and references are grounded in those paths or numbered steps, and developerContext as the complete Developer evidence allowlist. Every plan must also lock polished, developer-facing Git presentation: branchSlug is a concise lowercase kebab-case purpose with no issue, workflow, or other system identifier; pullRequestTitle is imperative and specific; pullRequestDescription is one to three useful sentences explaining what changes and why. Each artifactStepNumbers entry has artifactIdOrPath and stepNumbers. materialCategories must contain only categories directly implicated: architecture_dependencies, schema_data_migration, security_permissions, external_integration, production_operation, user_visible_behavior. For a revised reuse request, set preservedWorktreeCompatibility to true only when the preserved coordinates remain safe for the plan; otherwise set it to false and explain why in compatibilityAnalysis. Ordinary and new-worktree plans set it to null.\n\nTask: ${title}\nBrief:\n${brief}\n\nPinned Project revision:\n${revision}\n\nRole profile settings:\n${JSON.stringify(profiles)}\n\nRepository read evidence:\n${repositoryEvidence}${revisionContext ? `\n\nRevision request:\n${JSON.stringify(revisionContext)}` : ""}`;
  }

  private correctionPrompt(): string {
    return "Your previous Lead response did not satisfy the supplied output schema. Continue the same session, do not redo discovery, and return exactly one corrected JSON object matching that schema. Do not include markdown fences or commentary.";
  }

  private revisionPrompt(note: string): string {
    return `Continue the existing primary Lead session and reconsider the complete plan in response to this member request. Work read-only, preserve the issue scope, and return exactly one corrected JSON object matching the required plan or decision_blocker schema. Do not include markdown fences or commentary.\n\nMember revision request:\n${note}`;
  }

  private async persistEvidence(companyId: string, executionId: string, lines: string[]): Promise<StoredArtifact> {
    const content = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    return this.artifacts.put(companyId, "agent-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: content.length ? content : Buffer.from("{\"type\":\"empty\"}\n") });
  }

  private async completedPlanningResult(input: LeadPlanningActivityInput): Promise<LeadPlanningResult | undefined> {
    const persisted = this.database.authQuery((db) => db.prepare(`SELECT e.id AS executionId, e.session_ref AS sessionRef, o.output_artifact_id AS outputArtifactId, o.evidence_artifact_id AS evidenceArtifactId, o.summary,
        output.storage_path AS outputStoragePath, output.sha256 AS outputSha256, evidence.storage_path AS evidenceStoragePath, evidence.sha256 AS evidenceSha256
      FROM forge_agent_executions e
      JOIN forge_issue_outputs o ON o.execution_id = e.id AND o.task_id = e.task_id AND o.company_id = e.company_id AND o.workflow_id = e.workflow_id AND o.revision = e.workflow_revision
      JOIN forge_artifacts output ON output.id = o.output_artifact_id AND output.company_id = e.company_id
      JOIN forge_artifacts evidence ON evidence.id = o.evidence_artifact_id AND evidence.company_id = e.company_id
      WHERE e.id IS NOT NULL AND e.task_id = ? AND e.company_id = ? AND e.workflow_id = ? AND e.workflow_revision = ? AND e.turn_key = ? AND e.role = 'planner' AND e.status = 'completed'
      ORDER BY e.finished_at DESC LIMIT 1`).get(input.taskId, input.companyId, input.workflowId, input.revision, `${input.workflowId}:lead-planning:${input.revision}`) as {
        executionId: string;
        sessionRef: string;
        outputArtifactId: string;
        evidenceArtifactId: string;
        summary: string;
        outputStoragePath: string;
        outputSha256: string;
        evidenceStoragePath: string;
        evidenceSha256: string;
      } | undefined);
    if (!persisted) return undefined;
    if (!/^session_[A-Za-z0-9._:-]{1,128}$/.test(persisted.sessionRef)) throw new AgentFailure("internal_persistence", "The completed Lead session reference is invalid", { nonRetryable: true });
    await this.sessionStore.read(persisted.sessionRef);
    const output = PersistedLeadOutputSchema.parse(JSON.parse((await this.artifacts.read({ companyId: input.companyId, storagePath: persisted.outputStoragePath, sha256: persisted.outputSha256 })).toString("utf8")));
    await this.artifacts.read({ companyId: input.companyId, storagePath: persisted.evidenceStoragePath, sha256: persisted.evidenceSha256 });
    const manifest = this.database.authQuery((db) => db.prepare("SELECT id, sha256, storage_path FROM forge_artifacts WHERE company_id = ? AND kind = 'lead-input-manifest' AND filename = ?").get(input.companyId, `${persisted.executionId}.json`) as { id: string; sha256: string; storage_path: string } | undefined);
    if (!manifest) throw new AgentFailure("internal_persistence", "The completed Lead input manifest is unavailable", { nonRetryable: true });
    await this.artifacts.read({ companyId: input.companyId, storagePath: manifest.storage_path, sha256: manifest.sha256 });
    const categories = output.kind === "plan" ? classifyPlanMateriality(`${output.summary}\n${output.steps.map((step) => step.instruction).join("\n")}`, output.materialCategories) : [];
    const result: LeadPlanningResult = output.kind === "plan"
      ? { kind: "plan", leadOutputKind: "plan", leadSessionRef: persisted.sessionRef, leadExecutionId: persisted.executionId, leadEvidenceArtifactId: persisted.evidenceArtifactId, leadEvidenceSha256: persisted.evidenceSha256, leadOutputArtifactId: persisted.outputArtifactId, leadOutputSha256: persisted.outputSha256, leadInputManifestArtifactId: manifest.id, leadInputManifestSha256: manifest.sha256, leadSummary: persisted.summary, materialCategories: categories, material: categories.length > 0 }
      : { kind: "decision_blocker", leadOutputKind: "decision_blocker", leadSessionRef: persisted.sessionRef, leadExecutionId: persisted.executionId, leadEvidenceArtifactId: persisted.evidenceArtifactId, leadEvidenceSha256: persisted.evidenceSha256, leadOutputArtifactId: persisted.outputArtifactId, leadOutputSha256: persisted.outputSha256, leadInputManifestArtifactId: manifest.id, leadInputManifestSha256: manifest.sha256, leadSummary: persisted.summary, materialCategories: [], material: false, blockedCategory: "human_decision", unblockOwner: "human", resumePhase: "planning" };
    return result;
  }

  private runtimePath(relativePath: string | null): string {
    if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) throw new AgentFailure("ownership_ambiguous", "The active Lead runtime paths are unavailable");
    const root = resolve(this.config.runtimeRoot);
    const target = resolve(root, relativePath);
    const withinRoot = relative(root, target);
    if (withinRoot.startsWith(`..${sep}`) || withinRoot === "..") throw new AgentFailure("ownership_ambiguous", "The active Lead runtime paths are unsafe");
    return target;
  }

  private async attachPlanningResult(input: LeadPlanningActivityInput, active: ActiveLeadExecution, signal?: AbortSignal, wrapper?: ProcessInspection): Promise<LeadPlanningResult> {
    const spoolPath = this.runtimePath(active.spool_relative_path);
    const statusPath = this.runtimePath(active.status_relative_path);
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      try {
        const status = JSON.parse(await readFile(statusPath, "utf8")) as { state?: string; code?: string; error?: string };
        if (status.state === "completed") {
          const persisted = await this.completedPlanningResult(input);
          if (persisted) return persisted;
          const lines = (await readFile(spoolPath, "utf8")).split(/\r?\n/).filter(Boolean);
          const output = parseLeadOutput(lines, this.provider);
          const sessionRef = active.session_ref ?? lines.map((line) => this.provider.parseEvent(line).sessionRef).find((value): value is string => Boolean(value));
          if (!sessionRef) throw new AgentFailure("missing-session", "The active Lead turn completed without a session reference");
          await this.sessionStore.read(sessionRef);
          const artifacts = await this.persistOutput(input, active.id, sessionRef, lines, output);
          await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), artifacts.evidence.id, active.id));
          const manifest = this.database.authQuery((db) => db.prepare("SELECT id, sha256 FROM forge_artifacts WHERE company_id = ? AND kind = 'lead-input-manifest' AND filename = ?").get(input.companyId, `${active.id}.json`) as { id: string; sha256: string } | undefined);
          if (!manifest) throw new AgentFailure("internal_persistence", "The completed Lead input manifest is unavailable", { nonRetryable: true });
          Object.assign(artifacts.result, { leadInputManifestArtifactId: manifest.id, leadInputManifestSha256: manifest.sha256 });
          return artifacts.result;
        }
        if (status.state === "failed" || status.state === "cancelled") throw new AgentFailure(status.code ?? "process_exit", status.error ?? "The active Lead turn did not complete");
      } catch (error) {
        if (error instanceof AgentFailure) throw error;
      }
      if (signal?.aborted) {
        if (!wrapper) throw new AgentFailure("ownership_ambiguous", "The active Lead wrapper could not be safely cancelled");
        const owned = { name: `${this.provider.id}-wrapper`, pid: wrapper.pid, command: wrapper.command, startedAt: active.heartbeat_at ?? wrapper.startTime, processGroup: wrapper.processGroup, startTime: wrapper.startTime, executable: wrapper.executable, argv: wrapper.argv };
        if (!await this.provider.createTurnSupervisor(this.processController).cancelOwnedProcess(owned, wrapper)) throw new AgentFailure("ownership_ambiguous", "The active Lead wrapper could not be safely cancelled");
        const cancelledAt = this.now().toISOString();
        this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'cancelled', finished_at = ?, heartbeat_at = ?, failure_code = 'cancelled', failure_summary = ?, cancelled_at = ? WHERE id = ?").run(cancelledAt, cancelledAt, "The Codex Lead turn was cancelled.", cancelledAt, active.id));
        throw new AgentFailure("cancelled", "The Codex Lead turn was cancelled.", { nonRetryable: true });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new AgentFailure("active-lease", "A Lead execution is already active for this issue");
  }

  private async persistOutput(input: LeadPlanningActivityInput, executionId: string, sessionRef: string, lines: string[], output: LeadOutput, manifest?: { id: string; sha256: string }, options: { finalVersion?: number; originalPlanRevision?: number; supersedesOutputId?: string } = {}): Promise<{ evidence: StoredArtifact; result: LeadPlanningResult }> {
    const evidence = await this.persistEvidence(input.companyId, executionId, lines);
    const outputKind = output.kind === "plan" ? "lead-plan" : "decision-blocker";
    const outputArtifact = await this.artifacts.put(input.companyId, outputKind, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(output, null, 2), "utf8") });
    const categories = output.kind === "plan" ? classifyPlanMateriality(`${output.summary}\n${output.steps.map((step) => step.instruction).join("\n")}`, output.materialCategories, output.affectedPaths) : [];
    const summary = output.kind === "plan" ? `${output.summary} (${materialitySummary(categories)})` : output.summary;
    const outputId = `output_${randomBytes(12).toString("hex")}`;
    const materialityArtifact = output.kind === "plan" ? await this.artifacts.put(input.companyId, "materiality-evidence", { filename: `${executionId}-materiality.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, categories, affectedPaths: output.affectedPaths, evidence: output.materiality }), "utf8") }) : undefined;
    const finalVersion: 1 | 2 = options.finalVersion === 2 ? 2 : 1;
    const planSubject = manifest ? { companyId: input.companyId, issueId: input.taskId, workflowId: input.workflowId, originalPlanRevision: options.originalPlanRevision ?? input.revision + 1, outputId, outputRevision: input.revision, finalVersion, artifactId: outputArtifact.id, artifactSha256: outputArtifact.sha256, leadSessionRef: sessionRef, leadExecutionId: executionId, evidenceManifestArtifactId: manifest.id, evidenceManifestSha256: manifest.sha256 } as const : undefined;
    const materialityEvidence = materialityArtifact ? { categories, artifactId: materialityArtifact.id, artifactSha256: materialityArtifact.sha256 } as const : undefined;
    const blockerSubject = output.kind === "decision_blocker" && manifest ? { companyId: input.companyId, issueId: input.taskId, workflowId: input.workflowId, artifactId: outputArtifact.id, artifactSha256: outputArtifact.sha256, leadSessionRef: sessionRef, leadExecutionId: executionId, evidenceManifestArtifactId: manifest.id, evidenceManifestSha256: manifest.sha256, category: "human_decision" as const, resumePhase: "planning" as const } : undefined;
    this.database.authTransaction((db) => {
      db.prepare(`INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt,
        outputArtifact.id, outputArtifact.companyId, outputArtifact.kind, outputArtifact.filename, outputArtifact.mimeType, outputArtifact.byteSize, outputArtifact.sha256, outputArtifact.storagePath, outputArtifact.createdAt,
      );
      if (materialityArtifact) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(materialityArtifact.id, materialityArtifact.companyId, materialityArtifact.kind, materialityArtifact.filename, materialityArtifact.mimeType, materialityArtifact.byteSize, materialityArtifact.sha256, materialityArtifact.storagePath, materialityArtifact.createdAt);
    });
    if (planSubject && manifest) {
      new PlanGovernanceRepository(this.database).appendPlanVersion({ subject: planSubject, kind: output.kind, evidenceArtifactId: evidence.id, evidenceArtifactSha256: evidence.sha256, ...(materialityArtifact ? { materialityEvidenceArtifactId: materialityArtifact.id, materialityEvidenceSha256: materialityArtifact.sha256 } : {}), summary, ...(options.supersedesOutputId ? { supersedesOutputId: options.supersedesOutputId } : {}) });
    } else {
      this.database.authTransaction((db) => db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(outputId, input.taskId, input.companyId, input.workflowId, executionId, input.revision, output.kind, outputArtifact.id, evidence.id, sessionRef, summary, this.now().toISOString()));
    }
    const result: LeadPlanningResult = output.kind === "plan"
      ? { kind: "plan", leadSessionRef: sessionRef, leadExecutionId: executionId, leadEvidenceArtifactId: evidence.id, leadEvidenceArtifactSha256: evidence.sha256, leadEvidenceSha256: evidence.sha256, leadOutputArtifactId: outputArtifact.id, leadOutputArtifactSha256: outputArtifact.sha256, leadOutputSha256: outputArtifact.sha256, leadOutputKind: "plan", leadSummary: summary, materialCategories: categories, material: categories.length > 0, preservedWorktreeCompatibility: output.preservedWorktreeCompatibility, ...(planSubject ? { planSubject } : {}), ...(materialityEvidence ? { materialityEvidence } : {}) }
      : { kind: "decision_blocker", leadSessionRef: sessionRef, leadExecutionId: executionId, leadEvidenceArtifactId: evidence.id, leadEvidenceArtifactSha256: evidence.sha256, leadEvidenceSha256: evidence.sha256, leadOutputArtifactId: outputArtifact.id, leadOutputArtifactSha256: outputArtifact.sha256, leadOutputSha256: outputArtifact.sha256, leadOutputKind: "decision_blocker", leadSummary: summary, materialCategories: categories, material: false, blockedCategory: "human_decision", unblockOwner: "human", resumePhase: "planning", ...(blockerSubject ? { blockerSubject } : {}) };
    return { evidence, result };
  }
}

export function hashLeadOutput(output: LeadOutput): string {
  return createHash("sha256").update(JSON.stringify(output)).digest("hex");
}

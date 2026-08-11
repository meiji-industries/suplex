import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { ForgeConfig } from "./config.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { ForgeDatabase } from "./database.js";
import { redact } from "./logging.js";
import { PlanMaterialCategorySchema, classifyPlanMateriality, materialitySummary, type PlanMaterialCategory } from "./plan-governance.js";
import type { ConsolidateLeadPlanActivityInput, SupplementalReviewActivityInput, SupplementalReviewResult } from "./temporal/issue-contracts.js";

const execFileAsync = promisify(execFile);

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
}

export interface LeadInvocation {
  command: string;
  args: string[];
  cwd: string;
  onStart: (pid: number, startedAt: string) => Promise<void>;
  onLine: (line: string) => Promise<void>;
}

export interface LeadProcessResult {
  exitCode: number;
  stderr: string;
}

export type LeadProcessRunner = (invocation: LeadInvocation) => Promise<LeadProcessResult>;

export class AgentFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentFailure";
    this.code = code;
  }
}

export interface SessionStore {
  create(rawSessionId: string): Promise<string>;
  read(sessionRef: string): Promise<string>;
}

class FileSessionStore implements SessionStore {
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
    const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, stdio: ["ignore", "pipe", "pipe"] });
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

function failureCode(result: LeadProcessResult): string {
  if (/not logged in|login required|authentication required|unauthenticated|oauth authorization required/i.test(result.stderr)) return "login-expired";
  if (/rate[ -]?limit|too many requests|\b429\b/i.test(result.stderr)) return "rate-limited";
  if (/model .*not supported|unsupported model|invalid model/i.test(result.stderr)) return "model-unavailable";
  return result.exitCode === 0 ? "process-output-failed" : "process-exited";
}

async function taskScopedPath(root: string, candidate: string): Promise<string> {
  const absoluteRoot = await realpath(root);
  const absoluteCandidate = resolve(candidate);
  const relativePath = relative(absoluteRoot, absoluteCandidate);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") throw new AgentFailure("unsafe-working-directory", "Lead working directory is outside the configured repository root");
  return absoluteCandidate;
}

interface PlanningRow {
  title: string;
  repository_path: string;
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
    this.command = options.command ?? process.env.FORGE_CODEX_COMMAND ?? "codex";
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.sessionStore = options.sessionStore ?? new FileSessionStore(config.runtimeRoot);
    this.now = options.now ?? (() => new Date());
  }

  async runLeadPlanning(rawInput: LeadPlanningActivityInput): Promise<LeadPlanningResult> {
    const input = LeadPlanningActivityInputSchema.parse(rawInput);
    const row = this.database.authQuery((db) => db.prepare(`SELECT t.title, p.repository_path, r.normalized_json, b.storage_path AS brief_storage_path, b.sha256 AS brief_sha256
      FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_project_revisions r ON r.id = t.project_revision_id
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ? AND t.project_revision_id = ? AND b.id = ?`).get(input.taskId, input.companyId, input.projectId, input.workflowId, input.projectRevisionId, input.briefArtifactId) as PlanningRow | undefined);
    if (!row) throw new AgentFailure("scoped-input-missing", "Lead planning evidence is unavailable");
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(row.repository_path));
    const brief = (await this.artifacts.read({ storagePath: row.brief_storage_path, sha256: row.brief_sha256 })).toString("utf8");
    const images = this.database.authQuery((db) => {
      if (!input.imageArtifactIds.length) return [] as ImageRow[];
      const placeholders = input.imageArtifactIds.map(() => "?").join(",");
      return db.prepare(`SELECT storage_path, sha256, filename FROM forge_artifacts WHERE company_id = ? AND kind = 'task-image' AND id IN (${placeholders})`).all(input.companyId, ...input.imageArtifactIds) as ImageRow[];
    });
    if (images.length !== input.imageArtifactIds.length) throw new AgentFailure("scoped-input-missing", "Lead image evidence is unavailable");
    for (const image of images) await this.artifacts.read({ storagePath: image.storage_path, sha256: image.sha256 });
    const profileSettings = this.database.authQuery((db) => {
      const profileIds = Object.values(input.roleProfiles).filter((value): value is string => typeof value === "string");
      if (!profileIds.length) return [] as ProfileSettings[];
      const placeholders = profileIds.map(() => "?").join(",");
      return db.prepare(`SELECT id, name, provider, model, reasoning_level AS reasoningLevel, service_priority AS servicePriority, capacity FROM forge_profiles WHERE id IN (${placeholders})`).all(...profileIds) as ProfileSettings[];
    });
    if (!input.roleProfiles.lead) throw new AgentFailure("profile-unavailable", "Lead planning requires a configured Lead profile");
    const leadProfile = profileSettings.find((profile) => profile.id === input.roleProfiles.lead);
    if (!leadProfile || leadProfile.provider !== "codex") throw new AgentFailure("profile-unavailable", "The configured Lead profile is unavailable");
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
        const prompt = attempt === 0 ? this.initialPrompt(row.title, brief, row.normalized_json, profileSettings, repositoryEvidence) : this.correctionPrompt();
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
          lastFailure = new AgentFailure(failureCode(result), "Codex Lead execution did not complete");
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

  async runSupplementalReview(rawInput: SupplementalReviewActivityInput): Promise<SupplementalReviewResult> {
    const input = rawInput;
    const profile = this.database.authQuery((db) => db.prepare("SELECT id, model, provider FROM forge_profiles WHERE id = ?").get(input.roleProfiles.reviewer) as { id: string; model: string; provider: string } | undefined);
    if (!profile || profile.provider !== "codex") throw new AgentFailure("reviewer-profile-unavailable", "Supplemental review requires an allowed profile");
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, p.repository_path, r.normalized_json, b.storage_path AS brief_storage_path, b.sha256 AS brief_sha256, oa.storage_path AS output_storage_path, oa.sha256 AS output_sha256, e.storage_path AS evidence_storage_path, e.sha256 AS evidence_sha256
      FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_project_revisions r ON r.id = t.project_revision_id
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id JOIN forge_issue_outputs io ON io.task_id = t.id AND io.output_artifact_id = ?
      JOIN forge_artifacts oa ON oa.id = io.output_artifact_id JOIN forge_artifacts e ON e.id = io.evidence_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ? AND b.id = ?`).get(input.leadOutputArtifactId, input.taskId, input.companyId, input.projectId, input.projectRevisionId, input.briefArtifactId) as { title: string; repository_path: string; normalized_json: string; brief_storage_path: string; brief_sha256: string; output_storage_path: string; output_sha256: string; evidence_storage_path: string; evidence_sha256: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Supplemental review evidence is unavailable");
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(context.repository_path));
    const brief = (await this.artifacts.read({ storagePath: context.brief_storage_path, sha256: context.brief_sha256 })).toString("utf8");
    const draft = (await this.artifacts.read({ storagePath: context.output_storage_path, sha256: context.output_sha256 })).toString("utf8");
    const priorEvidence = (await this.artifacts.read({ storagePath: context.evidence_storage_path, sha256: context.evidence_sha256 })).toString("utf8");
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
          const event = eventValue(sanitized);
          if (event.threadId && !sessionRef) { rawSessionId = event.threadId; sessionRef = await this.sessionStore.create(rawSessionId); await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId)); }
          await this.databaseHeartbeat(executionId, "running");
        },
      });
      if (result.exitCode !== 0) throw new AgentFailure(failureCode(result), "Supplemental review did not complete");
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
    const draftText = (await this.artifacts.read(draft)).toString("utf8");
    const reviewText = (await this.artifacts.read(review)).toString("utf8");
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'lead', 'starting', 1, ?, ?)").run(executionId, rawInput.taskId, rawInput.companyId, rawInput.workflowId, rawInput.leadSessionRef, startedAt));
    const lines: string[] = [];
    const heartbeat = setInterval(() => void this.databaseHeartbeat(executionId, "running"), 5_000);
    try {
      const result = await this.processRunner({ command: this.command, args: ["exec", "resume", rawSessionId, "--json", "--skip-git-repo-check", this.consolidationPrompt(draftText, reviewText)], cwd: repositoryPath, onStart: async (pid, processStartedAt) => { await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running', process_pid = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, `${pid}:${processStartedAt}`, processStartedAt, executionId)); }, onLine: async (line) => { lines.push(safeJsonLine(line)); await this.databaseHeartbeat(executionId, "running"); } });
      if (result.exitCode !== 0) throw new AgentFailure(failureCode(result), "Lead consolidation did not complete");
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

  private reviewPrompt(title: string, brief: string, revision: string, draft: string, evidence: string): string {
    return `You are Forge's independent supplemental reviewer. Do not modify files, review implementation, or become the plan owner. Return exactly one JSON object: {"kind":"review","summary":"...","opinion":"approve"|"request_changes","concerns":[],"requiredChanges":[]}. Read the complete draft and scoped evidence below. Identify only concrete correctness, acceptance, security/privacy, compatibility, operational, or unintended-scope concerns.\n\nTask: ${title}\nBrief:\n${brief}\n\nPinned Project revision:\n${revision}\n\nDraft Lead plan:\n${draft}\n\nLead evidence:\n${evidence}`;
  }

  private consolidationPrompt(draft: string, review: string): string {
    return `Reconsider the complete Lead plan in this same session after an independent supplemental review. Return exactly one consolidated JSON plan or one decision_blocker matching the required schema. Preserve correct steps, address concrete review concerns, and do not leave unresolved technical questions. Do not include markdown fences or commentary.\n\nDraft plan:\n${draft}\n\nSupplemental review:\n${review}`;
  }

  private async consolidationRepositoryPath(input: ConsolidateLeadPlanActivityInput): Promise<string> {
    const row = this.database.authQuery((db) => db.prepare("SELECT p.repository_path FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ?").get(input.taskId, input.companyId, input.projectId, input.projectRevisionId) as { repository_path: string } | undefined);
    if (!row) throw new AgentFailure("scoped-input-missing", "Consolidation repository is unavailable");
    return taskScopedPath(this.config.repositoryRoot, await realpath(row.repository_path));
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

  private initialPrompt(title: string, brief: string, revision: string, profiles: ProfileSettings[], repositoryEvidence: string): string {
    return `You are Forge's Lead planner. Work read-only in the provided repository. Do not modify files, reveal credentials, or invent provider facts.\n\nReturn exactly one JSON object matching one of these shapes:\n{"kind":"plan","summary":"...","reproduction":null,"rootCauseAnalysis":null,"steps":[{"number":1,"instruction":"...","verification":"..."}],"compatibilityAnalysis":"...","operationalAnalysis":"...","verificationStrategy":"...","unresolvedTechnicalQuestions":[],"materialCategories":[]}\n{"kind":"decision_blocker","summary":"...","evidence":"...","owner":"human","question":"...","nextAction":"..."}\nUse decision_blocker only for one unresolved human/business choice. A plan must have numbered prescriptive steps, compatibility and operational analysis, a complete verification strategy, zero unresolved technical questions, and a materialCategories array containing only the categories directly implicated: architecture_dependencies, schema_data_migration, security_permissions, external_integration, production_operation, user_visible_behavior.\n\nTask: ${title}\nBrief:\n${brief}\n\nPinned Project revision:\n${revision}\n\nRole profile settings:\n${JSON.stringify(profiles)}\n\nRepository read evidence:\n${repositoryEvidence}`;
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
    return { evidence, result: { leadSessionRef: sessionRef, leadExecutionId: executionId, leadEvidenceArtifactId: evidence.id, leadOutputArtifactId: outputArtifact.id, leadOutputKind: output.kind, leadSummary: summary, materialCategories: categories, material: categories.length > 0 } };
  }
}

export function hashLeadOutput(output: LeadOutput): string {
  return createHash("sha256").update(JSON.stringify(output)).digest("hex");
}

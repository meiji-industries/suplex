import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { ForgeConfig } from "./config.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { AgentFailure, FileSessionStore, runCodexProcess, type LeadProcessResult, type LeadProcessRunner, type SessionStore } from "./codex-lead.js";
import { ForgeDatabase } from "./database.js";
import { redact } from "./logging.js";
import { createGitCommandGuard, WorktreeManager } from "./worktrees.js";
import type { DeveloperExecutionActivityInput, DeveloperExecutionResult } from "./temporal/issue-contracts.js";

const execFileAsync = promisify(execFile);

const ProjectRevisionSchema = z.object({ repositoryPath: z.string().min(1), worktreeRoot: z.string().min(1), targetBranch: z.string().min(1) });
const DeveloperDeliveryStepSchema = z.object({
  number: z.number().int().positive(),
  status: z.enum(["completed", "not_completed", "blocked"]),
  filesChanged: z.array(z.string().max(500)).max(128),
  commandsRun: z.array(z.string().max(500)).max(128),
  testResults: z.array(z.string().max(2_000)).max(64),
  notes: z.string().max(4_000),
});
export const DeveloperDeliveryReportSchema = z.object({
  kind: z.literal("delivery"),
  summary: z.string().min(1).max(2_000),
  steps: z.array(DeveloperDeliveryStepSchema).min(1).max(64),
  authorizedStepsNotCompleted: z.array(z.number().int().positive()).max(64),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().max(4_000).nullable(),
});

export type DeveloperDeliveryReport = z.infer<typeof DeveloperDeliveryReportSchema>;

interface DeveloperContext {
  title: string;
  repositoryPath: string;
  normalizedJson: string;
  briefStoragePath: string;
  briefSha256: string;
  planStoragePath: string;
  planSha256: string;
  evidenceStoragePath: string;
  evidenceSha256: string;
}

interface DeveloperProfile {
  id: string;
  model: string;
  provider: string;
}

interface PriorDeveloperExecution {
  id: string;
  status: string;
  branch_name: string;
  worktree_path: string;
  target_base_sha: string;
}

export interface DeveloperServiceOptions {
  command?: string;
  processRunner?: LeadProcessRunner;
  sessionStore?: SessionStore;
  worktrees?: WorktreeManager;
  now?: () => Date;
}

function safeJsonLine(line: string): string {
  try { return JSON.stringify(redact(JSON.parse(line))) ?? JSON.stringify({ type: "empty" }); } catch { return JSON.stringify({ type: "text", text: redact(line) }); }
}

function eventValue(line: string): { threadId?: string | undefined; message?: string | undefined } {
  try {
    const event = JSON.parse(line) as { thread_id?: unknown; threadId?: unknown; type?: unknown; item?: { type?: unknown; text?: unknown } };
    return {
      threadId: typeof event.thread_id === "string" ? event.thread_id : typeof event.threadId === "string" ? event.threadId : undefined,
      message: event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" ? event.item.text : undefined,
    };
  } catch { return {}; }
}

function parseDeliveryReport(lines: string[]): DeveloperDeliveryReport {
  const text = lines.map((line) => eventValue(line).message).filter((value): value is string => Boolean(value)).at(-1);
  if (!text) throw new AgentFailure("missing-delivery-report", "Codex Developer did not return a delivery report");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-delivery-report", "Codex Developer returned malformed delivery JSON"); }
  const report = DeveloperDeliveryReportSchema.safeParse(parsed);
  if (!report.success) throw new AgentFailure("invalid-delivery-report", "Codex Developer returned a delivery report outside the required schema");
  return report.data;
}

function processFailure(result: LeadProcessResult): string {
  if (/not logged in|login required|authentication required|unauthenticated|oauth authorization required/i.test(result.stderr)) return "login-expired";
  if (/rate[ -]?limit|too many requests|\b429\b/i.test(result.stderr)) return "rate-limited";
  if (/model .*not supported|unsupported model|invalid model/i.test(result.stderr)) return "model-unavailable";
  return result.exitCode === 0 ? "process-output-failed" : "process-exited";
}

function scopedRepository(root: string, candidate: string): Promise<string> {
  return Promise.all([realpath(root), realpath(candidate)]).then(([absoluteRoot, absoluteCandidate]) => {
    const path = relative(absoluteRoot, absoluteCandidate);
    if (path.startsWith(`..${sep}`) || path === "..") throw new AgentFailure("unsafe-working-directory", "Developer repository is outside the configured repository root");
    return absoluteCandidate;
  });
}

async function processStartIdentity(pid: number, fallback: string): Promise<string> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { maxBuffer: 4 * 1024 });
    const value = result.stdout.trim();
    return value ? `${pid}:${value}` : `${pid}:${fallback}`;
  } catch { return `${pid}:${fallback}`; }
}

export class DeveloperService {
  private readonly artifacts: ArtifactStore;
  private readonly command: string;
  private readonly processRunner: LeadProcessRunner;
  private readonly sessionStore: SessionStore;
  private readonly worktrees: WorktreeManager;
  private readonly now: () => Date;

  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig, options: DeveloperServiceOptions = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot);
    this.command = options.command ?? process.env.FORGE_CODEX_COMMAND ?? "codex";
    this.processRunner = options.processRunner ?? runCodexProcess;
    this.sessionStore = options.sessionStore ?? new FileSessionStore(config.runtimeRoot);
    this.worktrees = options.worktrees ?? new WorktreeManager();
    this.now = options.now ?? (() => new Date());
  }

  async run(rawInput: DeveloperExecutionActivityInput): Promise<DeveloperExecutionResult> {
    const input = rawInput;
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, p.repository_path AS repositoryPath, r.normalized_json AS normalizedJson, b.storage_path AS briefStoragePath, b.sha256 AS briefSha256, pa.storage_path AS planStoragePath, pa.sha256 AS planSha256, ea.storage_path AS evidenceStoragePath, ea.sha256 AS evidenceSha256
      FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_project_revisions r ON r.id = t.project_revision_id
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id JOIN forge_issue_outputs io ON io.output_artifact_id = ? AND io.task_id = t.id AND io.workflow_id = t.workflow_id
      JOIN forge_artifacts pa ON pa.id = io.output_artifact_id JOIN forge_artifacts ea ON ea.id = io.evidence_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ?`).get(input.leadOutputArtifactId, input.taskId, input.companyId, input.projectId, input.projectRevisionId) as DeveloperContext | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Authorized Lead delivery evidence is unavailable");
    const projectRevision = ProjectRevisionSchema.safeParse(JSON.parse(context.normalizedJson));
    if (!projectRevision.success) throw new AgentFailure("scoped-input-missing", "Pinned project execution configuration is unavailable");
    const repositoryPath = await scopedRepository(this.config.repositoryRoot, context.repositoryPath);
    const [brief, planText, leadEvidence] = await Promise.all([
      this.artifacts.read({ storagePath: context.briefStoragePath, sha256: context.briefSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.read({ storagePath: context.planStoragePath, sha256: context.planSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.read({ storagePath: context.evidenceStoragePath, sha256: context.evidenceSha256 }).then((bytes) => bytes.toString("utf8")),
    ]);
    const plan = JSON.parse(planText) as { kind?: unknown; steps?: Array<{ number: number; instruction: string; verification: string }> };
    if (plan.kind !== "plan" || !Array.isArray(plan.steps) || !plan.steps.length) throw new AgentFailure("plan-unavailable", "A final Lead plan is required before development");
    const profile = this.database.authQuery((db) => db.prepare("SELECT id, model, provider FROM forge_profiles WHERE id = ?").get(input.roleProfiles.developer) as DeveloperProfile | undefined);
    if (!profile || profile.provider !== "codex") throw new AgentFailure("developer-profile-unavailable", "Developer execution requires an allowed Codex profile");
    const prior = input.supersedesExecutionId ? this.database.authQuery((db) => db.prepare("SELECT id, status, branch_name, worktree_path, target_base_sha FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.supersedesExecutionId, input.taskId, input.companyId, input.workflowId) as PriorDeveloperExecution | undefined) : undefined;
    if (input.supersedesExecutionId && (!prior || !["interrupted", "cancelled", "failed"].includes(prior.status))) throw new AgentFailure("retry-not-available", "Only an interrupted or cancelled Developer attempt can be retried");
    const targetBaseSha = prior?.target_base_sha ?? (await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${projectRevision.data.targetBranch}`], { cwd: repositoryPath, timeout: 8_000, maxBuffer: 4 * 1024 })).stdout.trim();
    const branchName = `forge/issue/${input.taskId}`;
    const worktreeRoot = await scopedRepository(this.config.worktreeRoot, projectRevision.data.worktreeRoot);
    const attempt = Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, input.planRevision) as { attempt: number })).attempt) + 1;
    const executionId = `developer_${randomBytes(12).toString("hex")}`;
    let worktree;
    try {
      worktree = input.reuseWorktree ? await this.worktrees.reuse({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha, branchName }) : await this.worktrees.create({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha, branchName });
    } catch (error) {
      if (error instanceof Error && "code" in error) throw new AgentFailure(String((error as { code: string }).code), error.message);
      throw error;
    }
    const startedAt = this.now().toISOString();
    const wrapperId = `wrapper_${randomBytes(12).toString("hex")}`;
    let guard: Awaited<ReturnType<typeof createGitCommandGuard>> | undefined;
    guard = await createGitCommandGuard(this.config.runtimeRoot);
    this.database.authTransaction((db) => db.prepare(`INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, started_at, heartbeat_at, current_step) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(executionId, input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, worktree.branchName, worktree.worktreePath, worktree.targetBaseSha, wrapperId, guard!.directory, prior?.id ?? null, startedAt, startedAt));
    const prompt = this.prompt(context.title, brief, planText, leadEvidence, worktree);
    const evidenceLines = [JSON.stringify({ type: "forge.prompt", text: redact(prompt) })];
    let sessionRef: string | undefined;
    let rawSessionId: string | undefined;
    try {
      const heartbeat = setInterval(() => void this.heartbeat(executionId), 5_000);
      try {
        const result = await this.processRunner({
          command: this.command,
          args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "--model", profile.model, prompt],
          cwd: worktree.worktreePath,
          env: guard.env,
          detached: true,
          onStart: async (pid, processStartedAt) => { const identity = await processStartIdentity(pid, processStartedAt); await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running', process_pid = ?, process_group_id = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, pid, identity, this.now().toISOString(), executionId)); },
          onLine: async (line) => {
            const sanitized = safeJsonLine(line);
            evidenceLines.push(sanitized);
            const event = eventValue(line);
            if (event.threadId && !sessionRef) { rawSessionId = event.threadId; sessionRef = await this.sessionStore.create(rawSessionId); await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId)); }
            await this.heartbeat(executionId);
          },
        });
        if (result.exitCode !== 0) throw new AgentFailure(processFailure(result), "Codex Developer did not complete");
        if (!sessionRef || !rawSessionId || sessionRef === input.leadSessionRef) throw new AgentFailure("session-identity-conflict", "Developer session must be distinct from the Lead session");
        const report = parseDeliveryReport(evidenceLines);
        const gitState = await this.worktrees.inspectDelivery(worktree.worktreePath);
        if (gitState.branchName !== worktree.branchName || gitState.headSha === worktree.targetBaseSha) throw new AgentFailure("delivery-revision-invalid", "Developer delivery did not produce a new commit on the isolated issue branch");
        const expectedNumbers = plan.steps.map((step) => step.number).sort((a, b) => a - b);
        const actualNumbers = report.steps.map((step) => step.number).sort((a, b) => a - b);
        if (JSON.stringify(expectedNumbers) !== JSON.stringify(actualNumbers)) throw new AgentFailure("delivery-step-mismatch", "Developer delivery does not map every approved plan step");
        if (JSON.stringify(report.authorizedStepsNotCompleted.sort((a, b) => a - b)) !== JSON.stringify(report.steps.filter((step) => step.status !== "completed").map((step) => step.number).sort((a, b) => a - b))) throw new AgentFailure("delivery-step-mismatch", "Developer delivery did not identify incomplete authorized steps consistently");
        if (report.resultCommit.toLowerCase() !== gitState.headSha.toLowerCase() || report.resultTree.toLowerCase() !== gitState.treeSha.toLowerCase() || report.dirtyState !== gitState.dirtyState) throw new AgentFailure("delivery-revision-mismatch", "Developer delivery report does not match the exact Git result");
        const deliveryArtifact = await this.artifacts.put(input.companyId, "developer-delivery", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ ...report, branchName: worktree.branchName, worktreePath: worktree.worktreePath, targetBaseSha: worktree.targetBaseSha }, null, 2), "utf8") });
        const evidence = await this.persistEvidence(input.companyId, evidenceLines);
        const blocked = report.authorizedStepsNotCompleted.length > 0 || report.dirtyState !== "clean" || report.blocker !== null;
        this.database.authTransaction((db) => {
          db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, deliveryArtifact.id, deliveryArtifact.companyId, deliveryArtifact.kind, deliveryArtifact.filename, deliveryArtifact.mimeType, deliveryArtifact.byteSize, deliveryArtifact.sha256, deliveryArtifact.storagePath, deliveryArtifact.createdAt);
          db.prepare("UPDATE forge_developer_executions SET status = ?, session_ref = ?, finished_at = ?, heartbeat_at = ?, current_step = ?, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?").run(blocked ? "blocked" : "completed", sessionRef, this.now().toISOString(), this.now().toISOString(), report.steps.at(-1)?.number ?? null, gitState.headSha, gitState.treeSha, gitState.dirtyState, deliveryArtifact.id, evidence.id, executionId);
        });
        return { developerExecutionId: executionId, developerSessionRef: sessionRef, worktreePath: worktree.worktreePath, branchName: worktree.branchName, targetBaseSha: worktree.targetBaseSha, currentStep: report.steps.at(-1)?.number ?? null, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState, deliveryArtifactId: deliveryArtifact.id, evidenceArtifactId: evidence.id, deliverySummary: report.summary, outcome: blocked ? "blocked" : "completed" };
      } finally { clearInterval(heartbeat); }
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("developer-failed", "Codex Developer execution failed");
      const evidence = await this.persistEvidence(input.companyId, evidenceLines);
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_developer_executions SET status = 'failed', session_ref = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(sessionRef ?? null, this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId);
      });
      throw failure;
    } finally { await guard?.cleanup(); }
  }

  private prompt(title: string, brief: string, plan: string, evidence: string, worktree: { branchName: string; worktreePath: string; targetBaseSha: string }): string {
    return `You are Forge's authenticated Developer. Execute the authorized Lead plan prescriptively in the isolated worktree only. Do not redesign the plan, expand scope, modify the target repository, use GitHub or any provider, push, create a pull request, merge, rebase, amend, reset, clean, or rewrite history. If the repository contradicts the authorized plan, stop before unrelated edits and report a blocker. You may edit files in this worktree, run safe local verification, and create ordinary local commits. Before finishing, ensure the worktree is clean and return exactly one JSON object with no markdown fences or commentary matching: {"kind":"delivery","summary":"...","steps":[{"number":1,"status":"completed","filesChanged":[],"commandsRun":[],"testResults":[],"notes":"..."}],"authorizedStepsNotCompleted":[],"resultCommit":"40+ hex","resultTree":"40+ hex","dirtyState":"clean","blocker":null}. Include every approved step number exactly once, concrete files, commands, test outcomes, exact resulting commit/tree, and any incomplete authorized step.

Task: ${title}
Brief:
${brief}

Authorized final Lead plan:
${plan}

Prior scoped Lead evidence:
${evidence}

Execution coordinates:
${JSON.stringify(worktree)}`;
  }

  private async heartbeat(executionId: string): Promise<void> {
    this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(this.now().toISOString(), executionId));
  }

  private async persistEvidence(companyId: string, lines: string[]): Promise<StoredArtifact> {
    const content = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    return this.artifacts.put(companyId, "agent-evidence", { filename: `developer_${randomBytes(12).toString("hex")}.jsonl`, mimeType: "application/x-ndjson", bytes: content.length ? content : Buffer.from("{\"type\":\"empty\"}\n") });
  }
}

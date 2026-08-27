import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";

import type { z } from "zod";

import { AgentFailure } from "./agent-failure.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { sanitizeCodexLine } from "./codex-rollout-sanitizer.js";
import {
  discoverRollout,
  parseRolloutChunk,
  rolloutCandidatePaths,
  type NeutralTimelineEvent,
} from "./codex-rollout.js";
import type { ForgeDatabase } from "./database.js";
import { HerdrFailure, type HerdrClient } from "./herdr-client.js";
import type { IssueTimelineEvents } from "./issue-timeline-events.js";
import type { EnsuredRoleSession, HerdrSessionStore, RoleSessionRole } from "./herdr-session-store.js";
import { redact } from "./logging.js";
import { jsonRequired } from "./task-utils.js";

type Role = RoleSessionRole;
type ExecutionRole = "planner" | "reviewer" | "builder" | "integrator";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const iso = () => new Date().toISOString();
const responseStyleBlock = `Forge response style
- Use ASD-STE100 Simplified Technical English for all human-readable prose.
- In normal prose fields and public progress messages, write short, direct, unambiguous sentences and use consistent terms.
- Do not alter required JSON keys, enum values, identifiers, paths, commands, code, quoted text, or schema-required formats.
- Do not claim ASD-STE100 certification or force vocabulary that makes accurate technical output impossible.`;

export interface HerdrTurnInput<T> {
  task: { taskId: string; projectId: string; projectSlug: string; issueKey?: string; worktreePath: string; runtimeRoot: string };
  sessionRole: Role; executionRole: ExecutionRole; ledger: "agent" | "developer"; executionId: string; promptKind: string; prompt: string;
  profile: { model: string; reasoningLevel: string; servicePriority: string }; resultSchema: z.ZodType<T>; schemaPath: string;
  companyId: string; workflowId: string; revision: number; signal?: AbortSignal | undefined;
}
export interface HerdrTurnOutput<T> { turnId: string; sessionId: string; roleSessionId: string; result: T; resultHash: string; }
interface Completion { marker: boolean; codexTurnId?: string; completed: boolean; steeredAfterCompletion: boolean; resultVersion?: string | undefined; rolloutEndOffset?: number; }
const artifactChunkBytes = 512 * 1024;

/** Result-file completion for a single interactive Codex turn. Pane text is never a result. */
export class HerdrTurnRunner {
  constructor(
    private readonly database: ForgeDatabase,
    private readonly herdr: HerdrClient,
    private readonly sessions: HerdrSessionStore,
    private readonly timeline: IssueTimelineEvents,
    private readonly artifacts?: ArtifactStore,
    private readonly candidates: () => Promise<string[]> = rolloutCandidatePaths,
    private readonly sleep: (ms: number) => Promise<void> = delay,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run<T>(input: HerdrTurnInput<T>): Promise<HerdrTurnOutput<T>> {
    let session: EnsuredRoleSession | undefined;
    let turnId: string | undefined;
    try {
      let correction = 0;
      let validationIssues: string | undefined;
      session = await this.ensure(input);
      for (;;) {
        turnId = this.turnId(input, correction);
        const existing = this.existingTurn(input, correction);
        const resumed = existing?.promptSentAt ? existing : undefined;
        const resultPath = existing
          ? this.existingResultPath(input, existing.resultRelativePath)
          : this.resultPath(input, turnId);
        const marker = `[forge-turn:${turnId}]`;
        const prompt = this.dispatchPrompt(marker, resultPath, input.schemaPath, input.prompt, validationIssues);
        if (resumed?.status === "completed") {
          const bytes = await this.stableResult(resultPath, undefined, resumed.promptSentAt, false);
          if (!bytes) throw new AgentFailure("recovery-result-invalid", "The completed Forge turn has no stable schema-valid result", { nonRetryable: true });
          const parsed = input.resultSchema.safeParse(jsonRequired(bytes.toString("utf8")));
          if (!parsed.success) throw new AgentFailure("recovery-result-invalid", "The completed Forge turn has no stable schema-valid result", { nonRetryable: true });
          return { turnId, sessionId: session.codexSessionId!, roleSessionId: session.id, result: parsed.data, resultHash: resumed.resultHash ?? hash(bytes) };
        }
        if (!resumed) {
          if (!existing) {
            await mkdir(dirname(resultPath), { recursive: true, mode: 0o700 });
            await this.quarantine(resultPath);
            this.create(turnId, input, session, resultPath, correction, prompt);
          }
          const candidates = session.codexSessionId ? undefined : [...(await this.candidates())];
          const start = await this.offset(session.rolloutPath);
          this.update("UPDATE forge_herdr_turns SET rollout_start_offset = ?, rollout_cursor_offset = ?, status = 'dispatching', updated_at = ? WHERE turn_id = ?", start, start, iso(), turnId);
          await this.herdr.prompt(session.agentName, prompt);
          session = await this.resolveIdentity(session, input, turnId, candidates);
          const promptSentAt = this.now().toISOString();
          this.update("UPDATE forge_herdr_turns SET prompt_sent_at = ?, status = 'waiting', updated_at = ? WHERE turn_id = ?", promptSentAt, promptSentAt, turnId);
        }
        const completion = await this.wait(input, session, turnId, marker, resultPath, prompt, input.signal, resumed && await this.recoverCompletion(input, session, turnId, marker, resultPath));
        const bytes = await this.stableResult(resultPath, completion.resultVersion, this.promptSentAt(turnId), completion.steeredAfterCompletion);
        if (!bytes) continue;
        const parsed = input.resultSchema.safeParse(jsonRequired(bytes.toString("utf8")));
        if (parsed.success) {
          const resultHash = hash(bytes);
          const rollout = await this.snapshot(input, session, turnId, completion);
          this.clearAttention(session.id, turnId);
          this.update("UPDATE forge_herdr_turns SET result_sha256 = ?, task_complete_seen_at = ?, codex_turn_id = ?, rollout_artifact_id = ?, status = 'completed', finished_at = ?, updated_at = ? WHERE turn_id = ?", resultHash, iso(), completion.codexTurnId ?? null, rollout?.id ?? null, iso(), iso(), turnId);
          return { turnId, sessionId: session.codexSessionId!, roleSessionId: session.id, result: parsed.data, resultHash };
        }
        if (correction >= 1) throw new AgentFailure("invalid-output-schema", "The interactive role result does not satisfy its advertised schema", { nonRetryable: true });
        this.update("UPDATE forge_herdr_turns SET status = 'correction_required', updated_at = ? WHERE turn_id = ?", iso(), turnId);
        validationIssues = this.excerpt(JSON.stringify(parsed.error.issues));
        correction += 1;
      }
    } catch (error) {
      if (error instanceof HerdrFailure) throw new AgentFailure(error.code, error.message, { nonRetryable: !error.retryable });
      throw error;
    } finally {
      if (input.sessionRole === "reviewer" && session) await this.closeReviewer(session).catch(() => undefined);
      if (session && turnId) this.clearAttention(session.id, turnId);
    }
  }

  private async wait(input: HerdrTurnInput<unknown>, session: EnsuredRoleSession, turnId: string, marker: string, resultPath: string, prompt: string, signal?: AbortSignal, recovered?: Completion): Promise<Completion> {
    const completion: Completion = recovered ?? { marker: false, completed: false, steeredAfterCompletion: false };
    let activeTurnId: string | undefined;
    let polls = 0;
    let idlePolls = 0;
    let resends = 0;
    let executionActive = true;
    for (;;) {
      if (signal?.aborted || polls % 5 === 0 && !(executionActive = this.heartbeat(input)))
        throw new AgentFailure("cancelled", "The interactive Codex turn was cancelled.", { nonRetryable: true });
      polls += 1;
      const drained = await this.drain(input, session, turnId);
      for (const event of drained.events) activeTurnId = await this.reduceCompletion(completion, activeTurnId, event, marker, resultPath);
      const live = await this.herdr.getAgent(session.agentName);
      if (!live) {
        session = await this.ensure(input);
        if (!completion.marker && !signal?.aborted && executionActive && this.interruptedGeneration(turnId) !== session.generation) {
          await this.herdr.prompt(session.agentName, prompt);
          this.update("UPDATE forge_herdr_turns SET interrupted_generation = ?, interrupted_prompt_sent_at = ?, updated_at = ? WHERE turn_id = ?", session.generation, iso(), iso(), turnId);
        }
        continue;
      }
      if (live.status === "blocked") {
        await this.updateAttention(session, turnId, "blocked", await this.blockedExcerpt(session));
      } else if (live.status === "working") {
        idlePolls = 0;
        this.clearAttention(session.id, turnId, "working");
      }
      const stable = completion.completed && await this.stableResult(
          resultPath,
          completion.resultVersion,
          this.promptSentAt(turnId),
          completion.steeredAfterCompletion,
        );
      if (stable) return completion;
      if (live.status === "idle" || live.status === "done") {
        if (!completion.marker) {
          const resendAfter = [15_000, 30_000, 60_000][resends];
          const sentAt = Date.parse(this.promptSentAt(turnId) ?? "");
          if (resends < 3 && (!Number.isFinite(sentAt) || this.now().getTime() - sentAt >= resendAfter!)) {
            await this.herdr.prompt(session.agentName, prompt);
            const now = this.now().toISOString();
            this.update("UPDATE forge_herdr_turns SET prompt_sent_at = ?, updated_at = ? WHERE turn_id = ?", now, now, turnId);
            resends += 1;
          } else if (resends >= 3) {
            await this.updateAttention(session, turnId, "awaiting_human", "Prompt was not accepted by the agent after 4 attempts");
          }
        } else {
          const excerpt = completion.completed
            ? `Finished without writing ${resultPath}`
            : ++idlePolls >= 2
              ? `Agent remained ${live.status} without writing ${resultPath}`
              : await this.questionExcerpt(input, session, turnId);
          if (excerpt) await this.updateAttention(session, turnId, "awaiting_human", excerpt);
        }
      } else {
        idlePolls = 0;
      }
      await this.sleep(1_000);
    }
  }

  private async resolveIdentity(
    session: EnsuredRoleSession,
    input: HerdrTurnInput<unknown>,
    turnId: string,
    before?: string[],
  ): Promise<EnsuredRoleSession> {
    if (session.codexSessionId) return session;
    const baseline = new Set(before);
    let ambiguous = false;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const live = await this.herdr.getAgent(session.agentName);
      const paths = await this.candidates();
      const reported = live?.agentSession;
      try {
        const rollout = await discoverRollout(paths, {
          cwd: input.task.worktreePath,
          ...(reported ? { sessionId: reported } : { before: baseline }),
        });
        this.bindIdentity(session.id, rollout.sessionId, rollout.path);
        return {
          ...session,
          codexSessionId: rollout.sessionId,
          rolloutPath: rollout.path,
          live: live ?? session.live,
        };
      } catch (error) {
        if (error instanceof AgentFailure) throw error;
        if (
          error instanceof Error &&
          error.message === "Codex rollout identity is ambiguous"
        )
          ambiguous = true;
      }
      if (!reported) {
        try {
          const rollout = await discoverRollout(paths, {
            cwd: input.task.worktreePath,
            marker: `[forge-turn:${turnId}]`,
          });
          this.bindIdentity(session.id, rollout.sessionId, rollout.path);
          return {
            ...session,
            codexSessionId: rollout.sessionId,
            rolloutPath: rollout.path,
            live: live ?? session.live,
          };
        } catch (error) {
          if (error instanceof AgentFailure) throw error;
        }
      }
      await this.sleep(2_000);
    }
    throw new AgentFailure(
      ambiguous ? "session-identity-ambiguous" : "session-identity-missing",
      "Codex did not create one identifiable rollout after the first prompt",
    );
  }

  private bindIdentity(id: string, sessionId: string, rolloutPath: string): void {
    const changed = this.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET codex_session_id = ?, rollout_path = ?, status = 'ready', updated_at = ? WHERE id = ? AND (codex_session_id IS NULL OR codex_session_id = ?)",
        )
        .run(sessionId, rolloutPath, iso(), id, sessionId).changes,
    );
    if (changed !== 1)
      throw new AgentFailure(
        "session-identity-conflict",
        "The durable role session has a different Codex identity",
        { nonRetryable: true },
      );
  }

  private async drain(input: HerdrTurnInput<unknown>, session: EnsuredRoleSession, turnId: string) {
    if (!session.rolloutPath) return { events: [] as ReturnType<typeof parseRolloutChunk>["events"] };
    const source = await readFile(session.rolloutPath).catch(() => Buffer.alloc(0));
    const row = this.database.authQuery((db) => db.prepare("SELECT rollout_cursor_offset FROM forge_herdr_turns WHERE turn_id = ?").get(turnId) as { rollout_cursor_offset: number } | undefined);
    const offset = row?.rollout_cursor_offset ?? 0;
    const parsed = parseRolloutChunk({ sessionId: session.codexSessionId!, forgeTurnId: turnId, executionId: input.executionId, executionRole: input.executionRole, offset }, source.subarray(offset).toString("utf8"));
    this.timeline.insert({ taskId: input.task.taskId, companyId: input.companyId, workflowId: input.workflowId, runId: null, revision: input.revision }, session.id, offset, parsed.events);
    if (parsed.offset > offset) this.update("UPDATE forge_herdr_turns SET rollout_cursor_offset = ?, updated_at = ? WHERE turn_id = ?", parsed.offset, iso(), turnId);
    return parsed;
  }

  private turnId(input: HerdrTurnInput<unknown>, correction: number): string { return `turn_${hash(`${input.executionId}\0${input.promptKind}\0${correction}`).slice(0, 32)}`; }
  private resultPath(input: HerdrTurnInput<unknown>, turnId: string): string { return join(input.task.runtimeRoot, "herdr-results", input.task.taskId, input.sessionRole, `result-${turnId}.json`); }
  private dispatchPrompt(marker: string, path: string, schema: string, taskPrompt: string, validationIssues?: string): string {
    return `${this.completionBlock(marker, path, schema)}${validationIssues ? `\n\nYour previous result file failed schema validation. Correct these issues:\n${validationIssues}` : ""}\n\n${responseStyleBlock}\n\n${taskPrompt}`;
  }
  private completionBlock(marker: string, path: string, schema: string): string { return `${marker}\n\nForge completion contract\n- Atomically write exactly one JSON object to ${path} (write a sibling temp file, then rename).\n- The object must satisfy ${schema}; no Markdown fence or commentary belongs in the file.\n- Do not say the task is complete until the result file exists.`; }
  private async ensure(input: HerdrTurnInput<unknown>): Promise<EnsuredRoleSession> { return this.sessions.ensureRoleSession(input.task, input.sessionRole, { model: input.profile.model, reasoningLevel: input.profile.reasoningLevel, serviceTier: input.profile.servicePriority === "fast" ? "fast" : input.profile.servicePriority === "priority" ? "priority" : "default" }); }
  private existingTurn(input: HerdrTurnInput<unknown>, correction: number): { resultRelativePath: string; status: string; promptSentAt: string | undefined; resultHash: string | undefined } | undefined {
    return this.database.authQuery((db) => db.prepare(
      "SELECT result_relative_path AS resultRelativePath, status, prompt_sent_at AS promptSentAt, result_sha256 AS resultHash FROM forge_herdr_turns WHERE ledger = ? AND execution_id = ? AND prompt_kind = ? AND correction_index = ? AND task_id = ? AND role_session_id = ?",
    ).get(input.ledger, input.executionId, input.promptKind, correction, input.task.taskId, this.roleSessionId(input)) as { resultRelativePath: string; status: string; promptSentAt: string | undefined; resultHash: string | undefined } | undefined);
  }
  private roleSessionId(input: HerdrTurnInput<unknown>): string {
    const session = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(input.task.taskId, input.sessionRole) as { id: string } | undefined);
    if (!session) throw new AgentFailure("recovery-session-missing", "The durable role session is missing", { nonRetryable: true });
    return session.id;
  }
  private existingResultPath(input: HerdrTurnInput<unknown>, value: string): string {
    const path = join(input.task.runtimeRoot, value);
    if (relative(input.task.runtimeRoot, path).startsWith("..")) throw new AgentFailure("recovery-result-path-invalid", "The durable result path is outside the Forge runtime", { nonRetryable: true });
    return path;
  }
  private async recoverCompletion(input: HerdrTurnInput<unknown>, session: EnsuredRoleSession, turnId: string, marker: string, resultPath: string): Promise<Completion> {
    const row = this.database.authQuery((db) => db.prepare("SELECT rollout_start_offset FROM forge_herdr_turns WHERE turn_id = ?").get(turnId) as { rollout_start_offset: number } | undefined);
    const source = session.rolloutPath ? await readFile(session.rolloutPath).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    const parsed = parseRolloutChunk({ sessionId: session.codexSessionId!, forgeTurnId: turnId, executionId: input.executionId, executionRole: input.executionRole, offset: row?.rollout_start_offset ?? 0 }, source.subarray(row?.rollout_start_offset ?? 0).toString("utf8"));
    const completion: Completion = { marker: false, completed: false, steeredAfterCompletion: false };
    let activeTurnId: string | undefined;
    for (const event of parsed.events) activeTurnId = await this.reduceCompletion(completion, activeTurnId, event, marker, resultPath);
    return completion;
  }
  private async reduceCompletion(completion: Completion, activeTurnId: string | undefined, event: NeutralTimelineEvent, marker: string, resultPath: string): Promise<string | undefined> {
    const data = event.data;
    if (event.kind === "turn_started" && typeof data.turnId === "string") {
      activeTurnId = data.turnId;
      if (completion.marker) {
        completion.codexTurnId = data.turnId;
        completion.completed = false;
        completion.resultVersion = undefined;
      }
    }
    if (event.kind === "message" && data.role === "human" && typeof data.text === "string" && data.text.includes(marker)) {
      completion.marker = true;
      completion.steeredAfterCompletion = false;
      if (activeTurnId) completion.codexTurnId = activeTurnId;
    }
    if (completion.codexTurnId && event.kind === "turn_finished" && data.turnId === completion.codexTurnId) {
      if (data.error === true) throw new AgentFailure("turn-failed", "The interactive Codex turn completed with an error");
      completion.completed = true;
      completion.steeredAfterCompletion = false;
      completion.resultVersion = await this.resultVersion(resultPath);
      completion.rolloutEndOffset = event.sourceOffset;
    }
    if (event.kind === "turn_finished" && data.turnId === activeTurnId) activeTurnId = undefined;
    if (completion.completed && event.kind === "message" && data.role === "human" && (typeof data.text !== "string" || !data.text.includes(marker))) {
      completion.steeredAfterCompletion = true;
      delete completion.codexTurnId;
      completion.completed = false;
      completion.resultVersion = undefined;
    }
    return activeTurnId;
  }
  private create(turnId: string, input: HerdrTurnInput<unknown>, session: EnsuredRoleSession, path: string, correction: number, prompt: string): void { this.update("INSERT OR IGNORE INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_path, correction_index, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)", turnId, input.task.taskId, session.id, input.executionRole, input.ledger, input.executionId, input.promptKind, hash(prompt), relative(input.task.runtimeRoot, path), session.rolloutPath ?? null, correction, iso(), iso()); }
  private update(sql: string, ...values: unknown[]): void { this.database.authQuery((db) => db.prepare(sql).run(...values)); }
  private heartbeat(input: HerdrTurnInput<unknown>): boolean {
    const table = input.ledger === "agent" ? "forge_agent_executions" : "forge_developer_executions";
    return this.database.authQuery((db) =>
      db.prepare(`UPDATE ${table} SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')`).run(iso(), input.executionId).changes === 1,
    );
  }
  private async snapshot(input: HerdrTurnInput<unknown>, session: EnsuredRoleSession, turnId: string, completion: Completion): Promise<StoredArtifact | undefined> {
    if (!this.artifacts || !session.rolloutPath || completion.rolloutEndOffset === undefined) return undefined;
    const row = this.database.authQuery((db) => db.prepare("SELECT rollout_start_offset FROM forge_herdr_turns WHERE turn_id = ?").get(turnId) as { rollout_start_offset: number } | undefined);
    const source = await readFile(session.rolloutPath);
    const bytes = this.sanitizeRange(source.subarray(row?.rollout_start_offset ?? 0, completion.rolloutEndOffset));
    const chunks: StoredArtifact[] = [];
    for (let offset = 0; offset < bytes.length; offset += artifactChunkBytes) chunks.push(await this.putContentAddressed(input, "herdr-rollout-chunk", gzipSync(bytes.subarray(offset, offset + artifactChunkBytes)), "application/gzip"));
    const manifest = Buffer.from(JSON.stringify({ version: 1, sessionId: session.codexSessionId!, forgeTurnId: turnId, startOffset: row?.rollout_start_offset ?? 0, endOffset: completion.rolloutEndOffset, chunks: chunks.map(({ id, sha256, byteSize }) => ({ id, sha256, byteSize })) }), "utf8");
    return this.putContentAddressed(input, "herdr-rollout-manifest", manifest, "application/json");
  }
  private sanitizeRange(bytes: Buffer): Buffer {
    return Buffer.from(bytes.toString("utf8").split(/(?<=\n)/).filter(Boolean).map((line) => {
      try {
        const outer = jsonRequired(line.trimEnd());
        if (outer && typeof outer === "object" && "payload" in outer) {
          const payload = jsonRequired(sanitizeCodexLine(JSON.stringify(outer.payload)));
          return `${JSON.stringify({ ...outer, payload })}\n`;
        }
        return `${sanitizeCodexLine(line.trimEnd())}\n`;
      } catch { return `${sanitizeCodexLine(line.trimEnd())}\n`; }
    }).join(""), "utf8");
  }
  private async putContentAddressed(input: HerdrTurnInput<unknown>, kind: string, bytes: Buffer, mimeType: string): Promise<StoredArtifact> {
    const sha256 = hash(bytes);
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, company_id AS companyId, kind, filename, mime_type AS mimeType, byte_size AS byteSize, sha256, storage_path AS storagePath, created_at AS createdAt FROM forge_artifacts WHERE company_id = ? AND kind = ? AND sha256 = ? ORDER BY created_at LIMIT 1").get(input.companyId, kind, sha256) as StoredArtifact | undefined);
    if (existing) return existing;
    return this.artifacts!.putWithId(input.companyId, `artifact_${kind}_${sha256}`, kind, { filename: `${sha256}.${mimeType === "application/gzip" ? "jsonl.gz" : "json"}`, mimeType, bytes, taskId: input.task.taskId });
  }
  private async closeReviewer(session: EnsuredRoleSession): Promise<void> {
    await this.herdr.closePane(session.paneId);
    this.update("UPDATE forge_herdr_role_sessions SET pane_id = NULL, status = 'closed', is_current = 0, updated_at = ? WHERE id = ? AND codex_session_id = ?", iso(), session.id, session.codexSessionId);
  }
  private interruptedGeneration(turnId: string): number | undefined { return this.database.authQuery((db) => (db.prepare("SELECT interrupted_generation FROM forge_herdr_turns WHERE turn_id = ?").get(turnId) as { interrupted_generation: number | null } | undefined)?.interrupted_generation ?? undefined); }
  private async blockedExcerpt(session: EnsuredRoleSession): Promise<string | undefined> {
    if (!this.herdr.readAgent) return undefined;
    const output = await this.herdr.readAgent(session.agentName).catch(() => "");
    return this.excerpt(output);
  }
  private async questionExcerpt(input: HerdrTurnInput<unknown>, session: EnsuredRoleSession, turnId: string): Promise<string | undefined> {
    if (!session.rolloutPath || !session.codexSessionId) return undefined;
    const source = await readFile(session.rolloutPath).catch(() => Buffer.alloc(0));
    const row = this.database.authQuery((db) => db.prepare("SELECT rollout_start_offset FROM forge_herdr_turns WHERE turn_id = ?").get(turnId) as { rollout_start_offset: number } | undefined);
    const parsed = parseRolloutChunk({ sessionId: session.codexSessionId, forgeTurnId: turnId, executionId: input.executionId, executionRole: input.executionRole, offset: row?.rollout_start_offset ?? 0 }, source.subarray(row?.rollout_start_offset ?? 0).toString("utf8"));
    const messages = parsed.events.filter((event) => event.kind === "message" && event.data.role === "agent" && typeof event.data.text === "string");
    const message = messages.at(-1)?.data.text;
    return typeof message === "string" && this.isQuestion(message) ? this.excerpt(message) : undefined;
  }
  private isQuestion(message: string): boolean {
    const last = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
    return last.endsWith("?") || /(?:^|\n)\s*(?:question|options?)\s*:/i.test(message);
  }
  private excerpt(value: string): string | undefined {
    const sanitized = String(redact(value)).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    return sanitized || undefined;
  }
  private async updateAttention(session: EnsuredRoleSession, turnId: string, status: "blocked" | "awaiting_human", excerpt: string | undefined): Promise<void> {
    this.database.authQuery((db) => {
      const now = iso();
      const current = db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns WHERE turn_id = ?").get(turnId) as { status: string; attention_excerpt: string | null } | undefined;
      if (current?.status === status && current.attention_excerpt === (excerpt ?? null)) return;
      db.prepare("UPDATE forge_herdr_turns SET status = ?, attention_excerpt = ?, updated_at = ? WHERE turn_id = ?").run(status, excerpt ?? null, now, turnId);
      db.prepare("UPDATE forge_herdr_role_sessions SET status = ?, attention_activated_at = COALESCE(attention_activated_at, ?), updated_at = ? WHERE id = ?").run(status === "blocked" ? "blocked" : "ready", now, now, session.id);
    });
  }
  private clearAttention(sessionId: string, turnId: string, status: "working" | "waiting" = "waiting"): void {
    this.database.authQuery((db) => {
      const active = db.prepare("SELECT 1 FROM forge_herdr_turns WHERE turn_id = ? AND status IN ('blocked', 'awaiting_human')").get(turnId);
      const now = iso();
      if (active) db.prepare("UPDATE forge_herdr_turns SET status = ?, attention_excerpt = NULL, updated_at = ? WHERE turn_id = ? AND status IN ('blocked', 'awaiting_human')").run(status === "working" ? "waiting" : status, now, turnId);
      db.prepare("UPDATE forge_herdr_role_sessions SET status = ?, attention_activated_at = NULL, updated_at = ? WHERE id = ? AND status <> 'closed'").run(status === "working" ? "working" : "ready", now, sessionId);
    });
  }
  private async offset(path?: string): Promise<number> { return path ? (await stat(path).catch(() => ({ size: 0 }))).size : 0; }
  private async quarantine(path: string): Promise<void> { if (await stat(path).then(() => true).catch(() => false)) await rename(path, `${path}.quarantine-${randomUUID()}`); }
  private async resultVersion(path: string): Promise<string | undefined> { const item = await stat(path).catch(() => undefined); return item?.isFile() ? `${item.ino}:${item.size}:${item.mtimeMs}` : undefined; }
  private promptSentAt(turnId: string): string | undefined {
    return this.database.authQuery((db) => (
      db.prepare("SELECT prompt_sent_at FROM forge_herdr_turns WHERE turn_id = ?").get(turnId) as
        | { prompt_sent_at: string | null }
        | undefined
    )?.prompt_sent_at ?? undefined);
  }
  private async stableResult(
    path: string,
    completionVersion: string | undefined,
    promptSentAt: string | undefined,
    steeredAfterCompletion: boolean,
  ): Promise<Buffer | undefined> {
    const first = await stat(path).catch(() => undefined);
    if (!first?.isFile() || steeredAfterCompletion) return undefined;
    const version = `${first.ino}:${first.size}:${first.mtimeMs}`;
    if (
      completionVersion
        ? version !== completionVersion
        : !promptSentAt || first.mtimeMs <= Date.parse(promptSentAt)
    ) return undefined;
    await delay(250);
    return version === await this.resultVersion(path) ? readFile(path).catch(() => undefined) : undefined;
  }
}
const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

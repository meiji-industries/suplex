import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeSessionBusy } from "./claude-code-task-runtime.js";
import { claudeConfigDirectory, claudeExecution, claudeMessageEntries, claudeUsage, findClaudeTranscript, parseJsonLines, readClaudeTranscript } from "./claude-code-transcript.js";
import type { TaskSession } from "./task-control.js";
import { taskSessionRuntimeDirectory, type NativeSessionReader } from "./task-harness.js";
import type { ModelPricingCatalog } from "./model-pricing.js";

export class ClaudeCodeSessionReader implements NativeSessionReader {
  constructor(private readonly databasePath: string, private readonly configDirectory = claudeConfigDirectory()) {}

  private sessionID(session: TaskSession): string {
    if (!session.nativeSessionId) throw new Error("Session is not available");
    return session.nativeSessionId;
  }

  private busy(session: TaskSession): Promise<boolean> {
    return claudeSessionBusy(taskSessionRuntimeDirectory(this.databasePath, session.id));
  }

  async execution(session: TaskSession) {
    return { ...claudeExecution(await readClaudeTranscript(this.sessionID(session), this.configDirectory)), limited: false };
  }

  async turnEvidence(session: TaskSession, turnId: string) {
    this.sessionID(session);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(turnId)) throw new Error("Invalid task turn identity");
    const path = join(taskSessionRuntimeDirectory(this.databasePath, session.id), `turn-${turnId}.jsonl`);
    const tools = claudeExecution(claudeMessageEntries(parseJsonLines(await readFile(path, "utf8")))).tools;
    return { tools, limitation: null };
  }

  async status(session: TaskSession) {
    const transcript = await findClaudeTranscript(this.sessionID(session), this.configDirectory);
    const updatedAt = (await stat(transcript ?? join(taskSessionRuntimeDirectory(this.databasePath, session.id), "turn.json"))).mtimeMs;
    return { status: await this.busy(session) ? "busy" as const : "idle" as const, updatedAt };
  }

  async timeline(session: TaskSession, pricing?: ModelPricingCatalog) {
    const sessionID = this.sessionID(session);
    const usage = claudeUsage(await readClaudeTranscript(sessionID, this.configDirectory), sessionID, session.kind, pricing);
    const live = await this.busy(session) ? usage.at(-1) : undefined;
    if (live) live.completedAt = null;
    return { usage, liveMessageId: live?.messageId ?? null };
  }

  async archive(session: TaskSession) {
    if (await this.busy(session)) throw new Error("An agent is still active. Retry after it stops.");
    return { stop: async () => {} };
  }
}

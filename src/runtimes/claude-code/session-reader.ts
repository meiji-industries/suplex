import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeSessionBusy } from "./task-runtime.js";
import { claudeConfigDirectory, claudeExecution, claudeHistoryMessages, claudeMessageEntries, claudeUsage, findClaudeTranscript, parseJsonLines } from "./transcript.js";
import type { TaskSession } from "../../tasks/control.js";
import { taskSessionRuntimeDirectory, type NativeSessionReader } from "../task-harness.js";
import type { ModelPricingCatalog } from "../../profiles/model-pricing.js";
import { providerInstanceDirectories } from "../../profiles/provider-instances.js";

export class ClaudeCodeSessionReader implements NativeSessionReader {
  constructor(private readonly databasePath: string, private readonly configDirectory = claudeConfigDirectory()) {}
  private directory(session: TaskSession): string { return session.profile?.instanceHomeDirectory ?? this.configDirectory; }
  private async transcript(session: TaskSession): Promise<string | null> {
    const sessionID = this.sessionID(session);
    const direct = await findClaudeTranscript(sessionID, this.directory(session));
    if (direct) return direct;
    for (const directory of await providerInstanceDirectories(this.databasePath)) {
      const transcript = await findClaudeTranscript(sessionID, directory);
      if (transcript) return transcript;
    }
    return null;
  }
  private async entries(session: TaskSession) {
    const transcript = await this.transcript(session);
    if (!transcript) throw new Error("Claude Code session transcript is not available");
    return claudeMessageEntries(parseJsonLines(await readFile(transcript, "utf8")));
  }

  private sessionID(session: TaskSession): string {
    if (!session.nativeSessionId) throw new Error("Session is not available");
    return session.nativeSessionId;
  }

  private busy(session: TaskSession): Promise<boolean> {
    return claudeSessionBusy(taskSessionRuntimeDirectory(this.databasePath, session.id));
  }

  async history(session: TaskSession) {
    if (!session.nativeSessionId) return [];
    return claudeHistoryMessages(await this.entries(session));
  }

  async execution(session: TaskSession) {
    return { ...claudeExecution(await this.entries(session)), limited: false };
  }

  async turnEvidence(session: TaskSession, turnId: string) {
    this.sessionID(session);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(turnId)) throw new Error("Invalid task turn identity");
    const path = join(taskSessionRuntimeDirectory(this.databasePath, session.id), `turn-${turnId}.jsonl`);
    const tools = claudeExecution(claudeMessageEntries(parseJsonLines(await readFile(path, "utf8")))).tools;
    return { tools, limitation: null };
  }

  async status(session: TaskSession) {
    const transcript = await this.transcript(session);
    const updatedAt = (await stat(transcript ?? join(taskSessionRuntimeDirectory(this.databasePath, session.id), "turn.json"))).mtimeMs;
    return { status: await this.busy(session) ? "busy" as const : "idle" as const, updatedAt };
  }

  async timeline(session: TaskSession, pricing?: ModelPricingCatalog) {
    const sessionID = this.sessionID(session);
    const usage = claudeUsage(await this.entries(session), sessionID, session.kind, pricing);
    const live = await this.busy(session) ? usage.at(-1) : undefined;
    if (live) live.completedAt = null;
    return { usage, liveMessageId: live?.messageId ?? null };
  }

  async archive(session: TaskSession) {
    if (await this.busy(session)) throw new Error("An agent is still active. Retry after it stops.");
    return { stop: async () => {} };
  }
}

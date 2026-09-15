import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeSessionBusy } from "./task-runtime.js";
import { claudeConfigDirectory, claudeExecution, claudeMessageEntries, claudeUsage, findClaudeTranscript, parseJsonLines } from "./transcript.js";
import type { TaskSession } from "../../tasks/control.js";
import { taskSessionRuntimeDirectory, type NativeSessionReader } from "../task-harness.js";
import type { ModelPricingCatalog } from "../../profiles/model-pricing.js";
import { providerInstanceDirectories } from "../../profiles/provider-instances.js";
import { ClaudeLiveHistory } from "./live-history.js";

export class ClaudeCodeSessionReader implements NativeSessionReader {
  private readonly liveHistory = new Map<string, ClaudeLiveHistory>();
  private readonly transcripts = new Map<string, string>();
  constructor(private readonly databasePath: string, private readonly configDirectory = claudeConfigDirectory()) {}
  private directory(session: TaskSession): string { return session.profile?.instanceHomeDirectory ?? this.configDirectory; }
  private async transcript(session: TaskSession): Promise<string | null> {
    const sessionID = this.sessionID(session);
    const cached = this.transcripts.get(sessionID);
    if (cached) {
      try { await stat(cached); return cached; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        this.transcripts.delete(sessionID);
      }
    }
    const direct = await findClaudeTranscript(sessionID, this.directory(session));
    if (direct) {
      this.transcripts.set(sessionID, direct);
      return direct;
    }
    for (const directory of await providerInstanceDirectories(this.databasePath)) {
      const transcript = await findClaudeTranscript(sessionID, directory);
      if (transcript) {
        this.transcripts.set(sessionID, transcript);
        return transcript;
      }
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
    let reader = this.liveHistory.get(session.id);
    if (!reader) {
      reader = new ClaudeLiveHistory(taskSessionRuntimeDirectory(this.databasePath, session.id));
      this.liveHistory.set(session.id, reader);
    }
    return reader.read(await this.transcript(session));
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

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModelPricingCatalog } from "../../profiles/model-pricing.js";
import type { TaskSession } from "../../tasks/control.js";
import { headlessTurnRunning, readHeadlessTurnRecord } from "../headless/turn-process.js";
import { taskSessionRuntimeDirectory, type NativeSessionReader } from "../task-harness.js";
import { codexSessionBusy } from "./task-runtime.js";
import { codexHistory, codexTools, codexUsage, parseCodexEvents, type CodexTurn } from "./transcript.js";

export class CodexSessionReader implements NativeSessionReader {
  constructor(private readonly databasePath: string) {}

  private directory(session: Pick<TaskSession, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, session.id);
  }

  // `TaskSession` carries no model on the analytics path, and no Codex event
  // reports one, so each turn's dispatched `-m` value is the authoritative
  // record; a session's profile can change between turns.
  private async models(directory: string, names: readonly string[]): Promise<Map<string, string>> {
    const records = await Promise.all(names.filter(name => /^dispatch-.+\.json$/.test(name))
      .map(name => readHeadlessTurnRecord(join(directory, name)).catch(() => null)));
    return new Map(records.flatMap(record => {
      if (!record) return [];
      const dispatchArguments = record.dispatchArguments ?? record.processIdentity.argv;
      const position = dispatchArguments.indexOf("-m");
      return [[record.turnId, position >= 0 ? dispatchArguments[position + 1] ?? "unknown" : "unknown"] as const];
    }));
  }

  private async turns(session: Pick<TaskSession, "id">): Promise<CodexTurn[]> {
    const directory = this.directory(session);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const models = await this.models(directory, names);
    return Promise.all(names.filter(name => /^turn-[A-Za-z0-9._:-]+\.jsonl$/.test(name)).map(async name => {
      const id = name.slice(5, -6);
      return {
        id,
        model: models.get(id) ?? "unknown",
        events: parseCodexEvents(await readFile(join(directory, name), "utf8")),
        updatedAt: Math.trunc((await stat(join(directory, name))).mtimeMs),
      };
    }));
  }

  async history(session: TaskSession) {
    return codexHistory(await this.turns(session));
  }

  async execution(session: TaskSession) {
    const turns = await this.turns(session);
    // Codex item ids restart at item_0 each turn, so the session view namespaces them.
    return { tools: turns.flatMap(turn => codexTools(turn.events).map(tool => ({ ...tool, id: `${turn.id}:${tool.id}` }))), plan: null, limited: false };
  }

  async turnEvidence(session: TaskSession, turnId: string) {
    const path = join(this.directory(session), `turn-${turnId}.jsonl`);
    try {
      return { tools: codexTools(parseCodexEvents(await readFile(path, "utf8"))), limitation: null };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { tools: [], limitation: "The native turn log is missing" };
      throw error;
    }
  }

  async status(session: TaskSession) {
    const path = join(this.directory(session), "turn.json");
    const updatedAt = (await stat(path)).mtimeMs;
    return { status: await codexSessionBusy(this.directory(session)) ? "busy" as const : "idle" as const, updatedAt };
  }

  async timeline(session: Pick<TaskSession, "id" | "nativeSessionId" | "kind">, pricing?: ModelPricingCatalog) {
    if (!session.nativeSessionId) throw new Error("Session is not available");
    const directory = this.directory(session);
    const turns = await this.turns(session);
    if (!turns.length) throw new Error("Codex turn logs are missing");
    const usage = codexUsage(turns, session.nativeSessionId, session.kind, pricing);
    const current = await readHeadlessTurnRecord(join(directory, "turn.json"));
    const liveMessageId = current?.sessionID === session.nativeSessionId && await headlessTurnRunning(current) ? current.turnId : null;
    const live = usage.find(entry => entry.messageId === liveMessageId);
    if (live) live.completedAt = null;
    return { usage, liveMessageId };
  }

  async archive(session: TaskSession) {
    if (await codexSessionBusy(this.directory(session))) throw new Error("An agent is still active. Retry after it stops.");
    return { stop: async () => {} };
  }
}

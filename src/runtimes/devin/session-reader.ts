import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModelPricingCatalog } from "../../profiles/model-pricing.js";
import type { TaskSession } from "../../tasks/control.js";
import { taskSessionRuntimeDirectory, type NativeSessionReader } from "../task-harness.js";
import { headlessTurnFiles, headlessTurnRunning, readHeadlessText, readHeadlessTurnRecord, type HeadlessTurnRecord } from "../headless/turn-process.js";
import { devinSessionBusy } from "./task-runtime.js";
import { devinHistory, devinResultText, devinUsage, type DevinTurn } from "./transcript.js";
import { readDevinAdvisorEvidence } from "./advisor-evidence.js";

async function fileStat(path: string): Promise<Stats | null> {
  try { return await stat(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}

function createdAt(file: Stats): number {
  return Math.trunc(file.birthtimeMs > 0 ? file.birthtimeMs : file.mtimeMs);
}

export class DevinSessionReader implements NativeSessionReader {
  constructor(private readonly databasePath: string) {}

  private directory(session: Pick<TaskSession, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, session.id);
  }

  private async turns(session: Pick<TaskSession, "id" | "nativeSessionId" | "kind">): Promise<DevinTurn[]> {
    const directory = this.directory(session);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const ids = new Set(names.flatMap(name => {
      const match = /^turn-([A-Za-z0-9._:-]+)\.(?:jsonl|prompt|exit)$/.exec(name);
      return match ? [match[1]!] : [];
    }));
    const records = new Map<string, { record: HeadlessTurnRecord; createdAt: number }[]>();
    for (const name of names.filter(name => /^dispatch-[0-9a-f-]+\.json$/.test(name))) {
      const path = join(directory, name);
      const [record, metadata] = await Promise.all([readHeadlessTurnRecord(path), fileStat(path)]);
      if (!record || !metadata || record.sessionID !== session.nativeSessionId) continue;
      ids.add(record.turnId);
      const turns = records.get(record.turnId) ?? [];
      turns.push({ record, createdAt: createdAt(metadata) });
      records.set(record.turnId, turns);
    }
    const turns = await Promise.all([...ids].map(async id => {
      const files = headlessTurnFiles(directory, id);
      const [prompt, log, exit, output, exitText] = await Promise.all([
        fileStat(files.prompt), fileStat(files.log), fileStat(files.exit), readHeadlessText(files.log), readHeadlessText(files.exit),
      ]);
      const dispatches = records.get(id) ?? [];
      const running = (await Promise.all(dispatches.map(({ record }) => headlessTurnRunning(record)))).some(Boolean);
      const startedAt = prompt ? createdAt(prompt) : dispatches.length ? Math.min(...dispatches.map(value => value.createdAt)) : log ? createdAt(log) : exit ? createdAt(exit) : null;
      if (startedAt === null) return null;
      const completedAt = !running && exit && exitText !== null ? Math.trunc(exit.mtimeMs) : null;
      return { id, text: devinResultText(output ?? ""), textAt: Math.trunc(log?.mtimeMs ?? startedAt), startedAt, completedAt, failed: completedAt !== null && exitText?.trim() !== "0", running };
    }));
    return turns.filter((turn): turn is DevinTurn => turn !== null).sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  }

  async history(session: TaskSession) {
    return devinHistory(await this.turns(session));
  }

  async execution(_session: TaskSession) {
    return { tools: [], plan: null, limited: true };
  }

  async turnEvidence(session: TaskSession, turnId: string) {
    return readDevinAdvisorEvidence(this.directory(session), turnId);
  }

  async status(session: TaskSession) {
    const path = join(this.directory(session), "turn.json");
    const updatedAt = (await stat(path)).mtimeMs;
    return { status: await devinSessionBusy(this.directory(session)) ? "busy" as const : "idle" as const, updatedAt };
  }

  async timeline(session: Pick<TaskSession, "id" | "nativeSessionId" | "kind">, _pricing?: ModelPricingCatalog) {
    if (!session.nativeSessionId) throw new Error("Session is not available");
    const turns = await this.turns(session);
    return { usage: devinUsage(turns, session.nativeSessionId, session.kind), liveMessageId: turns.find(turn => turn.running)?.id ?? null };
  }

  async archive(session: TaskSession) {
    if (await devinSessionBusy(this.directory(session))) throw new Error("An agent is still active. Retry after it stops.");
    return { stop: async () => {} };
  }
}

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModelPricingCatalog } from "../../profiles/model-pricing.js";
import type { TaskSession } from "../../tasks/control.js";
import { taskSessionRuntimeDirectory, type NativeSessionReader } from "../task-harness.js";
import { devinSessionBusy } from "./task-runtime.js";
import { devinHistory, devinResultText, devinUsage } from "./transcript.js";

export class DevinSessionReader implements NativeSessionReader {
  constructor(private readonly databasePath: string) {}

  private directory(session: Pick<TaskSession, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, session.id);
  }

  private async turns(session: Pick<TaskSession, "id" | "nativeSessionId" | "kind">) {
    const directory = this.directory(session);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(names.filter(name => /^turn-[A-Za-z0-9._:-]+\.jsonl$/.test(name)).map(async name => ({
      id: name.slice(5, -6),
      text: devinResultText(await readFile(join(directory, name), "utf8")),
      updatedAt: Math.trunc((await stat(join(directory, name))).mtimeMs),
    })));
  }

  async history(session: TaskSession) {
    return devinHistory(await this.turns(session));
  }

  async execution(_session: TaskSession) {
    return { tools: [], plan: null, limited: true };
  }

  async turnEvidence(_session: TaskSession, _turnId: string) {
    return { tools: [], limitation: "Devin CLI --print does not document machine-readable tool evidence." };
  }

  async status(session: TaskSession) {
    const path = join(this.directory(session), "turn.json");
    const updatedAt = (await stat(path)).mtimeMs;
    return { status: await devinSessionBusy(this.directory(session)) ? "busy" as const : "idle" as const, updatedAt };
  }

  async timeline(session: Pick<TaskSession, "id" | "nativeSessionId" | "kind">, _pricing?: ModelPricingCatalog) {
    if (!session.nativeSessionId) throw new Error("Session is not available");
    const usage = devinUsage(await this.turns(session), session.nativeSessionId, session.kind);
    const live = await devinSessionBusy(this.directory(session)) ? usage.at(-1) : undefined;
    if (live) live.completedAt = null;
    return { usage, liveMessageId: live?.messageId ?? null };
  }

  async archive(session: TaskSession) {
    if (await devinSessionBusy(this.directory(session))) throw new Error("An agent is still active. Retry after it stops.");
    return { stop: async () => {} };
  }
}

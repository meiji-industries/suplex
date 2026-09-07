import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ForgeConfig } from "../config.js";
import type { ForgeDatabase } from "../database.js";
import { TaskControlStore } from "../root-session-store.js";
import { nativeSessionReader } from "../task-harness-registry.js";

export async function inspectTask(config: ForgeConfig, database: ForgeDatabase, taskId: string, includeAllHistory = false) {
  const store = new TaskControlStore(database);
  const control = store.get(taskId);
  const metadata = database.authQuery(db => z.object({ title: z.string() }).parse(db.prepare("SELECT title FROM forge_tasks WHERE id = ?").get(taskId)));
  const sessions = await Promise.all(store.sessions(taskId).map(async session => {
    try {
      if (!session.nativeSessionId) return { session, native: null };
      const observed = await nativeSessionReader(config.databasePath, session).status(session);
      return { session, native: { id: session.nativeSessionId, status: observed.status } };
    } catch (error) {
      return { session, native: null, error: error instanceof Error ? error.message : "Native session is not available" };
    }
  }));
  const turns = store.turns(taskId);
  return { taskId, title: metadata.title, control, sessions, turns: includeAllHistory ? turns : turns.slice(-30) };
}

export type TaskDiagnostic = Awaited<ReturnType<typeof inspectTask>>;

export function formatTaskDiagnostic(value: TaskDiagnostic): string {
  return [
    `TASK ${value.taskId}: ${value.title}`,
    `status      ${value.control.status}`,
    `question    ${value.control.humanQuestion ?? "none"}`,
    `worktree    ${value.control.worktree?.path ?? "none"}`,
    ...value.sessions.map(({ session, native }) => `${session.kind.padEnd(11)} ${session.nativeSessionId ?? "reserved"} ${native?.status ?? "not observed"}`),
    `turns       ${value.turns.length}`,
    "",
  ].join("\n");
}

export async function writeTaskBundle(config: ForgeConfig, database: ForgeDatabase, taskId: string): Promise<string> {
  const diagnostic = await inspectTask(config, database, taskId, true);
  const directory = join(config.dataRoot, "bundles");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, `${taskId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`);
  await writeFile(filename, JSON.stringify(diagnostic, null, 2), { mode: 0o600, flag: "wx" });
  return filename;
}

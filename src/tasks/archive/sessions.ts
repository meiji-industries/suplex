import type { TaskSession } from "../control.js";
import { inspectProcessOnce } from "../../platform/process-manager.js";
import { openCodeProcessAlive } from "../../runtimes/opencode/server.js";
import { prepareArchiveDisplays } from "./displays.js";
import { nativeSessionReader } from "../../runtimes/task-harness-registry.js";

export async function stopIdleArchiveSessions(databasePath: string, sessions: TaskSession[]): Promise<() => Promise<void>> {
  const prepared = [];
  for (const session of sessions) {
    if (session.launchOwnerPid !== null && openCodeProcessAlive(session.launchOwnerPid)) {
      const owner = await inspectProcessOnce(session.launchOwnerPid);
      if (!owner || !session.launchOwnerStartTime || owner.startTime === session.launchOwnerStartTime) throw new Error("A task session operation is still active. Retry after it stops.");
    }
    prepared.push({ ...session, ...await nativeSessionReader(databasePath, session).archive(session) });
  }
  const closeDisplays = await prepareArchiveDisplays(prepared);
  for (const { stop } of prepared) await stop();
  return closeDisplays;
}

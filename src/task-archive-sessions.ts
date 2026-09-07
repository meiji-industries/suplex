import type { TaskSession } from "./task-control.js";
import { inspectProcessOnce } from "./process-manager.js";
import { openCodeProcessAlive } from "./opencode-server.js";
import { prepareArchiveDisplays } from "./task-archive-displays.js";
import { nativeSessionReader } from "./task-harness-registry.js";

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

import type { TaskSession } from "../control.js";
import { inspectProcessOnce } from "../../platform/process-manager.js";
import { openCodeProcessAlive } from "../../runtimes/opencode/server.js";
import { prepareArchiveDisplays } from "./displays.js";
import { nativeSessionReader } from "../../runtimes/task-harness-registry.js";
import { taskShellPaneBinding } from "../../runtimes/task-display.js";

export async function stopIdleArchiveSessions(databasePath: string, taskId: string, sessions: TaskSession[], shellPaneId: string | null = null): Promise<() => Promise<void>> {
  const prepared = [];
  for (const session of sessions) {
    if (session.launchOwnerPid !== null && openCodeProcessAlive(session.launchOwnerPid)) {
      const owner = await inspectProcessOnce(session.launchOwnerPid);
      if (owner && session.launchOwnerStartTime && owner.startTime === session.launchOwnerStartTime) throw new Error("A task session operation is still active. Retry after it stops.");
    }
    prepared.push({ ...session, ...await nativeSessionReader(databasePath, session).archive(session) });
  }
  // The Shell is not a native session; it joins display cleanup as a record
  // whose binding id is the stable shell token.
  const displays = [...prepared, { id: taskShellPaneBinding(taskId), taskId, paneId: shellPaneId, nativeSessionId: null }];
  const closeDisplays = await prepareArchiveDisplays(displays);
  for (const { stop } of prepared) await stop();
  return closeDisplays;
}

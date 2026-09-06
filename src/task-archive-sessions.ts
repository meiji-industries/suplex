import { dirname, join } from "node:path";
import type { TaskSession } from "./task-control.js";
import { inspectProcessOnce } from "./process-manager.js";
import { openCodeProcessAlive, openCodeServerClient, readOpenCodeServer, stopOpenCodeServer } from "./opencode-server.js";
import { prepareArchiveDisplays } from "./task-archive-displays.js";

export async function stopIdleArchiveSessions(databasePath: string, sessions: TaskSession[]): Promise<() => Promise<void>> {
  const servers = [];
  for (const session of sessions) {
    if (session.launchOwnerPid !== null && openCodeProcessAlive(session.launchOwnerPid)) {
      const owner = await inspectProcessOnce(session.launchOwnerPid);
      if (!owner || !session.launchOwnerStartTime || owner.startTime === session.launchOwnerStartTime) throw new Error("A task session operation is still active. Retry after it stops.");
    }
    const server = await readOpenCodeServer(join(dirname(databasePath), "runtime", "task-sessions", session.id));
    if (!server && session.nativeSessionId) throw new Error("The task server identity is missing. Confirm that its commands have stopped before cleanup.");
    if (server && openCodeProcessAlive(server.pid)) {
      const statuses = await openCodeServerClient(server).getStatus(server.directory);
      if (Object.values(statuses).some(status => status.type !== "idle")) throw new Error("An agent is still active. Retry after it stops.");
    }
    servers.push({ ...session, server });
  }
  const closeDisplays = await prepareArchiveDisplays(servers);
  for (const { server } of servers) if (server) await stopOpenCodeServer(server);
  return closeDisplays;
}

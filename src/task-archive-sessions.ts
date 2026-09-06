import { dirname, join, basename } from "node:path";
import type { TaskSession } from "./task-control.js";
import { inspectProcessOnce } from "./process-manager.js";
import { openCodeProcessAlive, openCodeServerClient, readOpenCodeServer, stopOpenCodeServer } from "./opencode-server.js";
import { CliHerdrClient } from "./herdr-client.js";

export async function stopIdleArchiveSessions(databasePath: string, sessions: TaskSession[]): Promise<void> {
  const herdr = new CliHerdrClient();
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
    if (session.paneId && await herdr.getPane(session.paneId)) {
      const info = await herdr.getPaneProcessInfo(session.paneId);
      if (!info.foreground_processes.length) throw new Error("The task terminal could not be inspected.");
      const idle = info.foreground_processes.every(process =>
        process.pid === info.shell_pid && ["zsh", "bash", "sh", "fish", "nu", "pwsh"].includes(basename(process.name))
        || server && process.argv?.[0] === server.executable && process.argv[1] === "attach" && process.argv[2] === server.baseUrl);
      if (!idle) throw new Error("A command is still active in the task terminal. Stop it before archiving.");
    }
    if (server) servers.push(server);
  }
  for (const server of servers) await stopOpenCodeServer(server);
}

import { dirname, join } from "node:path";
import type { z } from "zod";
import { OpenCodeClient } from "./opencode-client.js";
import { readOpenCodeServer } from "./opencode-server.js";
import type { Task } from "./task-contracts.js";
import type { TaskSession } from "./task-control.js";
import type { TaskAgentStatusSchema } from "./http/contracts/tasks.js";

type AgentStatus = z.infer<typeof TaskAgentStatusSchema>;

async function observeSession(databasePath: string, session: TaskSession): Promise<"busy" | "retry" | "idle"> {
  const server = await readOpenCodeServer(join(dirname(databasePath), "runtime", "task-sessions", session.id));
  if (!server || !session.nativeSessionId) throw new Error("Session is not available");
  const client = new OpenCodeClient({ baseUrl: server.baseUrl, password: server.password, timeoutMs: 2000 });
  const [, status] = await Promise.all([client.getSession(session.nativeSessionId, server.directory), client.getStatus(server.directory)]);
  return status[session.nativeSessionId]?.type ?? "idle";
}

export async function readTaskAgentStatuses(databasePath: string, task: Pick<Task, "status">, sessions: TaskSession[], observe = observeSession) {
  return { agents: await Promise.all(sessions.filter(session => session.current).map(async session => {
    let status: AgentStatus;
    if (session.lifecycle === "stopped" || session.lifecycle === "cancelled") status = "stopped";
    else if (!session.nativeSessionId) status = "queued";
    else {
      try {
        const native = await observe(databasePath, session);
        status = native === "busy" ? "working" : native === "retry" ? "retrying" : session.kind === "root" && task.status === "waiting_human" ? "waiting_human" : "idle";
      } catch { status = "unknown"; }
    }
    return { id: session.id, role: session.kind, paneId: session.paneId, status };
  })) };
}

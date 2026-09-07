import type { z } from "zod";
import type { Task } from "./task-contracts.js";
import type { TaskSession } from "./task-control.js";
import type { TaskAgentStatusSchema } from "./http/contracts/tasks.js";
import { nativeSessionReader } from "./task-harness-registry.js";
import { roleLabel } from "./workflows.js";

type AgentStatus = z.infer<typeof TaskAgentStatusSchema>;
type NativeObservation = { status: "busy" | "retry" | "idle"; updatedAt: number };

function isoTimestamp(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

const observeSession = (databasePath: string, session: TaskSession): Promise<NativeObservation> => nativeSessionReader(databasePath, session).status(session);

export async function readTaskAgentStatuses(databasePath: string, task: Pick<Task, "status">, sessions: TaskSession[], observe = observeSession) {
  return { agents: await Promise.all(sessions.filter(session => session.current).map(async session => {
    let status: AgentStatus;
    let statusChangedAt: string | null = null;
    if (session.lifecycle === "stopped" || session.lifecycle === "cancelled") {
      status = "stopped";
      statusChangedAt = session.stoppedAt ?? session.stopRequestedAt;
    } else if (!session.nativeSessionId) status = "queued";
    else {
      try {
        const native = await observe(databasePath, session);
        status = native.status === "busy" ? "working" : native.status === "retry" ? "retrying" : session.kind === "root" && task.status === "waiting_human" ? "waiting_human" : "idle";
        if (status === "idle") statusChangedAt = isoTimestamp(native.updatedAt);
      } catch { status = "unknown"; }
    }
    return { id: session.id, role: session.kind, advisorRole: session.advisorRole, label: roleLabel(session), paneId: session.paneId, status, statusChangedAt };
  })) };
}

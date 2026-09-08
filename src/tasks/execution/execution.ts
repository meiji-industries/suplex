import type { TaskSession } from "../control.js";
import type { TaskExecution } from "./contracts.js";
import { nativeSessionReader } from "../../runtimes/task-harness-registry.js";
import { roleLabel } from "../../coordination/workflows.js";

type Observation = Awaited<ReturnType<ReturnType<typeof nativeSessionReader>["execution"]>>;
const observeSession = (databasePath: string, session: TaskSession): Promise<Observation> => nativeSessionReader(databasePath, session).execution(session);

export async function readTaskExecution(databasePath: string, sessions: TaskSession[], observe = observeSession): Promise<TaskExecution> {
  return { sessions: await Promise.all(sessions.filter(session => session.nativeSessionId).map(async session => {
    const identity = { id: session.id, role: session.kind, advisorRole: session.advisorRole, label: roleLabel(session), generation: session.generation };
    try {
      return { ...identity, available: true, ...await observe(databasePath, session) };
    } catch {
      return { ...identity, available: false, limited: false, tools: [], plan: null };
    }
  })) };
}

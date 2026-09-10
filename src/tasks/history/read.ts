import { nativeSessionReader } from "../../runtimes/task-harness-registry.js";
import type { TaskSession } from "../control.js";
import { pageSessionHistory } from "./history.js";

export async function readTaskSessionHistory(databasePath: string, session: TaskSession, before?: string) {
  const messages = await nativeSessionReader(databasePath, session).history(session);
  return pageSessionHistory(messages, before);
}

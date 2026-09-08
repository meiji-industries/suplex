import { ClaudeCodeSessionReader } from "./claude-code/session-reader.js";
import { ClaudeCodeTaskRuntime } from "./claude-code/task-runtime.js";
import { OpenCodeSessionReader } from "./opencode/session-reader.js";
import { OpenCodeTaskRuntime } from "./opencode/task-runtime.js";
import type { TaskSession } from "../tasks/control.js";
import { HarnessRouter, sessionHarness, type NativeSessionReader, type TaskHarness } from "./task-harness.js";
import type { TaskPanePort } from "./task-display.js";

/** One harness per supported agent CLI; the router selects by task profile. */
export function createTaskHarness(databasePath: string, herdr: TaskPanePort, options: { artifactRoot?: string } = {}): TaskHarness {
  return new HarnessRouter({ opencode: new OpenCodeTaskRuntime(databasePath, herdr, options), "claude-code": new ClaudeCodeTaskRuntime(databasePath, herdr, options) });
}

export function nativeSessionReader(databasePath: string, session: Pick<TaskSession, "nativeSessionId">): NativeSessionReader {
  return sessionHarness(session.nativeSessionId ?? "") === "claude-code" ? new ClaudeCodeSessionReader(databasePath) : new OpenCodeSessionReader(databasePath);
}

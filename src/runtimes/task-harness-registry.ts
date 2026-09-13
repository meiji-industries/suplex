import { ClaudeCodeSessionReader } from "./claude-code/session-reader.js";
import { ClaudeCodeTaskRuntime } from "./claude-code/task-runtime.js";
import { DevinSessionReader } from "./devin/session-reader.js";
import { DevinTaskRuntime } from "./devin/task-runtime.js";
import { OpenCodeSessionReader } from "./opencode/session-reader.js";
import { OpenCodeTaskRuntime } from "./opencode/task-runtime.js";
import type { TaskSession } from "../tasks/control.js";
import { HarnessRouter, sessionHarness, type HarnessKind, type NativeSessionReader, type TaskHarness } from "./task-harness.js";
import type { TaskPanePort } from "./task-display.js";

/** Runtime kinds whose readiness Forge currently probes. */
export const HARNESS_KINDS = ["opencode", "claude-code"] as const satisfies readonly HarnessKind[];

/** One harness per supported agent CLI; the router selects by task profile. */
export function createTaskHarness(databasePath: string, herdr: TaskPanePort, options: { artifactRoot?: string } = {}): TaskHarness {
  return new HarnessRouter({ opencode: new OpenCodeTaskRuntime(databasePath, herdr, options), "claude-code": new ClaudeCodeTaskRuntime(databasePath, herdr, options), devin: new DevinTaskRuntime(databasePath, herdr) });
}

export function nativeSessionReader(databasePath: string, session: Pick<TaskSession, "nativeSessionId">): NativeSessionReader {
  const readers: Record<HarnessKind, NativeSessionReader> = {
    opencode: new OpenCodeSessionReader(databasePath),
    "claude-code": new ClaudeCodeSessionReader(databasePath),
    devin: new DevinSessionReader(databasePath),
  };
  return readers[sessionHarness(session.nativeSessionId ?? "")];
}

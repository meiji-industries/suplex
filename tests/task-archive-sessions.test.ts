import { afterEach, expect, test, vi } from "vitest";
import type { TaskSession } from "../src/tasks/control.js";
import { stopIdleArchiveSessions } from "../src/tasks/archive/sessions.js";
import * as servers from "../src/runtimes/opencode/server.js";
import { OpenCodeClient } from "../src/runtimes/opencode/client.js";

const session: TaskSession = { id: "session", taskId: "task", kind: "root", generation: 1, current: true, paneId: null, nativeSessionId: "native", lifecycle: "stopped", assignmentHash: null, launchOwner: null, launchOwnerPid: null, launchOwnerStartTime: null, stopRequestedAt: null, stoppedAt: null, advisorRole: null, workflowInput: null };
const server: servers.OpenCodeServerReference = { pid: process.pid, baseUrl: "http://127.0.0.1:1234", password: "a".repeat(64), directory: "/repo", executable: "/bin/opencode", generation: "b775df17-718a-4cb2-8e23-6912b8aa0d39", configHash: "a".repeat(64), processIdentity: { command: "opencode serve", executable: "/bin/opencode", argv: ["opencode", "serve"], processGroup: process.pid, startTime: "start", ownerUid: 501 } };

afterEach(() => vi.restoreAllMocks());

test("archive refuses a live operation even if its start time is missing", async () => {
  await expect(stopIdleArchiveSessions("/unused/forge.db", [{ ...session, launchOwnerPid: process.pid }])).rejects.toThrow("operation is still active");
});

test("archive refuses missing server identity for a native session", async () => {
  vi.spyOn(servers, "readOpenCodeServer").mockResolvedValue(null);
  await expect(stopIdleArchiveSessions("/unused/forge.db", [session])).rejects.toThrow("server identity is missing");
});

test("a reused pid is not treated as a live server", async () => {
  vi.spyOn(servers, "readOpenCodeServer").mockResolvedValue(server);
  vi.spyOn(servers, "openCodeServerRunning").mockResolvedValue(false);
  const status = vi.spyOn(OpenCodeClient.prototype, "getStatus").mockRejectedValue(new Error("unreachable"));
  vi.spyOn(servers, "stopOpenCodeServer").mockResolvedValue();
  await stopIdleArchiveSessions("/unused/forge.db", [session]);
  expect(status).not.toHaveBeenCalled();
});

test("native busy status prevents cleanup despite a stopped database observation", async () => {
  vi.spyOn(servers, "readOpenCodeServer").mockResolvedValue(server);
  vi.spyOn(servers, "openCodeServerRunning").mockResolvedValue(true);
  vi.spyOn(OpenCodeClient.prototype, "getStatus").mockResolvedValue({ native: { type: "busy" } });
  const stop = vi.spyOn(servers, "stopOpenCodeServer").mockResolvedValue();
  await expect(stopIdleArchiveSessions("/unused/forge.db", [session])).rejects.toThrow("agent is still active");
  expect(stop).not.toHaveBeenCalled();
});

test("an idle native server can be stopped", async () => {
  vi.spyOn(servers, "readOpenCodeServer").mockResolvedValue(server);
  vi.spyOn(servers, "openCodeServerRunning").mockResolvedValue(true);
  vi.spyOn(OpenCodeClient.prototype, "getStatus").mockResolvedValue({ native: { type: "idle" } });
  const stop = vi.spyOn(servers, "stopOpenCodeServer").mockResolvedValue();
  await stopIdleArchiveSessions("/unused/forge.db", [session]);
  expect(stop).toHaveBeenCalledWith(server);
});

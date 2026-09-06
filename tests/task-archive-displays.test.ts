import { expect, test, vi } from "vitest";
import { prepareArchiveDisplays } from "../src/task-archive-displays.js";
import type { Pane, Workspace } from "../src/herdr-client.js";

function fixture(shared = false) {
  let workspace: Workspace | null = { workspaceId: "w1", label: "forge-task" };
  const panes = new Map<string, Pane>([["w1:p1", { paneId: "w1:p1", workspaceId: "w1", tokens: { forge_task_id: "task", forge_binding_id: "session" } }]]);
  if (shared) panes.set("w1:p2", { paneId: "w1:p2", workspaceId: "w1", tokens: { forge_task_id: "other" } });
  const herdr = {
    getPane: async (id: string) => panes.get(id) ?? null,
    listPanes: async () => [...panes.values()],
    getWorkspace: async () => workspace,
    listWorkspaces: async () => workspace ? [workspace] : [],
    getPaneProcessInfo: async (paneId: string) => ({ pane_id: paneId, shell_pid: 1, foreground_process_group_id: 1, foreground_processes: [{ pid: 1, name: "zsh", argv: ["/bin/zsh"] }] }),
    closePane: vi.fn(async (id: string) => { panes.delete(id); }),
    closeWorkspace: vi.fn(async () => { panes.clear(); workspace = null; }),
  };
  return { herdr, panes, sessions: [{ id: "session", taskId: "task", paneId: "w1:p1", nativeSessionId: null, server: null }] };
}

test("archive closes a task-only workspace, including historical display attachments", async () => {
  const f = fixture();
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { forge_task_id: "task", forge_binding_id: "session" } });
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
  await close();
  expect(f.herdr.closeWorkspace).toHaveBeenCalledWith("w1");
  expect(f.panes.size).toBe(0);
  await close();
});

test("archive preserves unrelated panes in a shared workspace", async () => {
  const f = fixture(true);
  await (await prepareArchiveDisplays(f.sessions, f.herdr))();
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
  expect([...f.panes.keys()]).toEqual(["w1:p2"]);
});

test("archive discovers a leftover attachment after the recorded pane was closed", async () => {
  const f = fixture();
  f.panes.delete("w1:p1");
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { forge_task_id: "task", forge_binding_id: "session" } });
  await (await prepareArchiveDisplays(f.sessions, f.herdr))();
  expect(f.herdr.closeWorkspace).toHaveBeenCalledWith("w1");
});

test("archive refuses a reassigned display", async () => {
  const f = fixture();
  f.panes.set("w1:p1", { paneId: "w1:p1", workspaceId: "w1", tokens: { forge_task_id: "other" } });
  await expect(prepareArchiveDisplays(f.sessions, f.herdr)).rejects.toThrow("ownership");
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
});

test("archive refuses active shell commands even in historical panes", async () => {
  const f = fixture();
  f.herdr.getPaneProcessInfo = async paneId => ({ pane_id: paneId, shell_pid: 1, foreground_process_group_id: 2, foreground_processes: [{ pid: 2, name: "git", argv: ["git", "commit"] }] });
  await expect(prepareArchiveDisplays(f.sessions, f.herdr)).rejects.toThrow("command is still active");
});

test("archive rechecks pane ownership and commands before closing", async () => {
  const f = fixture();
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  f.panes.set("w1:p1", { paneId: "w1:p1", workspaceId: "w1", tokens: { forge_task_id: "other" } });
  await expect(close()).rejects.toThrow("ownership");
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
});

test("a new task display during cleanup prevents a false success", async () => {
  const f = fixture();
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { forge_task_id: "task", forge_binding_id: "session" } });
  await expect(close()).rejects.toThrow("appeared during cleanup");
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
});

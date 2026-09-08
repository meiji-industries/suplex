import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { prepareArchiveDisplays } from "../src/task-archive-displays.js";
import { HerdrFailure, type Pane, type Workspace } from "../src/herdr-client.js";

function fixture(shared = false) {
  const workspace: Workspace = { workspaceId: "w1", label: "forge-task" };
  let workspaceOpen = true;
  const panes = new Map<string, Pane>([["w1:p1", { paneId: "w1:p1", workspaceId: "w1", cwd: process.cwd(), tokens: { forge_task_id: "task", forge_binding_id: "session" } }]]);
  if (shared) panes.set("w1:p2", { paneId: "w1:p2", workspaceId: "w1", cwd: process.cwd(), tokens: { forge_task_id: "other" } });
  const herdr = {
    getPane: async (id: string) => panes.get(id) ?? null,
    listPanes: async () => [...panes.values()],
    getWorkspace: async () => workspaceOpen ? workspace : null,
    listWorkspaces: async () => workspaceOpen ? [workspace] : [],
    getPaneProcessInfo: async (paneId: string) => ({ pane_id: paneId, shell_pid: 1, foreground_process_group_id: 1, foreground_processes: [{ pid: 1, name: "zsh", argv: ["/bin/zsh"] }] }),
    splitPane: vi.fn(async () => {
      const pane = { paneId: "w1:replacement", workspaceId: "w1", cwd: process.cwd() };
      panes.set(pane.paneId, pane);
      return pane;
    }),
    closePane: vi.fn(async (id: string) => { panes.delete(id); }),
    closeWorkspace: vi.fn(async () => { panes.clear(); workspaceOpen = false; }),
  };
  return { herdr, panes, workspace, sessions: [{ id: "session", taskId: "task", paneId: "w1:p1", nativeSessionId: null, display: null }] };
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

test("archive preserves a recorded pane whose id was reassigned before preparation", async () => {
  const f = fixture();
  f.panes.set("w1:p1", { paneId: "w1:p1", workspaceId: "w1", tokens: { forge_task_id: "other" } });
  await (await prepareArchiveDisplays(f.sessions, f.herdr))();
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
  expect([...f.panes.keys()]).toEqual(["w1:p1"]);
});

test("archive preserves a recorded pane whose ownership metadata is missing before preparation", async () => {
  const f = fixture();
  f.panes.set("w1:p1", { paneId: "w1:p1", workspaceId: "w1" });
  await (await prepareArchiveDisplays(f.sessions, f.herdr))();
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
  expect([...f.panes.keys()]).toEqual(["w1:p1"]);
});

test("archive succeeds when a recorded pane is missing", async () => {
  const f = fixture();
  f.panes.delete("w1:p1");
  await expect((await prepareArchiveDisplays(f.sessions, f.herdr))()).resolves.toBeUndefined();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
});

test("archive refuses active shell commands even in historical panes", async () => {
  const f = fixture();
  f.herdr.getPaneProcessInfo = async paneId => ({ pane_id: paneId, shell_pid: 1, foreground_process_group_id: 2, foreground_processes: [{ pid: 2, name: "git", argv: ["git", "commit"] }] });
  await expect(prepareArchiveDisplays(f.sessions, f.herdr)).rejects.toThrow("command is still active");
});

test("archive preserves a pane whose ownership metadata is lost before cleanup", async () => {
  const f = fixture();
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  f.panes.set("w1:p1", { paneId: "w1:p1", workspaceId: "w1" });
  await close();
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
  expect([...f.panes.keys()]).toEqual(["w1:p1"]);
});

test("archive preserves a newly appearing task display without requiring a retry", async () => {
  const f = fixture();
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { forge_task_id: "task", forge_binding_id: "session" } });
  await close();
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
  expect([...f.panes.keys()]).toEqual(["w1:p3"]);
});

test("archive preserves ownership lost while inspecting a pane during cleanup", async () => {
  const f = fixture();
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  let inspections = 0;
  f.herdr.getPaneProcessInfo = async paneId => {
    inspections += 1;
    f.panes.set(paneId, { paneId, workspaceId: "w1" });
    return { pane_id: paneId, shell_pid: 1, foreground_process_group_id: 1, foreground_processes: [{ pid: 1, name: "zsh", argv: ["/bin/zsh"] }] };
  };
  await close();
  expect(inspections).toBe(1);
  expect(f.herdr.closePane).not.toHaveBeenCalled();
  expect([...f.panes.keys()]).toEqual(["w1:p1"]);
});

test("archive preserves a pane id reused after the owned pane is closed", async () => {
  const f = fixture(true);
  f.herdr.closePane = vi.fn(async paneId => {
    f.panes.set(paneId, { paneId, workspaceId: "w1", tokens: { forge_task_id: "other" } });
  });
  await (await prepareArchiveDisplays(f.sessions, f.herdr))();
  expect(f.herdr.closePane).toHaveBeenCalledWith("w1:p1");
  expect([...f.panes.keys()]).toEqual(["w1:p1", "w1:p2"]);
});

test("archive succeeds when an owned pane disappears before cleanup", async () => {
  const f = fixture();
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  f.panes.delete("w1:p1");
  await expect(close()).resolves.toBeUndefined();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
});

test("archive refuses a command that becomes active before cleanup", async () => {
  const f = fixture();
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  f.herdr.getPaneProcessInfo = async paneId => ({ pane_id: paneId, shell_pid: 1, foreground_process_group_id: 2, foreground_processes: [{ pid: 2, name: "git", argv: ["git", "commit"] }] });
  await expect(close()).rejects.toThrow("command is still active");
  expect(f.herdr.closeWorkspace).not.toHaveBeenCalled();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
});

test("an active process in an unowned pane does not block archive", async () => {
  const f = fixture();
  f.panes.set("w1:p1", { paneId: "w1:p1", workspaceId: "w1" });
  f.herdr.getPaneProcessInfo = async () => ({ pane_id: "w1:p1", shell_pid: 1, foreground_process_group_id: 2, foreground_processes: [{ pid: 2, name: "git", argv: ["git", "commit"] }] });
  await expect((await prepareArchiveDisplays(f.sessions, f.herdr))()).resolves.toBeUndefined();
  expect([...f.panes.keys()]).toEqual(["w1:p1"]);
});

test("a workspace group refusal falls back to verified pane closure", async () => {
  const f = fixture();
  f.herdr.closeWorkspace = vi.fn(async () => {
    throw new HerdrFailure("workspace_group_close_required", false, "Linked workspaces remain");
  });
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  await close();
  expect(f.herdr.closeWorkspace).toHaveBeenCalledWith("w1");
  expect(f.herdr.splitPane).toHaveBeenCalledWith({ paneId: "w1:p1", direction: "right", cwd: process.cwd(), focus: false });
  expect(f.herdr.closePane).toHaveBeenCalledWith("w1:p1");
  expect([...f.panes.keys()]).toEqual(["w1:replacement"]);
});

test("archive retries pane cleanup after a group refusal and partial close", async () => {
  const f = fixture();
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { forge_task_id: "task", forge_binding_id: "session" } });
  f.herdr.closeWorkspace = vi.fn(async () => {
    throw new HerdrFailure("workspace_group_close_required", false, "Linked workspaces remain");
  });
  let first = true;
  f.herdr.closePane = vi.fn(async id => {
    if (id === "w1:p3" && first) {
      first = false;
      throw new Error("Pane close transport failed");
    }
    f.panes.delete(id);
  });
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  await expect(close()).rejects.toThrow("Pane close transport failed");
  expect([...f.panes.keys()]).toEqual(["w1:p3", "w1:replacement"]);
  await close();
  expect([...f.panes.keys()]).toEqual(["w1:replacement"]);
  expect(f.herdr.splitPane).toHaveBeenCalledTimes(1);
});

test("archive propagates workspace close failures other than group refusal", async () => {
  const f = fixture();
  f.herdr.closeWorkspace = vi.fn(async () => {
    throw new HerdrFailure("unavailable", true, "Herdr is unavailable");
  });
  const close = await prepareArchiveDisplays(f.sessions, f.herdr);
  await expect(close()).rejects.toThrow("Herdr is unavailable");
  expect(f.herdr.closePane).not.toHaveBeenCalled();
});

test("group fallback does not reuse a task worktree directory removed before display cleanup", async () => {
  const removedWorktree = await mkdtemp(join(tmpdir(), "forge-removed-worktree-"));
  const parentRepo = await mkdtemp(join(tmpdir(), "forge-parent-repo-"));
  try {
    const f = fixture();
    const taskPane = f.panes.get("w1:p1");
    if (!taskPane) throw new Error("Task pane fixture is missing");
    taskPane.cwd = removedWorktree;
    f.workspace.worktree = { repo_root: parentRepo };
    f.herdr.closeWorkspace = vi.fn(async () => {
      throw new HerdrFailure("workspace_group_close_required", false, "Linked workspaces remain");
    });
    const close = await prepareArchiveDisplays(f.sessions, f.herdr);
    await rm(removedWorktree, { recursive: true });
    await close();
    expect(f.herdr.splitPane).toHaveBeenCalledWith({ paneId: "w1:p1", direction: "right", cwd: parentRepo, focus: false });
  } finally {
    await rm(parentRepo, { recursive: true, force: true });
  }
});

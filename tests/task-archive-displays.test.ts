import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { prepareArchiveDisplays } from "../src/tasks/archive/displays.js";
import { HerdrFailure, type Pane, type Workspace } from "../src/integrations/herdr/client.js";
import type { TaskSession } from "../src/tasks/control.js";

function fixture(shared = false) {
  const workspace: Workspace = { workspaceId: "w1", label: "suplex-task" };
  let workspaceOpen = true;
  const panes = new Map<string, Pane>([["w1:p1", { paneId: "w1:p1", workspaceId: "w1", cwd: process.cwd(), tokens: { suplex_task_id: "task", suplex_binding_id: "session" } }]]);
  if (shared) panes.set("w1:p2", { paneId: "w1:p2", workspaceId: "w1", cwd: process.cwd(), tokens: { suplex_task_id: "other" } });
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
  const sessions: Array<Pick<TaskSession, "id" | "taskId" | "paneId" | "nativeSessionId">> = [{ id: "session", taskId: "task", paneId: "w1:p1", nativeSessionId: null }];
  return { herdr, panes, workspace, sessions };
}

test("archive closes a task-only workspace, including historical display attachments", async () => {
  const f = fixture();
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { suplex_task_id: "task", suplex_binding_id: "session" } });
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
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { suplex_task_id: "task", suplex_binding_id: "session" } });
  await (await prepareArchiveDisplays(f.sessions, f.herdr))();
  expect(f.herdr.closeWorkspace).toHaveBeenCalledWith("w1");
});

test("archive preserves a recorded pane whose id was reassigned before preparation", async () => {
  const f = fixture();
  f.panes.set("w1:p1", { paneId: "w1:p1", workspaceId: "w1", tokens: { suplex_task_id: "other" } });
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

test("archive closes a Suplex-owned shell pane", async () => {
  const f = fixture();
  f.panes.set("w1:shell", { paneId: "w1:shell", workspaceId: "w1", cwd: process.cwd(), label: "Shell", tokens: { suplex_task_id: "task", suplex_binding_id: "task:shell", suplex_role: "shell" } });
  const sessions = [...f.sessions, { id: "task:shell", taskId: "task", paneId: "w1:shell", nativeSessionId: null }];
  await (await prepareArchiveDisplays(sessions, f.herdr))();
  expect(f.herdr.closeWorkspace).toHaveBeenCalledWith("w1");
  expect(f.panes.size).toBe(0);
});

test("archive rediscovers a shell pane when its recorded id is stale", async () => {
  const f = fixture();
  f.panes.set("w1:shell-new", { paneId: "w1:shell-new", workspaceId: "w1", cwd: process.cwd(), label: "Shell", tokens: { suplex_task_id: "task", suplex_binding_id: "task:shell", suplex_role: "shell" } });
  const sessions = [...f.sessions, { id: "task:shell", taskId: "task", paneId: "w1:shell-old", nativeSessionId: null }];
  await (await prepareArchiveDisplays(sessions, f.herdr))();
  expect(f.panes.size).toBe(0);
});

test("archive does not block when the shell pane is already gone", async () => {
  const f = fixture();
  const sessions = [...f.sessions, { id: "task:shell", taskId: "task", paneId: "w1:missing", nativeSessionId: null }];
  await expect((await prepareArchiveDisplays(sessions, f.herdr))()).resolves.toBeUndefined();
  expect(f.panes.size).toBe(0);
});

test("archive succeeds when a recorded pane is missing", async () => {
  const f = fixture();
  f.panes.delete("w1:p1");
  await expect((await prepareArchiveDisplays(f.sessions, f.herdr))()).resolves.toBeUndefined();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
});

test("archive ignores unavailable display observations", async () => {
  const f = fixture();
  f.herdr.getPane = async () => { throw new HerdrFailure("unavailable", true, "Herdr is unavailable"); };
  await expect((await prepareArchiveDisplays(f.sessions, f.herdr))()).resolves.toBeUndefined();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
});

test("archive terminates an active command and closes its task workspace", async () => {
  const f = fixture();
  let running = true;
  const kill = vi.fn(() => { running = false; });
  f.herdr.getPaneProcessInfo = async paneId => ({ pane_id: paneId, shell_pid: 1, foreground_process_group_id: running ? 2 : 1, foreground_processes: [{ pid: running ? 2 : 1, name: running ? "git" : "zsh", argv: [running ? "git" : "/bin/zsh", "commit"] }] });
  await (await prepareArchiveDisplays(f.sessions, f.herdr, kill))();
  expect(kill).toHaveBeenCalledWith(-2, "SIGTERM");
  expect(f.herdr.closeWorkspace).toHaveBeenCalledWith("w1");
  expect(f.panes.size).toBe(0);
});

test("archive kills a command that does not stop", async () => {
  const f = fixture();
  const kill = vi.fn();
  f.herdr.getPaneProcessInfo = async paneId => ({ pane_id: paneId, shell_pid: 1, foreground_process_group_id: 2, foreground_processes: [{ pid: 2, name: "git", argv: ["git", "commit"] }] });
  await expect(prepareArchiveDisplays(f.sessions, f.herdr, kill)).rejects.toThrow("could not be stopped");
  expect(kill).toHaveBeenNthCalledWith(1, -2, "SIGTERM");
  expect(kill).toHaveBeenNthCalledWith(2, -2, "SIGKILL");
  expect(f.herdr.closePane).not.toHaveBeenCalled();
}, 10_000);

test("archive does not signal when ownership is lost before termination", async () => {
  const f = fixture();
  let reads = 0;
  f.herdr.getPane = async id => {
    reads += 1;
    return reads >= 3 ? null : f.panes.get(id) ?? null;
  };
  const kill = vi.fn();
  f.herdr.getPaneProcessInfo = async paneId => ({ pane_id: paneId, shell_pid: 1, foreground_process_group_id: 2, foreground_processes: [{ pid: 2, name: "git", argv: ["git", "commit"] }] });
  await (await prepareArchiveDisplays(f.sessions, f.herdr, kill))();
  expect(kill).not.toHaveBeenCalled();
  expect(f.herdr.closePane).not.toHaveBeenCalled();
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
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { suplex_task_id: "task", suplex_binding_id: "session" } });
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
    f.panes.set(paneId, { paneId, workspaceId: "w1", tokens: { suplex_task_id: "other" } });
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

test("an active process in an unowned pane does not block archive", async () => {
  const f = fixture();
  f.panes.set("w1:p1", { paneId: "w1:p1", workspaceId: "w1" });
  const kill = vi.fn();
  f.herdr.getPaneProcessInfo = async () => ({ pane_id: "w1:p1", shell_pid: 1, foreground_process_group_id: 2, foreground_processes: [{ pid: 2, name: "git", argv: ["git", "commit"] }] });
  await expect((await prepareArchiveDisplays(f.sessions, f.herdr, kill))()).resolves.toBeUndefined();
  expect(kill).not.toHaveBeenCalled();
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
  f.panes.set("w1:p3", { paneId: "w1:p3", workspaceId: "w1", tokens: { suplex_task_id: "task", suplex_binding_id: "session" } });
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
  const removedWorktree = await mkdtemp(join(tmpdir(), "suplex-removed-worktree-"));
  const parentRepo = await mkdtemp(join(tmpdir(), "suplex-parent-repo-"));
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

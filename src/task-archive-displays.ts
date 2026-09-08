import { stat } from "node:fs/promises";
import { CliHerdrClient, HerdrFailure, type Pane } from "./herdr-client.js";
import type { TaskSession } from "./task-control.js";
import { isShellProcess } from "./task-harness.js";

type ArchiveSession = Pick<TaskSession, "id" | "taskId" | "paneId" | "nativeSessionId"> & { display: ((argv: readonly string[]) => boolean) | null };
type Displays = Pick<CliHerdrClient, "getPane" | "listPanes" | "listWorkspaces" | "getWorkspace" | "getPaneProcessInfo" | "splitPane" | "closePane" | "closeWorkspace">;

function workspaceRepoRoot(workspace: Awaited<ReturnType<Displays["getWorkspace"]>>): string | undefined {
  const worktree = workspace?.worktree;
  if (!worktree || typeof worktree !== "object" || !("repo_root" in worktree)) return undefined;
  return typeof worktree.repo_root === "string" ? worktree.repo_root : undefined;
}

async function firstExistingDirectory(candidates: readonly (string | undefined)[]): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {}
  }
  throw new Error("The task workspace needs a replacement pane before cleanup, but no safe directory is available.");
}

export async function prepareArchiveDisplays(sessions: ArchiveSession[], herdr: Displays = new CliHerdrClient()): Promise<() => Promise<void>> {
  const owned = new Map<string, ArchiveSession>();
  const workspaces = new Set<string>();
  const matches = (pane: Pane, session: ArchiveSession) => pane.tokens?.forge_task_id === session.taskId && pane.tokens.forge_binding_id === session.id;
  const inspectOwned = async (pane: Pane, session: ArchiveSession): Promise<boolean> => {
    if (!matches(pane, session)) return false;
    const info = await herdr.getPaneProcessInfo(pane.paneId);
    const current = await herdr.getPane(pane.paneId);
    if (!current || !matches(current, session)) return false;
    if (!info.foreground_processes.length) throw new Error("The task terminal could not be inspected.");
    const idle = info.foreground_processes.every(process => isShellProcess(process, info.shell_pid) || process.argv !== undefined && session.display?.(process.argv) === true);
    if (!idle) throw new Error("A command is still active in the task terminal. Stop it before archiving.");
    return true;
  };
  for (const session of sessions) {
    const pane = session.paneId ? await herdr.getPane(session.paneId) : null;
    if (!pane || !await inspectOwned(pane, session)) continue;
    owned.set(pane.paneId, session);
    if (pane.workspaceId) workspaces.add(pane.workspaceId);
  }
  if (sessions.some(session => session.paneId)) {
    for (const workspace of await herdr.listWorkspaces()) {
      if (sessions.some(session => workspace.label === `forge-${session.taskId}`)) workspaces.add(workspace.workspaceId);
    }
  }
  for (const workspaceId of workspaces) {
    for (const pane of await herdr.listPanes(workspaceId)) {
      const session = sessions.find(session => matches(pane, session));
      if (!session || owned.has(pane.paneId)) continue;
      if (!await inspectOwned(pane, session)) continue;
      owned.set(pane.paneId, session);
    }
  }
  return async () => {
    for (const workspaceId of workspaces) {
      const workspace = await herdr.getWorkspace(workspaceId);
      if (!workspace) continue;
      const panes = await herdr.listPanes(workspaceId);
      const inspected = new Set<string>();
      for (const pane of panes) {
        const session = owned.get(pane.paneId);
        if (session && await inspectOwned(pane, session)) inspected.add(pane.paneId);
      }
      const currentPanes = await herdr.listPanes(workspaceId);
      const taskId = currentPanes.map(pane => {
        const session = owned.get(pane.paneId);
        return session && matches(pane, session) ? session.taskId : undefined;
      }).find(Boolean);
      const mayCloseWorkspace = currentPanes.length > 0 && currentPanes.every(pane => {
        const session = owned.get(pane.paneId);
        return session !== undefined && inspected.has(pane.paneId) && matches(pane, session);
      });
      if (taskId && workspace.label === `forge-${taskId}` && mayCloseWorkspace) {
        try {
          await herdr.closeWorkspace(workspaceId);
          if (await herdr.getWorkspace(workspaceId)) throw new Error("Herdr did not close the task workspace.");
        } catch (error) {
          if (!(error instanceof HerdrFailure) || error.code !== "workspace_group_close_required") throw error;
          const anchor = currentPanes[0];
          if (!anchor) throw new Error("The task workspace needs a replacement pane before cleanup, but it has no pane.");
          const cwd = await firstExistingDirectory([workspaceRepoRoot(workspace), anchor.foregroundCwd, anchor.cwd, process.cwd()]);
          await herdr.splitPane({ paneId: anchor.paneId, direction: "right", cwd, focus: false });
        }
      }
    }
    for (const [paneId, session] of owned) {
      const pane = await herdr.getPane(paneId);
      if (!pane || !await inspectOwned(pane, session)) continue;
      const current = await herdr.getPane(paneId);
      if (!current || !matches(current, session)) continue;
      await herdr.closePane(paneId);
    }
  };
}

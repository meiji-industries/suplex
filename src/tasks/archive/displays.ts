import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CliHerdrClient, HerdrFailure, type Pane } from "../../integrations/herdr/client.js";
import type { TaskSession } from "../control.js";
import { isShellProcess } from "../../runtimes/task-display.js";

type ArchiveSession = Pick<TaskSession, "id" | "taskId" | "paneId" | "nativeSessionId">;
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

export async function prepareArchiveDisplays(sessions: ArchiveSession[], herdr: Displays = new CliHerdrClient(), kill: (pid: number, signal: NodeJS.Signals) => void = process.kill): Promise<() => Promise<void>> {
  const owned = new Map<string, ArchiveSession>();
  const workspaces = new Set<string>();
  const matches = (pane: Pane, session: ArchiveSession) => pane.tokens?.forge_task_id === session.taskId && pane.tokens.forge_binding_id === session.id;
  const inspectOwned = async (pane: Pane, session: ArchiveSession): Promise<boolean> => {
    if (!matches(pane, session)) return false;
    const info = await herdr.getPaneProcessInfo(pane.paneId);
    const current = await herdr.getPane(pane.paneId);
    if (!current || !matches(current, session)) return false;
    if (!info.foreground_processes.length) throw new Error("The task terminal could not be inspected.");
    const active = (processes: typeof info.foreground_processes, shellPid: number | undefined) => processes.filter(process => !isShellProcess(process, shellPid));
    const signal = async (currentInfo: typeof info, signalName: NodeJS.Signals): Promise<boolean> => {
      const currentPane = await herdr.getPane(pane.paneId);
      if (!currentPane || !matches(currentPane, session)) return false;
      const processes = active(currentInfo.foreground_processes, currentInfo.shell_pid);
      try {
        if (currentInfo.foreground_process_group_id !== undefined && currentInfo.foreground_process_group_id !== currentInfo.shell_pid) kill(-currentInfo.foreground_process_group_id, signalName);
        else for (const process of processes) kill(process.pid, signalName);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== "ESRCH") throw error;
      }
      return true;
    };
    const waitForShell = async (timeout: number): Promise<typeof info | null> => {
      const deadline = Date.now() + timeout;
      let currentInfo = info;
      while (active(currentInfo.foreground_processes, currentInfo.shell_pid).length > 0) {
        if (Date.now() >= deadline) return currentInfo;
        await delay(100);
        currentInfo = await herdr.getPaneProcessInfo(pane.paneId);
        if (!currentInfo.foreground_processes.length) throw new Error("The task terminal could not be inspected.");
      }
      return null;
    };
    if (active(info.foreground_processes, info.shell_pid).length === 0) return true;
    if (!await signal(info, "SIGTERM")) return false;
    const afterTerm = await waitForShell(5_000);
    if (!afterTerm) return true;
    if (!await signal(afterTerm, "SIGKILL")) return false;
    if (!await waitForShell(2_000)) return true;
    throw new Error("The task terminal command could not be stopped.");
  };
  try {
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
  } catch (error) {
    if (error instanceof HerdrFailure && error.retryable) return async () => {};
    throw error;
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

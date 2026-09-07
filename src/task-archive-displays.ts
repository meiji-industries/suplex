import { CliHerdrClient, type Pane } from "./herdr-client.js";
import type { TaskSession } from "./task-control.js";
import { isShellProcess } from "./task-harness.js";

type ArchiveSession = Pick<TaskSession, "id" | "taskId" | "paneId" | "nativeSessionId"> & { display: ((argv: readonly string[]) => boolean) | null };
type Displays = Pick<CliHerdrClient, "getPane" | "listPanes" | "listWorkspaces" | "getWorkspace" | "getPaneProcessInfo" | "closePane" | "closeWorkspace">;

export async function prepareArchiveDisplays(sessions: ArchiveSession[], herdr: Displays = new CliHerdrClient()): Promise<() => Promise<void>> {
  const owned = new Map<string, ArchiveSession>();
  const workspaces = new Set<string>();
  const matches = (pane: Pane, session: ArchiveSession) => pane.tokens?.forge_task_id === session.taskId && pane.tokens.forge_binding_id === session.id;
  const inspect = async (pane: Pane, session: ArchiveSession) => {
    if (!matches(pane, session)) throw new Error("The task pane ownership has changed. Cleanup stopped.");
    const info = await herdr.getPaneProcessInfo(pane.paneId);
    if (!info.foreground_processes.length) throw new Error("The task terminal could not be inspected.");
    const idle = info.foreground_processes.every(process => isShellProcess(process, info.shell_pid) || process.argv !== undefined && session.display?.(process.argv) === true);
    if (!idle) throw new Error("A command is still active in the task terminal. Stop it before archiving.");
  };
  for (const session of sessions) {
    const pane = session.paneId ? await herdr.getPane(session.paneId) : null;
    if (!pane) continue;
    await inspect(pane, session);
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
      await inspect(pane, session);
      owned.set(pane.paneId, session);
    }
  }
  return async () => {
    for (const workspaceId of workspaces) {
      const workspace = await herdr.getWorkspace(workspaceId);
      if (!workspace) continue;
      const panes = await herdr.listPanes(workspaceId);
      for (const pane of panes) {
        const session = owned.get(pane.paneId);
        if (session) await inspect(pane, session);
      }
      const taskId = panes.map(pane => owned.get(pane.paneId)?.taskId).find(Boolean);
      if (taskId && workspace.label === `forge-${taskId}` && panes.every(pane => owned.has(pane.paneId))) {
        await herdr.closeWorkspace(workspaceId);
        if (await herdr.getWorkspace(workspaceId)) throw new Error("Herdr did not close the task workspace.");
      }
    }
    for (const [paneId, session] of owned) {
      const pane = await herdr.getPane(paneId);
      if (!pane) continue;
      await inspect(pane, session);
      await herdr.closePane(paneId);
      if (await herdr.getPane(paneId)) throw new Error("Herdr did not close the task pane.");
    }
    for (const workspaceId of workspaces) {
      if (!await herdr.getWorkspace(workspaceId)) continue;
      if ((await herdr.listPanes(workspaceId)).some(pane => sessions.some(session => matches(pane, session)))) {
        throw new Error("A task display appeared during cleanup. Retry Archive.");
      }
    }
  };
}

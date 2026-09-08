import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HerdrClient, PaneProcessInfo } from "../integrations/herdr/client.js";
import { splitBalancedPaneRow } from "../tasks/execution/pane-layout.js";
import { taskSessionRole, taskSessionTitle, type TaskScope } from "./task-harness.js";

export type TaskPanePort = Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata"> & Partial<Pick<HerdrClient, "getPaneLayout" | "resizePane">>;

const shells = ["zsh", "bash", "sh", "fish", "nu", "pwsh"];

export function isShellProcess(process: { pid: number; name: string }, shellPid: number | undefined): boolean {
  return process.pid === shellPid && shells.includes(basename(process.name));
}

export function isInteractiveShell(info: PaneProcessInfo): boolean {
  const foreground = info.foreground_processes[0];
  return info.foreground_processes.length === 1 && foreground !== undefined && info.foreground_process_group_id === info.shell_pid && isShellProcess(foreground, info.shell_pid);
}

export async function attachTaskDisplay(herdr: TaskPanePort, input: {
  scope: TaskScope;
  nativeSessionId: string;
  paneId: string | null;
  rootPaneId?: string | null;
  persistPane: (paneId: string) => void;
  generation: string;
  isAttached: (argv: readonly string[]) => boolean;
  command: string;
}): Promise<string> {
  const { scope } = input;
  const title = taskSessionTitle(scope);
  const metadata = (paneId: string) => ({ paneId, source: "forge", title, tokens: { forge_binding_id: scope.id, forge_task_id: scope.taskId, forge_native_session_id: input.nativeSessionId, forge_server_generation: input.generation, forge_task: scope.taskId, forge_role: taskSessionRole(scope), forge_model: scope.profile.modelID, forge_provider: scope.profile.providerID } });
  const publishMetadata = async (paneId: string): Promise<void> => { await Promise.allSettled([Promise.resolve().then(() => herdr.renamePane(paneId, title)), Promise.resolve().then(() => herdr.reportPaneMetadata(metadata(paneId)))]); };
  let pane = input.paneId ? await herdr.getPane(input.paneId) : null;
  if (pane) {
    const info = await herdr.getPaneProcessInfo(pane.paneId);
    if (info.foreground_processes.some(process => process.argv !== undefined && input.isAttached(process.argv))) { input.persistPane(pane.paneId); await publishMetadata(pane.paneId); return pane.paneId; }
    const owned = pane.tokens?.forge_binding_id === scope.id || !pane.tokens?.forge_binding_id && pane.cwd === scope.directory;
    if (owned && info.foreground_processes.length === 0) throw new Error("The task display process could not be inspected");
    if (!owned || !isInteractiveShell(info)) pane = null;
  }
  pane ??= input.rootPaneId && await herdr.getPane(input.rootPaneId) ? await splitBalancedPaneRow(herdr, { paneId: input.rootPaneId, cwd: scope.directory }) : (await herdr.createWorkspace({ label: `forge-${scope.taskId}`, cwd: scope.directory, focus: false })).rootPane;
  input.persistPane(pane.paneId);
  await publishMetadata(pane.paneId);
  const deadline = Date.now() + 2_000;
  for (;;) {
    const info = await herdr.getPaneProcessInfo(pane.paneId);
    if (isInteractiveShell(info)) break;
    if (Date.now() >= deadline) throw new Error("The task display is not at an interactive shell");
    await delay(100);
  }
  await herdr.runPaneCommand(pane.paneId, input.command);
  return pane.paneId;
}

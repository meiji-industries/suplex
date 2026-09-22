import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CliHerdrClient, HerdrClient, HerdrPaneMetadataReport, Pane, PaneProcessInfo } from "../integrations/herdr/client.js";
import { splitBalancedPaneRow } from "../tasks/execution/pane-layout.js";
import { taskSessionRole, taskSessionTitle, type TaskScope } from "./task-harness.js";

export type TaskPanePort = Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata"> & Partial<Pick<HerdrClient, "getPaneLayout" | "resizePane" | "listWorkspaces">> & Partial<Pick<CliHerdrClient, "listPanes">>;

const shells = ["zsh", "bash", "sh", "fish", "nu", "pwsh"];

export function isShellProcess(process: { pid: number; name: string }, shellPid: number | undefined): boolean {
  return process.pid === shellPid && shells.includes(basename(process.name));
}

export function isInteractiveShell(info: PaneProcessInfo): boolean {
  const foreground = info.foreground_processes[0];
  return info.foreground_processes.length === 1 && foreground !== undefined && info.foreground_process_group_id === info.shell_pid && isShellProcess(foreground, info.shell_pid);
}

export const taskShellPaneTitle = "Shell";

/** Stable binding token that marks a pane as the task's interactive Shell. */
export function taskShellPaneBinding(taskId: string): string {
  return `${taskId}:shell`;
}

type SuplexPaneMetadata = HerdrPaneMetadataReport & { title: string; tokens: Readonly<Record<string, string>> };

async function publishPaneDisplay(herdr: TaskPanePort, pane: Pane, metadata: SuplexPaneMetadata, fresh = false): Promise<void> {
  const { title, tokens } = metadata;
  const writes: Promise<void>[] = [];
  if (fresh || pane.label !== title) writes.push(Promise.resolve().then(() => herdr.renamePane(pane.paneId, title)));
  if (fresh || pane.title !== title || Object.entries(tokens).some(([key, value]) => pane.tokens?.[key] !== value)) {
    writes.push(Promise.resolve().then(() => herdr.reportPaneMetadata(metadata)));
  }
  await Promise.allSettled(writes);
}

async function publishShellPane(herdr: TaskPanePort, pane: Pane, taskId: string, fresh = false): Promise<void> {
  await publishPaneDisplay(herdr, pane, { paneId: pane.paneId, source: "suplex", title: taskShellPaneTitle, tokens: { suplex_binding_id: taskShellPaneBinding(taskId), suplex_task_id: taskId, suplex_task: taskId, suplex_role: "shell" } }, fresh);
}

/**
 * Resolves the task's interactive Shell pane. The persisted binding is only a
 * hint: Herdr decides which panes still exist. A bound pane that is gone is
 * rediscovered from the `suplex-<taskId>` workspace by token, title, or an
 * interactive shell; an exhausted workspace gets a fresh shell row. When
 * `create` is not false and no workspace exists, a new workspace's root pane
 * becomes the Shell.
 */
export async function ensureTaskShellPane(herdr: TaskPanePort, input: {
  taskId: string;
  cwd: string;
  paneId: string | null;
  persist?: ((paneId: string) => void) | undefined;
  excludePaneIds?: readonly (string | null | undefined)[];
  create?: boolean;
}): Promise<Pane | null> {
  const adopt = async (pane: Pane, fresh = false): Promise<Pane> => {
    input.persist?.(pane.paneId);
    await publishShellPane(herdr, pane, input.taskId, fresh);
    return pane;
  };
  const persisted = input.paneId ? await herdr.getPane(input.paneId) : null;
  const foreign = persisted?.tokens?.suplex_task_id !== undefined && persisted.tokens.suplex_task_id !== input.taskId;
  if (persisted && !foreign) return adopt(persisted);
  const excluded = new Set((input.excludePaneIds ?? []).filter((paneId): paneId is string => Boolean(paneId)));
  const shellBinding = taskShellPaneBinding(input.taskId);
  const workspaces = herdr.listWorkspaces ? await herdr.listWorkspaces() : [];
  const allPanes = herdr.listPanes ? (await Promise.all(workspaces.filter(workspace => workspace.label === `suplex-${input.taskId}`).map(workspace => herdr.listPanes!(workspace.workspaceId)))).flat() : [];
  const panes = allPanes
    .filter(pane => !excluded.has(pane.paneId))
    .filter(pane => pane.tokens?.suplex_binding_id === undefined || pane.tokens.suplex_binding_id === shellBinding);
  const tokened = panes.find(pane => pane.tokens?.suplex_task_id === input.taskId && pane.tokens.suplex_role === "shell");
  if (tokened) return adopt(tokened);
  const named = panes.find(pane => pane.label === taskShellPaneTitle || pane.title === taskShellPaneTitle);
  if (named) return adopt(named);
  for (const pane of panes) {
    const info = await herdr.getPaneProcessInfo(pane.paneId).catch(() => null);
    if (info && isInteractiveShell(info)) return adopt(pane);
  }
  const anchor = allPanes[0];
  if (anchor) return adopt(await splitBalancedPaneRow(herdr, { paneId: anchor.paneId, cwd: anchor.cwd ?? input.cwd }), true);
  if (input.create === false) return null;
  return adopt((await herdr.createWorkspace({ label: `suplex-${input.taskId}`, cwd: input.cwd, focus: false })).rootPane, true);
}

export async function attachTaskDisplay(herdr: TaskPanePort, input: {
  scope: TaskScope;
  nativeSessionId: string;
  paneId: string | null;
  rootPaneId?: string | null;
  shellPaneId?: string | null;
  persistPane: (paneId: string) => void;
  persistShellPane?: (paneId: string) => void;
  generation: string;
  isAttached: (argv: readonly string[]) => boolean;
  command: string;
}): Promise<string> {
  const { scope } = input;
  const title = taskSessionTitle(scope);
  const metadata = (paneId: string): SuplexPaneMetadata => ({ paneId, source: "suplex", title, tokens: { suplex_binding_id: scope.id, suplex_task_id: scope.taskId, suplex_native_session_id: input.nativeSessionId, suplex_server_generation: input.generation, suplex_task: scope.taskId, suplex_role: taskSessionRole(scope), suplex_model: scope.profile.modelID, suplex_provider: scope.profile.providerID } });
  let pane = input.paneId ? await herdr.getPane(input.paneId) : null;
  if (pane) {
    const info = await herdr.getPaneProcessInfo(pane.paneId);
    if (info.foreground_processes.some(process => process.argv !== undefined && input.isAttached(process.argv))) { input.persistPane(pane.paneId); await publishPaneDisplay(herdr, pane, metadata(pane.paneId)); return pane.paneId; }
    const owned = pane.tokens?.suplex_binding_id === scope.id || !pane.tokens?.suplex_binding_id && pane.cwd === scope.directory;
    if (owned && info.foreground_processes.length === 0) throw new Error("The task display process could not be inspected");
    if (!owned || !isInteractiveShell(info)) pane = null;
  }
  if (!pane) {
    const anchor = input.rootPaneId ? await herdr.getPane(input.rootPaneId) : null;
    if (anchor) pane = await splitBalancedPaneRow(herdr, { paneId: anchor.paneId, cwd: scope.directory });
    else {
      // The workspace root pane is the task Shell; the session pane opens below it.
      const shell = await ensureTaskShellPane(herdr, { taskId: scope.taskId, cwd: scope.directory, paneId: input.shellPaneId ?? null, persist: input.persistShellPane, excludePaneIds: [input.paneId, input.rootPaneId] }).catch(() => null);
      pane = shell ? await splitBalancedPaneRow(herdr, { paneId: shell.paneId, cwd: scope.directory }) : (await herdr.createWorkspace({ label: `suplex-${scope.taskId}`, cwd: scope.directory, focus: false })).rootPane;
    }
  }
  input.persistPane(pane.paneId);
  await publishPaneDisplay(herdr, pane, metadata(pane.paneId), true);
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

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { PullRequestCard } from "../pull-request-card.js";
import { buildChatTranscript, sortChatItems, type ChatItem } from "../../../lib/task-chat.js";
import { useTaskChatStream } from "../../../lib/use-task-chat-stream.js";
import { readJson } from "../../../lib/api.js";
import type { ApiTask } from "../../../lib/view-shared.js";
import type { IssueCommand } from "../../../../commands/registry.js";
import { STEP_RETRY_COMMAND } from "../../../../issue-phases.js";
import { ChatAgentTurn } from "./chat-agent-turn.js";
import { ChatComposer } from "./chat-composer.js";
import { ChatMemberMessage } from "./chat-member-message.js";
import { ChatSystemLine } from "./chat-system-line.js";
import { LivePaneTerminal } from "./live-pane-terminal.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs.js";
import { Button } from "../../ui/button.js";

const livePaneHeightStorageKey = "forge.live-pane-height";
const defaultLivePaneHeight = 320;
const minimumLivePaneHeight = 160;
const maximumLivePaneHeight = 720;
const livePaneHeightStep = 24;

export function clampLivePaneHeight(height: number): number {
  return Math.min(maximumLivePaneHeight, Math.max(minimumLivePaneHeight, height));
}

export function savedLivePaneHeight(value: string | null): number {
  if (value === null || value.trim() === "") return defaultLivePaneHeight;
  const height = Number(value);
  return Number.isFinite(height) ? clampLivePaneHeight(height) : defaultLivePaneHeight;
}

export function adjustLivePaneHeight(height: number, direction: -1 | 1): number {
  return clampLivePaneHeight(height + direction * livePaneHeightStep);
}

function readLivePaneHeight(): number {
  try {
    return typeof window === "undefined" ? defaultLivePaneHeight : savedLivePaneHeight(window.localStorage.getItem(livePaneHeightStorageKey));
  } catch {
    return defaultLivePaneHeight;
  }
}

function persistLivePaneHeight(height: number): void {
  try {
    window.localStorage.setItem(livePaneHeightStorageKey, String(height));
  } catch {
    // Storage access is optional.
  }
}

type LivePane = { role: string; paneId: string | null; agentName: string; status: string | null; attachCommand: string };
type LivePaneStatus = { label: string; dotClass: string };
type LivePaneResponse = { panes?: LivePane[] };


export function livePaneStatus(status: string | null): LivePaneStatus {
  if (status === "working") return { label: "Working", dotClass: "animate-pulse bg-emerald-500" };
  if (status === "blocked" || status === "awaiting_human") return { label: status === "blocked" ? "Blocked" : "Awaiting human", dotClass: "bg-amber-500" };
  if (status === "failed") return { label: "Failed", dotClass: "bg-red-500" };
  if (status === "idle" || status === "ready" || status === "done" || status === "closed") return { label: status === "done" || status === "closed" ? "Done" : "Idle", dotClass: "bg-muted-foreground" };
  return { label: "Status unknown", dotClass: "bg-muted-foreground" };
}

export function selectedLivePane(panes: readonly LivePane[], selectedRole: string | undefined): LivePane | undefined {
  return panes.find((pane) => pane.role === selectedRole) ?? panes[0];
}
export function LivePaneDock({ task, onRestart }: { task: ApiTask; onRestart: (command: IssueCommand | undefined) => Promise<void> }) {
  const [panes, setPanes] = useState<LivePane[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>();
  const [height, setHeight] = useState(readLivePaneHeight);
  const resize = useRef<{ originY: number; height: number } | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const paneResult = await readJson<LivePaneResponse>(`/api/tasks/${encodeURIComponent(task.id)}/pane`);
        if (active) setPanes(paneResult.panes ?? []);
      } catch {
        // The next poll retries transient pane reads.
      }
    };
    void refresh();
    const stream = new EventSource(`/api/tasks/${encodeURIComponent(task.id)}/agent-events`);
    stream.addEventListener("panes", (message) => { try { const statuses = JSON.parse((message as MessageEvent<string>).data) as Array<{ role: string; paneId: string | null; status: string | null }>; if (active) setPanes((current) => current.map((pane) => ({ ...pane, ...(statuses.find((status) => status.role === pane.role) ?? {}) }))); } catch { /* Ignore malformed live state. */ } });
    return () => { active = false; stream.close(); };
  }, [task.id]);
  const selectedPane = selectedLivePane(panes, selectedRole);
  const retryCommand = STEP_RETRY_COMMAND[task.step];
  const restartable = task.owner !== "human" && (selectedPane?.status === "failed" || selectedPane?.status === "done");
  useEffect(() => {
    setSelectedRole((current) => current === selectedPane?.role ? current : selectedPane?.role);
  }, [selectedPane?.role]);
  const updateResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = resize.current;
    if (!active) return;
    active.height = clampLivePaneHeight(active.height + active.originY - event.clientY);
    active.originY = event.clientY;
    setHeight(active.height);
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    resize.current = { originY: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>, save: boolean): void => {
    updateResize(event);
    const active = resize.current;
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (save && active) persistLivePaneHeight(active.height);
  };
  const adjustResize = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? 1 : -1;
    setHeight((current) => {
      const next = adjustLivePaneHeight(current, direction);
      persistLivePaneHeight(next);
      return next;
    });
  };
  return selectedPane ? <section className="sticky bottom-0 z-10 flex flex-col bg-[#1e1e2e]" aria-label="Live agent output" style={{ height }}><div role="slider" tabIndex={0} aria-label="Resize live agent output" aria-orientation="vertical" aria-valuemin={minimumLivePaneHeight} aria-valuemax={maximumLivePaneHeight} aria-valuenow={height} aria-valuetext={`${height} pixels`} className="flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#cdd6f4]" title="Drag to resize live output" onKeyDown={adjustResize} onPointerDown={startResize} onPointerMove={updateResize} onPointerUp={(event) => endResize(event, true)} onPointerCancel={(event) => endResize(event, false)}><span aria-hidden="true" className="h-px w-8 bg-[#6c7086]" /></div><Tabs className="min-h-0 flex-1 gap-0" value={selectedPane.role} onValueChange={setSelectedRole}><div className="flex shrink-0 items-center gap-1 overflow-x-auto bg-[#1e1e2e] px-1 pt-1" aria-label="Live pane tabs"><TabsList className="h-8 gap-1 rounded-none bg-transparent p-0">{panes.map((pane) => {
    const status = livePaneStatus(pane.status);
    return <TabsTrigger aria-label={`${pane.role}: ${status.label}`} className="group h-7 flex-none gap-1.5 rounded-md px-2 text-[13px] font-medium text-[#a6adc8] hover:bg-[#313244] hover:text-[#cdd6f4] data-active:bg-[#313244] data-active:text-[#cdd6f4] data-active:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)]" key={pane.role} title={status.label} value={pane.role}><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${status.dotClass}`} />{pane.role}</TabsTrigger>;
  })}</TabsList>{restartable ? <Button size="xs" variant="outline" onClick={() => void onRestart(retryCommand && task.allowedCommands.includes(retryCommand) ? retryCommand : undefined)}>Restart {selectedPane.role}</Button> : null}</div><TabsContent className="mt-0 min-h-0" value={selectedPane.role}><LivePaneTerminal taskId={task.id} role={selectedPane.role} paneId={selectedPane.paneId} /></TabsContent></Tabs></section> : null;
}



export function TaskChat({ task, busy, pullRequestBusy = busy, onRefresh, onMarkReady, onRepairCi, onOpenDiff, onSendPlannerNote, plannerAvailable }: { task: ApiTask; busy: boolean; pullRequestBusy?: boolean; onRefresh: () => Promise<void>; onMarkReady: () => Promise<void>; onRepairCi: () => Promise<void>; onOpenDiff: () => void; onSendPlannerNote: (note: string, commandId: string) => Promise<void>; plannerAvailable: boolean }) {
  const { liveEventsByExecution, loadEvents } = useTaskChatStream(task.id, task, onRefresh);
  const [optimistic, setOptimistic] = useState<Extract<ChatItem, { kind: "member" }>[]>([]);
  const transcript = useMemo(() => sortChatItems([...buildChatTranscript(task, liveEventsByExecution), ...optimistic]), [liveEventsByExecution, optimistic, task]);
  return <section className="space-y-3" data-task-chat aria-label="Chat"><div className="space-y-4">{transcript.map((item) => item.kind === "member" ? <ChatMemberMessage item={item} key={item.id} /> : item.kind === "agent_turn" ? <ChatAgentTurn item={item} onOpenDiff={onOpenDiff} onLoadEvents={() => loadEvents(task.agentInvocations.find((invocation) => `agent-${invocation.id}` === item.id)!)} key={item.id} /> : item.kind === "pull_request" ? <PullRequestCard task={task} busy={pullRequestBusy} onRefresh={onRefresh} onMarkReady={onMarkReady} onRepairCi={onRepairCi} key={item.id} /> : <ChatSystemLine item={item} key={item.id} />)}</div><ChatComposer taskId={task.id} phase={task.phase} disabled={busy} plannerAvailable={plannerAvailable} onSubmit={async (note, commandId) => { setOptimistic((current) => [...current, { kind: "member", id: `optimistic-${commandId}`, at: new Date().toISOString(), actor: { name: "You", avatarSeed: "member" }, markdown: note }]); await onSendPlannerNote(note, commandId); setOptimistic([]); }} /></section>;
}

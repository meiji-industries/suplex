import { useEffect, useMemo, useState } from "react";

import { PullRequestCard } from "../pull-request-card.js";
import { buildChatTranscript, sortChatItems, type ChatItem } from "../../../lib/task-chat.js";
import { useTaskChatStream } from "../../../lib/use-task-chat-stream.js";
import { readJson } from "../../../lib/api.js";
import type { ApiAgentRuntime, ApiTask } from "../../../lib/view-shared.js";
import { ChatAgentTurn } from "./chat-agent-turn.js";
import { ChatComposer } from "./chat-composer.js";
import { ChatMemberMessage } from "./chat-member-message.js";
import { ChatSystemLine } from "./chat-system-line.js";
import { LivePaneTerminal } from "./live-pane-terminal.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs.js";
import { runtimeStatusLabel } from "../runtime-presentation.js";

type LivePane = { role: string; text: string };
type LivePaneStatus = { label: string; dotClass: string };
type LivePaneResponse = { panes?: LivePane[] };
type AgentRuntimeResponse = { runtime?: ApiAgentRuntime[] };


export function livePaneStatus(taskId: string, role: string, runtime: readonly ApiAgentRuntime[]): LivePaneStatus {
  const paneRuntime = runtime.find((entry) => entry.taskId === taskId && entry.role === role);
  return paneRuntime
    ? { label: runtimeStatusLabel(paneRuntime), dotClass: paneRuntime.diagnosis === "working" ? "bg-emerald-500" : paneRuntime.diagnosis === "blocked" ? "bg-amber-500" : "bg-muted-foreground" }
    : { label: "Runtime unknown", dotClass: "bg-muted-foreground" };
}

export function selectedLivePane(panes: readonly LivePane[], selectedRole: string | undefined): LivePane | undefined {
  return panes.find((pane) => pane.role === selectedRole) ?? panes[0];
}
export function LivePaneDock({ task }: { task: ApiTask }) {
  const [panes, setPanes] = useState<LivePane[]>([]);
  const [runtime, setRuntime] = useState<ApiAgentRuntime[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>();
  // Panes keep moving in every non-terminal phase (CI repair, reviews, integrator work), so keep tailing.
  const running = !["done", "cancelled"].includes(task.phase);
  useEffect(() => {
    let active = true;
    const load = async () => {
    const [paneResult, runtimeResult] = await Promise.allSettled([
      readJson<LivePaneResponse>(`/api/tasks/${encodeURIComponent(task.id)}/pane`),
      readJson<AgentRuntimeResponse>(`/api/agent-runtime?companyId=${encodeURIComponent(task.companyId)}`),
    ]);
    if (!active) return;
    if (paneResult.status === "fulfilled") setPanes(paneResult.value.panes ?? []);
    if (runtimeResult.status === "fulfilled") setRuntime(runtimeResult.value.runtime ?? []);
    };
    void load();
    const timer = running ? window.setInterval(() => void load(), 2_000) : undefined;
    return () => { active = false; if (timer !== undefined) window.clearInterval(timer); };
  }, [running, task.companyId, task.id]);
  const selectedPane = selectedLivePane(panes, selectedRole);
  useEffect(() => {
    setSelectedRole((current) => current === selectedPane?.role ? current : selectedPane?.role);
  }, [selectedPane?.role]);
  return selectedPane ? <section className="sticky bottom-0 z-10 bg-[#1e1e2e]" aria-label="Live agent output"><Tabs className="gap-0" value={selectedPane.role} onValueChange={setSelectedRole}><div className="overflow-x-auto bg-[#1e1e2e] px-1 pt-1" aria-label="Live pane tabs"><TabsList className="h-8 gap-1 rounded-none bg-transparent p-0">{panes.map((pane) => {
    const status = livePaneStatus(task.id, pane.role, runtime);
    return <TabsTrigger aria-label={`${pane.role}: ${status.label}`} className="group h-7 flex-none gap-1.5 rounded-md px-2 text-[13px] font-medium text-[#a6adc8] hover:bg-[#313244] hover:text-[#cdd6f4] data-active:bg-[#313244] data-active:text-[#cdd6f4] data-active:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)]" key={pane.role} title={status.label} value={pane.role}><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${status.dotClass}`} />{pane.role}</TabsTrigger>;
  })}</TabsList></div><TabsContent className="mt-0" value={selectedPane.role}><LivePaneTerminal role={selectedPane.role} text={selectedPane.text} /></TabsContent></Tabs></section> : null;
}



export function TaskChat({ task, busy, pullRequestBusy = busy, onRefresh, onMarkReady, onRepairCi, onOpenDiff, onSendPlannerNote, composerDisabledReason }: { task: ApiTask; busy: boolean; pullRequestBusy?: boolean; onRefresh: () => Promise<void>; onMarkReady: () => Promise<void>; onRepairCi: () => Promise<void>; onOpenDiff: () => void; onSendPlannerNote: (note: string, commandId: string) => Promise<void>; composerDisabledReason?: string | undefined }) {
  const { liveEventsByExecution, loadEvents } = useTaskChatStream(task.id, task, onRefresh);
  const [optimistic, setOptimistic] = useState<Extract<ChatItem, { kind: "member" }>[]>([]);
  const transcript = useMemo(() => sortChatItems([...buildChatTranscript(task, liveEventsByExecution), ...optimistic]), [liveEventsByExecution, optimistic, task]);
  return <section className="space-y-3" data-task-chat aria-label="Chat"><div className="space-y-4">{transcript.map((item) => item.kind === "member" ? <ChatMemberMessage item={item} key={item.id} /> : item.kind === "agent_turn" ? <ChatAgentTurn item={item} onOpenDiff={onOpenDiff} onLoadEvents={() => loadEvents(task.agentInvocations.find((invocation) => `agent-${invocation.id}` === item.id)!)} key={item.id} /> : item.kind === "pull_request" ? <PullRequestCard task={task} busy={pullRequestBusy} onRefresh={onRefresh} onMarkReady={onMarkReady} onRepairCi={onRepairCi} key={item.id} /> : <ChatSystemLine item={item} key={item.id} />)}</div><ChatComposer disabled={busy} disabledReason={composerDisabledReason} onSubmit={async (note, commandId) => { setOptimistic((current) => [...current, { kind: "member", id: `optimistic-${commandId}`, at: new Date().toISOString(), actor: { name: "You", avatarSeed: "member" }, markdown: note }]); await onSendPlannerNote(note, commandId); setOptimistic([]); }} /></section>;
}

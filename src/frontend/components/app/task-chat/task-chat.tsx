import { useEffect, useMemo, useState } from "react";

import { PullRequestCard } from "../pull-request-card.js";
import { buildChatTranscript, sortChatItems, type ChatItem } from "../../../lib/task-chat.js";
import { useTaskChatStream } from "../../../lib/use-task-chat-stream.js";
import type { ApiTask } from "../../../lib/view-shared.js";
import { ChatAgentTurn } from "./chat-agent-turn.js";
import { ChatComposer } from "./chat-composer.js";
import { ChatMemberMessage } from "./chat-member-message.js";
import { ChatSystemLine } from "./chat-system-line.js";
import { LivePaneTerminal } from "./live-pane-terminal.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs.js";

type LivePane = { role: string; text: string };

export function selectedLivePane(panes: readonly LivePane[], selectedRole: string | undefined): LivePane | undefined {
  return panes.find((pane) => pane.role === selectedRole) ?? panes[0];
}
export function LivePaneDock({ task }: { task: ApiTask }) {
  const [panes, setPanes] = useState<LivePane[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>();
  // Panes keep moving in every non-terminal phase (CI repair, reviews, integrator work), so keep tailing.
  const running = !["done", "cancelled"].includes(task.phase);
  useEffect(() => {
    let active = true;
    const load = async () => { const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/pane`); if (active && response.ok) setPanes(((await response.json()) as { panes?: LivePane[] }).panes ?? []); };
    void load();
    const timer = running ? window.setInterval(() => void load(), 2_000) : undefined;
    return () => { active = false; if (timer !== undefined) window.clearInterval(timer); };
  }, [running, task.id]);
  const selectedPane = selectedLivePane(panes, selectedRole);
  useEffect(() => {
    setSelectedRole((current) => current === selectedPane?.role ? current : selectedPane?.role);
  }, [selectedPane?.role]);
  return selectedPane ? <section className="sticky bottom-0 z-10 border-t border-border bg-background" aria-label="Live agent output"><Tabs value={selectedPane.role} onValueChange={setSelectedRole}><div className="overflow-x-auto border-b border-border"><TabsList>{panes.map((pane) => <TabsTrigger key={pane.role} value={pane.role}>{pane.role}</TabsTrigger>)}</TabsList></div><TabsContent value={selectedPane.role}><LivePaneTerminal role={selectedPane.role} text={selectedPane.text} /></TabsContent></Tabs></section> : null;
}



export function TaskChat({ task, busy, pullRequestBusy = busy, onRefresh, onMarkReady, onRepairCi, onOpenDiff, onSendPlannerNote, composerDisabledReason }: { task: ApiTask; busy: boolean; pullRequestBusy?: boolean; onRefresh: () => Promise<void>; onMarkReady: () => Promise<void>; onRepairCi: () => Promise<void>; onOpenDiff: () => void; onSendPlannerNote: (note: string, commandId: string) => Promise<void>; composerDisabledReason?: string | undefined }) {
  const { liveEventsByExecution, loadEvents } = useTaskChatStream(task.id, task, onRefresh);
  const [optimistic, setOptimistic] = useState<Extract<ChatItem, { kind: "member" }>[]>([]);
  const transcript = useMemo(() => sortChatItems([...buildChatTranscript(task, liveEventsByExecution), ...optimistic]), [liveEventsByExecution, optimistic, task]);
  return <section className="space-y-3" data-task-chat aria-label="Chat"><div className="space-y-4">{transcript.map((item) => item.kind === "member" ? <ChatMemberMessage item={item} key={item.id} /> : item.kind === "agent_turn" ? <ChatAgentTurn item={item} onOpenDiff={onOpenDiff} onLoadEvents={() => loadEvents(task.agentInvocations.find((invocation) => `agent-${invocation.id}` === item.id)!)} key={item.id} /> : item.kind === "pull_request" ? <PullRequestCard task={task} busy={pullRequestBusy} onRefresh={onRefresh} onMarkReady={onMarkReady} onRepairCi={onRepairCi} key={item.id} /> : <ChatSystemLine item={item} key={item.id} />)}</div><ChatComposer disabled={busy} disabledReason={composerDisabledReason} onSubmit={async (note, commandId) => { setOptimistic((current) => [...current, { kind: "member", id: `optimistic-${commandId}`, at: new Date().toISOString(), actor: { name: "You", avatarSeed: "member" }, markdown: note }]); await onSendPlannerNote(note, commandId); setOptimistic([]); }} /></section>;
}

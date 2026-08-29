import { useEffect, useMemo, useState } from "react";

import { PullRequestCard } from "../pull-request-card.js";
import { buildChatTranscript, sortChatItems, type ChatItem } from "../../../lib/task-chat.js";
import { useTaskChatStream } from "../../../lib/use-task-chat-stream.js";
import type { ApiTask } from "../../../lib/view-shared.js";
import { ChatAgentTurn } from "./chat-agent-turn.js";
import { ChatComposer } from "./chat-composer.js";
import { ChatMemberMessage } from "./chat-member-message.js";
import { ChatSystemLine } from "./chat-system-line.js";
import { parseAnsi } from "../../../lib/ansi.js";

export function TaskChat({ task, busy, onRefresh, onMarkReady, onOpenDiff, onSendPlannerNote, composerDisabledReason }: { task: ApiTask; busy: boolean; onRefresh: () => Promise<void>; onMarkReady: () => Promise<void>; onOpenDiff: () => void; onSendPlannerNote: (note: string, commandId: string) => Promise<void>; composerDisabledReason?: string | undefined }) {
  const { liveEventsByExecution, loadEvents } = useTaskChatStream(task.id, task, onRefresh);
  const [optimistic, setOptimistic] = useState<Extract<ChatItem, { kind: "member" }>[]>([]);
  const [panes, setPanes] = useState<Array<{ role: string; text: string }>>([]);
  // Panes keep moving in every non-terminal phase (CI repair, reviews, integrator work), so keep tailing.
  const running = !["done", "cancelled"].includes(task.phase);
  useEffect(() => {
    let active = true;
    const load = async () => { const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/pane`); if (active && response.ok) setPanes(((await response.json()) as { panes?: Array<{ role: string; text: string }> }).panes ?? []); };
    void load();
    const timer = running ? window.setInterval(() => void load(), 2_000) : undefined;
    return () => { active = false; if (timer !== undefined) window.clearInterval(timer); };
  }, [running, task.id]);
  // Live tail: pin the pane to its bottom on every render (open, refresh).
  const scrollToBottom = (element: HTMLPreElement | null) => { if (element) element.scrollTop = element.scrollHeight; };
  const transcript = useMemo(() => sortChatItems([...buildChatTranscript(task, liveEventsByExecution), ...optimistic]), [liveEventsByExecution, optimistic, task]);
  return <section className="space-y-3" data-task-chat aria-label="Chat">{panes.map((pane) => <details className="border-y border-border py-1" key={pane.role} open><summary className="cursor-pointer text-xs font-medium">Live pane · {pane.role}</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[#1e1e2e] p-2 font-mono text-[11px] text-[#cdd6f4]" ref={scrollToBottom}>{parseAnsi(pane.text).map((span, index) => <span key={index} style={span.style}>{span.text}</span>)}</pre></details>)}<div className="space-y-4">{transcript.map((item) => item.kind === "member" ? <ChatMemberMessage item={item} key={item.id} /> : item.kind === "agent_turn" ? <ChatAgentTurn item={item} onOpenDiff={onOpenDiff} onLoadEvents={() => loadEvents(task.agentInvocations.find((invocation) => `agent-${invocation.id}` === item.id)!)} key={item.id} /> : item.kind === "pull_request" ? <PullRequestCard task={task} busy={busy} onRefresh={onRefresh} onMarkReady={onMarkReady} key={item.id} /> : <ChatSystemLine item={item} key={item.id} />)}</div><ChatComposer disabled={busy} disabledReason={composerDisabledReason} onSubmit={async (note, commandId) => { setOptimistic((current) => [...current, { kind: "member", id: `optimistic-${commandId}`, at: new Date().toISOString(), actor: { name: "You", avatarSeed: "member" }, markdown: note }]); await onSendPlannerNote(note, commandId); setOptimistic([]); }} /></section>;
}

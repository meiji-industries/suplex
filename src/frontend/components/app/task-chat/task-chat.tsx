import { useEffect, useMemo, useState } from "react";

import { PullRequestCard } from "../pull-request-card.js";
import { buildChatTranscript, sortChatItems, type ChatItem } from "../../../lib/task-chat.js";
import { useTaskChatStream } from "../../../lib/use-task-chat-stream.js";
import type { ApiTask } from "../../../lib/view-shared.js";
import { ChatAgentTurn } from "./chat-agent-turn.js";
import { ChatComposer } from "./chat-composer.js";
import { ChatMemberMessage } from "./chat-member-message.js";
import { ChatSystemLine } from "./chat-system-line.js";
import { stripAnsi } from "../command-output.js";

export function TaskChat({ task, busy, onRefresh, onMarkReady, onOpenDiff, onSendPlannerNote, composerDisabledReason }: { task: ApiTask; busy: boolean; onRefresh: () => Promise<void>; onMarkReady: () => Promise<void>; onOpenDiff: () => void; onSendPlannerNote: (note: string, commandId: string) => Promise<void>; composerDisabledReason?: string | undefined }) {
  const { liveEventsByExecution, loadEvents } = useTaskChatStream(task.id, task, onRefresh);
  const [optimistic, setOptimistic] = useState<Extract<ChatItem, { kind: "member" }>[]>([]);
  const [paneText, setPaneText] = useState("");
  const running = task.phase === "development" || task.agentInvocations.some((invocation) => invocation.status === "running");
  useEffect(() => {
    let active = true;
    const load = async () => { const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/pane?role=${task.phase === "development" ? "developer" : "lead"}`); if (active && response.ok) setPaneText(stripAnsi(String(((await response.json()) as { text?: string }).text ?? ""))); };
    void load();
    const timer = running ? window.setInterval(() => void load(), 2_000) : undefined;
    return () => { active = false; if (timer !== undefined) window.clearInterval(timer); };
  }, [running, task.id, task.phase]);
  const transcript = useMemo(() => sortChatItems([...buildChatTranscript(task, liveEventsByExecution), ...optimistic]), [liveEventsByExecution, optimistic, task]);
  return <section className="space-y-3" data-task-chat aria-label="Chat"><details className="border-y border-border py-1"><summary className="cursor-pointer text-xs font-medium">Live pane</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">{paneText}</pre></details><div className="space-y-4">{transcript.map((item) => item.kind === "member" ? <ChatMemberMessage item={item} key={item.id} /> : item.kind === "agent_turn" ? <ChatAgentTurn item={item} onOpenDiff={onOpenDiff} onLoadEvents={() => loadEvents(task.agentInvocations.find((invocation) => `agent-${invocation.id}` === item.id)!)} key={item.id} /> : item.kind === "pull_request" ? <PullRequestCard task={task} busy={busy} onRefresh={onRefresh} onMarkReady={onMarkReady} key={item.id} /> : <ChatSystemLine item={item} key={item.id} />)}</div><ChatComposer disabled={busy} disabledReason={composerDisabledReason} onSubmit={async (note, commandId) => { setOptimistic((current) => [...current, { kind: "member", id: `optimistic-${commandId}`, at: new Date().toISOString(), actor: { name: "You", avatarSeed: "member" }, markdown: note }]); await onSendPlannerNote(note, commandId); setOptimistic([]); }} /></section>;
}

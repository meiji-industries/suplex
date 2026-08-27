import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Collapsible } from "../../ui/collapsible.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent } from "../../ui/card.js";
import { Markdown } from "../markdown.js";
import { ProfileAvatar } from "../profile-avatar.js";
import type { ChatEvent, ChatItem } from "../../../lib/task-chat.js";

function duration(startedAt: string, finishedAt: string | null, now: number): string { return `${Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) / 1_000))}s`; }
function ReasoningEvent({ event }: { event: ChatEvent }) {
  const [expanded, setExpanded] = useState(false);
  const long = event.text.split("\n").length > 4 || event.text.length > 500;
  return <li data-task-chat-reasoning><Card size="sm"><CardContent><div className="space-y-2"><p className="text-[11px] font-medium text-muted-foreground">Reasoning</p>{!long || expanded ? <Markdown source={event.text} /> : <p className="whitespace-pre-wrap text-[12px] text-muted-foreground">{event.text.split("\n").slice(0, 4).join("\n")}</p>}{long ? <Button type="button" variant="ghost" size="xs" onClick={() => setExpanded((current) => !current)}>{expanded ? "Show less" : "Show more"}</Button> : null}</div></CardContent></Card></li>;
}

function AgentBubble({ children, message = false }: { children: ReactNode; message?: boolean }) {
  return <div data-task-chat-agent-bubble data-task-chat-agent-message={message || undefined} className="max-w-[85%] rounded-[6px] border bg-muted/40 px-2.5 py-2 text-[13px]">{children}</div>;
}

function EventLine({ event, onOpenDiff }: { event: ChatEvent; onOpenDiff: () => void }) {
  if (event.kind === "thinking_summary") return <ReasoningEvent event={event} />;
  if (event.kind === "command") {
    const [expanded, setExpanded] = useState(false);
    const failed = event.exitCode !== null && event.exitCode !== undefined && event.exitCode !== 0;
    const label = event.status === "running" ? "…" : event.exitCode === null || event.exitCode === undefined ? "exit —" : `exit ${event.exitCode}`;
    const lines = event.output?.split("\n") ?? [];
    const preview = expanded ? lines : lines.slice(0, 3);
    return <li data-task-chat-command className="font-mono text-[12px]"><div className="flex flex-wrap items-center gap-1.5"><code className="break-all">$ {event.text}</code><Badge variant={failed ? "destructive" : "secondary"}>{label}</Badge></div>{preview.length ? <pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{preview.join("\n")}</pre> : null}{lines.length > 3 ? <Button type="button" variant="ghost" size="xs" onClick={() => setExpanded((current) => !current)}>{expanded ? "Show less" : `… +${lines.length - 3} lines`}</Button> : null}</li>;
  }
  if (event.kind === "tool_call") return <li data-task-chat-tool-call className="break-words text-[12px] text-muted-foreground"><span className="font-medium text-foreground">{event.text}</span>{event.detail ? <span> · {event.detail}</span> : null}{event.toolStatus ? <span> ({event.toolStatus})</span> : null}{event.count && event.count > 1 ? ` ×${event.count}` : ""}</li>;
  if (event.kind === "file_change") return <li className="break-words text-[12px] text-muted-foreground"><span className="font-medium text-foreground">Edited </span>{event.files?.map((file) => <button type="button" className="underline underline-offset-2" onClick={onOpenDiff} key={file}>{file}</button>)} {event.text}</li>;
  return <li className="break-words text-[12px] text-muted-foreground">{event.kind === "test_result" ? <span className="font-medium text-foreground">Tests: </span> : null}{event.text}{event.count && event.count > 1 ? ` ×${event.count}` : ""}</li>;
}

function EventStream({ events, onOpenDiff }: { events: ChatEvent[]; onOpenDiff: () => void }) {
  const groups: Array<{ narration: ChatEvent } | { execution: ChatEvent[] }> = [];
  for (const event of events) {
    if (event.kind === "message" || event.kind === "agent_update") {
      groups.push({ narration: event });
      continue;
    }
    const previous = groups.at(-1);
    if (previous && "execution" in previous) previous.execution.push(event);
    else groups.push({ execution: [event] });
  }
  return <div className="mt-1 space-y-1">{groups.map((group) => "narration" in group ? <AgentBubble key={group.narration.id} message={group.narration.kind === "message"}><Markdown source={group.narration.text} />{group.narration.count && group.narration.count > 1 ? ` ×${group.narration.count}` : ""}</AgentBubble> : <ol data-task-chat-execution-group className="space-y-1 border-l pl-3" key={group.execution.at(0)!.id}>{group.execution.map((event) => <EventLine event={event} onOpenDiff={onOpenDiff} key={event.id} />)}</ol>)}</div>;
}
export function ChatAgentTurn({ item, onOpenDiff, onLoadEvents }: { item: Extract<ChatItem, { kind: "agent_turn" }>; onOpenDiff: () => void; onLoadEvents: () => Promise<void> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (item.finishedAt) return; const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, [item.finishedAt]);
  const running = !item.finishedAt;
  return <div className="flex gap-2" data-task-chat-agent-turn data-task-chat-status={item.status}><ProfileAvatar name={item.agent.name} seed={item.agent.avatarSeed} size="xs" /><div className="min-w-0 flex-1 space-y-1"><div className="flex flex-wrap items-baseline gap-x-2 text-xs"><span className="font-medium">{item.agent.name}</span><time className="text-[11px] text-muted-foreground" dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>{item.intro ? <AgentBubble>{item.intro}</AgentBubble> : null}<Collapsible.Root defaultOpen={running} onOpenChange={(open) => { if (open) void onLoadEvents(); }}><Collapsible.Trigger className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronDown className="size-3" />{running ? `Working for ${duration(item.startedAt, null, now)}` : `Worked for ${duration(item.startedAt, item.finishedAt, now)}`}{item.stats ? ` · +${item.stats.additions} −${item.stats.deletions}` : ""}</Collapsible.Trigger><Collapsible.Panel><EventStream events={item.events} onOpenDiff={onOpenDiff} /></Collapsible.Panel></Collapsible.Root>{item.summary ? <AgentBubble><Markdown source={item.summary} /></AgentBubble> : null}{item.status === "failed" || item.status === "blocked" ? <p className="text-xs text-destructive">{item.agent.name} is {item.status}</p> : item.finishedAt ? <p className="text-xs text-muted-foreground">{item.agent.name} has finished</p> : null}</div></div>;
}

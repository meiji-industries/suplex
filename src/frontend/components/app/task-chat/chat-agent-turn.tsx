import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Collapsible } from "../../ui/collapsible.js";
import { Markdown } from "../markdown.js";
import { ProfileAvatar } from "../profile-avatar.js";
import type { ChatEvent, ChatItem } from "../../../lib/task-chat.js";

function duration(startedAt: string, finishedAt: string | null, now: number): string { return `${Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) / 1_000))}s`; }
function EventLine({ event, onOpenDiff }: { event: ChatEvent; onOpenDiff: () => void }) {
  const label = event.kind === "file_change" ? "Edited" : event.kind === "test_result" ? "Tests:" : event.kind === "tool_call" ? "Tool:" : "";
  const status = event.kind === "command" ? event.status === "running" ? "…" : event.exitCode === 0 ? "✓" : event.exitCode === null || event.exitCode === undefined ? "" : `exit ${event.exitCode}` : "";
  return <li className="break-words text-[12px] text-muted-foreground">{label ? <span className="font-medium text-foreground">{label} </span> : null}{event.files?.length ? <>{event.files.map((file) => <button type="button" className="underline underline-offset-2" onClick={onOpenDiff} key={file}>{file}</button>)} {event.text}</> : event.text}{event.count && event.count > 1 ? ` ×${event.count}` : ""}{status ? <span className="ml-1">{status}</span> : null}</li>;
}
export function ChatAgentTurn({ item, onOpenDiff, onLoadEvents }: { item: Extract<ChatItem, { kind: "agent_turn" }>; onOpenDiff: () => void; onLoadEvents: () => Promise<void> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (item.finishedAt) return; const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, [item.finishedAt]);
  const running = !item.finishedAt;
  return <div className="flex gap-2" data-task-chat-agent-turn data-task-chat-status={item.status}><ProfileAvatar name={item.agent.name} seed={item.agent.avatarSeed} size="xs" /><div className="min-w-0 flex-1 space-y-1"><div className="flex flex-wrap items-baseline gap-x-2 text-xs"><span className="font-medium">{item.agent.name}</span><time className="text-[11px] text-muted-foreground" dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>{item.intro ? <p className="text-[13px]">{item.intro}</p> : null}<Collapsible.Root defaultOpen={running} onOpenChange={(open) => { if (open) void onLoadEvents(); }}><Collapsible.Trigger className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronDown className="size-3" />{running ? `Working for ${duration(item.startedAt, null, now)}` : `Worked for ${duration(item.startedAt, item.finishedAt, now)}`}{item.stats ? ` · +${item.stats.additions} −${item.stats.deletions}` : ""}</Collapsible.Trigger><Collapsible.Panel><ol className="mt-1 space-y-1 border-l pl-3">{item.events.map((event) => <EventLine event={event} onOpenDiff={onOpenDiff} key={event.id} />)}</ol></Collapsible.Panel></Collapsible.Root>{item.summary ? <div className="text-[13px]"><Markdown source={item.summary} /></div> : null}{item.status === "failed" || item.status === "blocked" ? <p className="text-xs text-destructive">{item.agent.name} is {item.status}</p> : item.finishedAt ? <p className="text-xs text-muted-foreground">{item.agent.name} has finished</p> : null}</div></div>;
}

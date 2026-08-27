import { useEffect, useState, type ReactNode } from "react";
import { Brain, CheckCircle2, ChevronDown, ChevronRight, LoaderCircle, Terminal, Wrench } from "lucide-react";

import { Collapsible } from "../../ui/collapsible.js";
import { Badge } from "../../ui/badge.js";
import { Markdown } from "../markdown.js";
import { ProfileAvatar } from "../profile-avatar.js";
import type { ChatEvent, ChatItem } from "../../../lib/task-chat.js";

function duration(startedAt: string, finishedAt: string | null, now: number): string { return `${Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) / 1_000))}s`; }

function AgentBubble({ children, message = false }: { children: ReactNode; message?: boolean }) {
  return <div data-task-chat-agent-bubble data-task-chat-agent-message={message || undefined} className="max-w-[85%] rounded-[6px] border bg-muted/40 px-2.5 py-2 text-[13px]">{children}</div>;
}

function ReasoningEvent({ event }: { event: ChatEvent }) {
  return <li data-task-chat-reasoning className="text-[12px] text-muted-foreground"><div className="flex items-center gap-1.5 text-foreground"><Brain className="size-3.5 text-muted-foreground" />Thinking</div><div className="mt-1 space-y-3 text-muted-foreground"><Markdown source={event.text} /></div></li>;
}

function CommandEvent({ event, running }: { event: ChatEvent; running: boolean }) {
  const isCommand = event.kind === "command";
  const defaultOpen = running && event.status === "running";
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const failed = event.exitCode !== null && event.exitCode !== undefined && event.exitCode !== 0;
  const preview = isCommand ? event.text : event.detail;
  const output = isCommand ? `$ ${event.text}${event.output ? `\n${event.output}` : ""}` : event.output;
  const hasDetails = Boolean(output);
  const label = isCommand ? "Command" : event.text || "Tool";
  const row = <><span className="flex min-w-0 flex-1 items-center gap-1.5"><span className="shrink-0 text-muted-foreground">{isCommand ? <Terminal className="size-3.5" /> : <Wrench className="size-3.5" />}</span><span className="truncate text-foreground">{label}{event.count && event.count > 1 ? ` ×${event.count}` : ""}</span></span>{preview ? <code className="min-w-0 flex-1 truncate text-right text-[12px] text-muted-foreground">{preview}</code> : null}{failed ? <Badge variant="destructive">exit {event.exitCode}</Badge> : null}</>;
  if (!hasDetails) return <li data-task-chat-tool-call className="flex min-w-0 items-center gap-2 py-0.5">{row}</li>;
  return <li data-task-chat-command><Collapsible.Root open={open} onOpenChange={setOpen}><Collapsible.Trigger className="flex w-full min-w-0 items-center gap-2 py-0.5 text-left text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row}{open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}</Collapsible.Trigger><Collapsible.Panel><pre className="mt-1 overflow-x-auto rounded-[6px] border border-border bg-muted/30 p-2 font-mono text-[12px] whitespace-pre">{output}</pre></Collapsible.Panel></Collapsible.Root></li>;
}

function EventLine({ event, onOpenDiff, running }: { event: ChatEvent; onOpenDiff: () => void; running: boolean }) {
  const className = "flex min-w-0 items-center gap-2 py-0.5 text-[12px] text-muted-foreground";
  if (event.kind === "thinking_summary") return <ReasoningEvent event={event} />;
  if (event.kind === "command" || event.kind === "tool_call") return <CommandEvent event={event} running={running} />;
  if (event.kind === "file_change") return <li className={className}><span className="font-medium text-foreground">Edited </span><span className="truncate">{event.files?.map((file) => <button type="button" className="underline underline-offset-2" onClick={onOpenDiff} key={file}>{file}</button>)} {event.text}</span></li>;
  return <li className={className}>{event.kind === "test_result" ? <span className="font-medium text-foreground">Tests: </span> : null}<span className="truncate">{event.text}{event.count && event.count > 1 ? ` ×${event.count}` : ""}</span></li>;
}

function NarrationStream({ events }: { events: ChatEvent[] }) {
  return <div className="space-y-1">{events.filter((event) => event.kind === "message" || event.kind === "agent_update").map((event) => <AgentBubble key={event.id} message={event.kind === "message"}><Markdown source={event.text} />{event.count && event.count > 1 ? ` ×${event.count}` : ""}</AgentBubble>)}</div>;
}

function ExecutionChain({ events, onOpenDiff, running, open, onOpenChange, durationLabel, statsText }: { events: ChatEvent[]; onOpenDiff: () => void; running: boolean; open: boolean; onOpenChange: (open: boolean) => void; durationLabel: string; statsText: string | undefined }) {
  const executionEvents = events.filter((event) => event.kind !== "message" && event.kind !== "agent_update");
  if (executionEvents.length === 0) return <p className="text-xs text-muted-foreground">{durationLabel}{statsText}</p>;
  return <Collapsible.Root open={open} onOpenChange={onOpenChange} data-task-chat-execution-chain><Collapsible.Trigger className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronDown className="size-3" />{running ? <LoaderCircle className="size-3 motion-safe:animate-spin" /> : <CheckCircle2 className="size-3" />}<span data-task-chat-duration>{durationLabel}</span><span data-task-chat-step-count> · {executionEvents.length} {executionEvents.length === 1 ? "step" : "steps"}</span>{statsText}</Collapsible.Trigger><Collapsible.Panel><ol data-task-chat-execution-group className="mt-1 space-y-1">{executionEvents.map((event) => <EventLine event={event} onOpenDiff={onOpenDiff} running={running} key={event.id} />)}</ol></Collapsible.Panel></Collapsible.Root>;
}
export function ChatAgentTurn({ item, onOpenDiff, onLoadEvents }: { item: Extract<ChatItem, { kind: "agent_turn" }>; onOpenDiff: () => void; onLoadEvents: () => Promise<void> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (item.finishedAt) return; const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, [item.finishedAt]);
  const running = !item.finishedAt;
  const [executionOpen, setExecutionOpen] = useState(running);
  useEffect(() => setExecutionOpen(running), [running]);
  const toggleExecution = (open: boolean): void => { setExecutionOpen(open); if (open) void onLoadEvents(); };
  const durationLabel = running ? `Working for ${duration(item.startedAt, null, now)}` : `Worked for ${duration(item.startedAt, item.finishedAt, now)}`;
  const statsText = item.stats ? ` · +${item.stats.additions} −${item.stats.deletions}` : undefined;
  return <div className="flex gap-2" data-task-chat-agent-turn data-task-chat-status={item.status}><ProfileAvatar name={item.agent.name} seed={item.agent.avatarSeed} size="xs" /><div className="min-w-0 flex-1 space-y-1"><div className="flex flex-wrap items-baseline gap-x-2 text-xs"><span className="font-medium">{item.agent.name}</span><time className="text-[11px] text-muted-foreground" dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>{item.intro ? <AgentBubble>{item.intro}</AgentBubble> : null}<ExecutionChain events={item.events} onOpenDiff={onOpenDiff} running={running} open={executionOpen} onOpenChange={toggleExecution} durationLabel={durationLabel} statsText={statsText} /><NarrationStream events={item.events} />{item.summary ? <AgentBubble><Markdown source={item.summary} /></AgentBubble> : null}{item.status === "failed" || item.status === "blocked" ? <p className="text-xs text-destructive">{item.agent.name} is {item.status}</p> : item.finishedAt ? <p className="text-xs text-muted-foreground">{item.agent.name} has finished</p> : null}</div></div>;
}

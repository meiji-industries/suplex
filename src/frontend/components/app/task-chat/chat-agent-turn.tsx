import { useEffect, useState, type ReactNode } from "react";
import { Bookmark, Brain, CheckCircle2, ChevronDown, ChevronRight, FilePenLine, LoaderCircle, Terminal, Wrench } from "lucide-react";

import { Collapsible } from "../../ui/collapsible.js";
import { Badge } from "../../ui/badge.js";
import { Markdown } from "../markdown.js";
import { ProfileAvatar } from "../profile-avatar.js";
import { splitStructuredResult, type ChatEvent, type ChatItem } from "../../../lib/task-chat.js";

function duration(startedAt: string, finishedAt: string | null, now: number): string { return `${Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) / 1_000))}s`; }

function stringAt(text: string, start: number): { value: string; end: number } | undefined {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\" ) { index += 1; continue; }
    if (text[index] === "\"") {
      try { const value = JSON.parse(text.slice(start, index + 1)); return typeof value === "string" ? { value, end: index + 1 } : undefined; } catch { return undefined; }
    }
  }
  return undefined;
}

function topLevelSummary(text: string): string | undefined {
  let index = 1;
  while (index < text.length) {
    while (/\s|,/.test(text[index] ?? "")) index += 1;
    if (text[index] === "}") return undefined;
    if (text[index] !== "\"") return undefined;
    const key = stringAt(text, index);
    if (!key) return undefined;
    index = key.end;
    while (/\s/.test(text[index] ?? "")) index += 1;
    if (text[index] !== ":") return undefined;
    index += 1;
    while (/\s/.test(text[index] ?? "")) index += 1;
    if (key.value === "summary" && text[index] === "\"") return stringAt(text, index)?.value;
    let depth = 0;
    for (; index < text.length; index += 1) {
      if (text[index] === "\"") { const value = stringAt(text, index); if (!value) return undefined; index = value.end - 1; continue; }
      if (text[index] === "{" || text[index] === "[") depth += 1;
      else if (text[index] === "}" || text[index] === "]") { if (depth === 0) return undefined; depth -= 1; }
      else if (text[index] === "," && depth === 0) { index += 1; break; }
    }
  }
  return undefined;
}

export function structuredResultSummary(text: string): string | undefined {
  const { prose, result } = splitStructuredResult(text);
  if (result === undefined) return undefined;
  let summary: string | undefined;
  try { const parsed = JSON.parse(result); if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.summary === "string") summary = parsed.summary; } catch { /* clipped machine result */ }
  summary ??= topLevelSummary(result);
  return [prose, summary].filter(Boolean).join(" ") || undefined;
}

function isStructuredResult(event: ChatEvent): boolean {
  return (event.kind === "message" || event.kind === "agent_update") && splitStructuredResult(event.text).result !== undefined;
}

function AgentBubble({ children }: { children: ReactNode }) {
  return <div data-task-chat-agent-bubble className="max-w-[85%] rounded-[6px] px-2.5 py-2 text-[13px]">{children}</div>;
}

function ReasoningEvent({ event }: { event: ChatEvent }) {
  return <li data-task-chat-reasoning className="text-[12px] text-muted-foreground"><div className="flex items-center gap-1.5 text-foreground"><Brain className="size-3.5 text-muted-foreground" />Thinking</div><div className="mt-1 space-y-3 text-muted-foreground"><Markdown source={event.text} />{event.count && event.count > 1 ? ` ×${event.count}` : ""}</div></li>;
}

function PatchFileEvent({ file, running }: { file: NonNullable<ChatEvent["patch"]>["files"][number]; running: boolean }) {
  const defaultOpen = running;
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  return <li data-task-chat-patch><Collapsible.Root open={open} onOpenChange={setOpen}><Collapsible.Trigger className="flex w-full min-w-0 items-center gap-2 py-0.5 text-left text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><FilePenLine className="size-3.5 shrink-0 text-muted-foreground" /><span className="font-medium text-foreground">{file.operation}</span><code className="min-w-0 flex-1 truncate text-muted-foreground">{file.path}</code><span className="shrink-0 text-green-700 dark:text-green-400">+{file.additions}</span><span className="shrink-0 text-red-700 dark:text-red-400">−{file.deletions}</span>{open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}</Collapsible.Trigger><Collapsible.Panel><div className="mt-1 overflow-x-auto border border-border font-mono text-[12px]" data-task-chat-patch-diff>{file.rows.map((row, index) => <div className={`grid min-w-max grid-cols-[3rem_3rem_1fr] ${row.kind === "addition" ? "bg-green-500/10 text-green-950 dark:text-green-100" : row.kind === "deletion" ? "bg-red-500/10 text-red-950 dark:text-red-100" : ""}`} key={`${index}-${row.text}`}><span className="border-r border-border px-1 text-right text-muted-foreground">{row.oldLine ?? ""}</span><span className="border-r border-border px-1 text-right text-muted-foreground">{row.newLine ?? ""}</span><code className="whitespace-pre px-2">{row.kind === "addition" ? "+" : row.kind === "deletion" ? "-" : " "}{row.text}</code></div>)}</div></Collapsible.Panel></Collapsible.Root></li>;
}

function PatchEvent({ event, running }: { event: ChatEvent; running: boolean }) {
  return <>{event.patch!.files.map((file) => <PatchFileEvent file={file} running={running && event.status === "running"} key={`${event.id}-${file.path}`} />)}</>;
}

function CompletionMarker({ name, status }: { name: string; status: "completed" | "failed" | "blocked" }) {
  const detail = status === "completed" ? { className: "text-muted-foreground", label: `${name} has finished` } : status === "failed" ? { className: "text-destructive", label: `${name} has failed` } : { className: "text-amber-700", label: `${name} is blocked` };
  return <div className={`flex items-center gap-1.5 py-1 text-xs ${detail.className}`} data-task-chat-completion-marker data-task-chat-checkpoint-status={status}><Bookmark className="size-3 shrink-0" /><span>{detail.label}</span><span className="h-px flex-1 bg-border" /></div>;
}

function CommandEvent({ event, running }: { event: ChatEvent; running: boolean }) {
  const isCommand = event.kind === "command";
  const defaultOpen = running && event.status === "running";
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const failed = event.exitCode !== null && event.exitCode !== undefined && event.exitCode !== 0;
  const preview = isCommand && event.text === "Apply patch" ? undefined : isCommand ? event.text : event.detail;
  const output = isCommand ? `$ ${event.text}${event.output ? `\n${event.output}` : ""}` : event.output;
  const hasDetails = Boolean(output);
  const label = isCommand ? event.text === "Apply patch" ? "Apply patch" : "Command" : event.text || "Tool";
  const row = <><span className={`flex min-w-0 items-center gap-1.5 ${preview ? "max-w-[40%] shrink-0" : "flex-1"}`}><span className="shrink-0 text-muted-foreground">{isCommand ? <Terminal className="size-3.5" /> : <Wrench className="size-3.5" />}</span><span className="truncate text-foreground">{label}{event.count && event.count > 1 ? ` ×${event.count}` : ""}</span></span>{preview ? <code className="min-w-0 flex-1 truncate text-left text-[12px] text-muted-foreground">{preview}</code> : null}{failed ? <Badge variant="destructive">exit {event.exitCode}</Badge> : null}</>;
  if (!hasDetails) return <li data-task-chat-tool-call className="flex min-w-0 items-center gap-2 py-0.5">{row}</li>;
  return <li data-task-chat-command><Collapsible.Root open={open} onOpenChange={setOpen}><Collapsible.Trigger className="flex w-full min-w-0 items-center gap-2 py-0.5 text-left text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row}{open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}</Collapsible.Trigger><Collapsible.Panel><pre className="mt-1 overflow-x-auto rounded-[6px] border border-border bg-muted/30 p-2 font-mono text-[12px] whitespace-pre">{output}</pre></Collapsible.Panel></Collapsible.Root></li>;
}

function EventLine({ event, onOpenDiff, running }: { event: ChatEvent; onOpenDiff: () => void; running: boolean }) {
  const className = "flex min-w-0 items-center gap-2 py-0.5 text-[12px] text-muted-foreground";
  if (event.kind === "thinking_summary" || event.kind === "message" || event.kind === "agent_update") return <ReasoningEvent event={event} />;
  if (event.patch) return <PatchEvent event={event} running={running} />;
  if (event.kind === "command" || event.kind === "tool_call") return <CommandEvent event={event} running={running} />;
  if (event.kind === "file_change") return <li className={className}><span className="font-medium text-foreground">Edited </span><span className="truncate">{event.files?.map((file) => <button type="button" className="underline underline-offset-2" onClick={onOpenDiff} key={file}>{file}</button>)} {event.text}</span></li>;
  return <li className={className}>{event.kind === "test_result" ? <span className="font-medium text-foreground">Tests: </span> : null}<span className="truncate">{event.text}{event.count && event.count > 1 ? ` ×${event.count}` : ""}</span></li>;
}

function ExecutionChain({ events, intro, onOpenDiff, running, open, onOpenChange, durationLabel, statsText }: { events: ChatEvent[]; intro: string | undefined; onOpenDiff: () => void; running: boolean; open: boolean; onOpenChange: (open: boolean) => void; durationLabel: string; statsText: string | undefined }) {
  const executionEvents = (intro ? [{ id: "intro", at: "", kind: "thinking_summary", text: intro }, ...events] : events).filter((event) => event.phase !== "final_answer" && !isStructuredResult(event));
  if (executionEvents.length === 0) return <p className="text-xs text-muted-foreground">{durationLabel}{statsText}</p>;
  return <Collapsible.Root open={open} onOpenChange={onOpenChange} data-task-chat-execution-chain><Collapsible.Trigger className="flex w-full items-center gap-1 text-xs text-muted-foreground">{running ? <LoaderCircle className="size-3 motion-safe:animate-spin" /> : <CheckCircle2 className="size-3" />}<span data-task-chat-duration>{durationLabel}</span><span data-task-chat-step-count> · {executionEvents.length} {executionEvents.length === 1 ? "step" : "steps"}</span>{statsText}{open ? <ChevronDown className="ml-auto size-3 shrink-0" /> : <ChevronRight className="ml-auto size-3 shrink-0" />}</Collapsible.Trigger><Collapsible.Panel><ol data-task-chat-execution-group className="mt-1 space-y-1">{executionEvents.map((event) => <EventLine event={event} onOpenDiff={onOpenDiff} running={running} key={event.id} />)}</ol></Collapsible.Panel></Collapsible.Root>;
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
  const finalAnswer = [...item.events].reverse().find((event) => event.phase === "final_answer");
  const finalAnswerSummary = finalAnswer && (isStructuredResult(finalAnswer) ? structuredResultSummary(finalAnswer.text) : finalAnswer.text.trim());
  const fallbackSummary = finalAnswerSummary || item.events.filter(isStructuredResult).map((event) => structuredResultSummary(event.text)).find((summary): summary is string => Boolean(summary));
  const summary = item.summary ?? fallbackSummary;
  return <div className="flex gap-2" data-task-chat-agent-turn data-task-chat-status={item.status}><ProfileAvatar name={item.agent.name} seed={item.agent.avatarSeed} size="xs" /><div className="min-w-0 flex-1 space-y-1"><div className="flex flex-wrap items-baseline gap-x-2 text-xs"><span className="font-medium">{item.agent.name}</span><time className="text-[11px] text-muted-foreground" dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div><ExecutionChain events={item.events} intro={item.intro} onOpenDiff={onOpenDiff} running={running} open={executionOpen} onOpenChange={toggleExecution} durationLabel={durationLabel} statsText={statsText} />{summary ? <AgentBubble><Markdown source={summary} /></AgentBubble> : null}{item.finishedAt ? <CompletionMarker name={item.agent.name} status={item.status === "failed" || item.status === "blocked" ? item.status : "completed"} /> : null}</div></div>;
}

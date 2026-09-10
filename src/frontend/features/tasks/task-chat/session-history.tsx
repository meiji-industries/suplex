import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { SessionHistoryPageSchema, type NativeHistoryMessage } from "../../../../tasks/history/contracts.js";
import { readJson } from "../../../lib/api.js";
import { Alert, AlertDescription } from "../../../components/ui/alert.js";
import { Button } from "../../../components/ui/button.js";
import { Markdown } from "../../../components/app/markdown.js";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "../../../components/ai-elements/tool.js";
import { anchoredScrollTop, historyAtBottom, mergeNativeHistory } from "./session-history-state.js";

const toolStates = { pending: "input-streaming", running: "input-available", completed: "output-available", error: "output-error" } satisfies Record<Extract<NativeHistoryMessage["content"][number], { type: "tool" }>["status"], ToolPart["state"]>;
const maximumVisibleToolText = 20_000;

function visibleToolText(text: string | null): string | null {
  if (!text || text.length <= maximumVisibleToolText) return text;
  return `${text.slice(0, maximumVisibleToolText)}\n\nOutput was shortened in this view.`;
}

export function SessionHistory({ taskId, sessionId, assistantLabel, poll }: { taskId: string; sessionId: string; assistantLabel: string; poll: boolean }) {
  const [messages, setMessages] = useState<NativeHistoryMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [following, setFollowing] = useState(true);
  const messagesRef = useRef<NativeHistoryMessage[]>([]);
  const viewport = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const requestIdentity = useRef(0);
  const active = useRef(true);
  const initialized = useRef(false);
  const followingRef = useRef(true);
  const anchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const read = useCallback(async (before?: string, placement: "earlier" | "latest" = "latest", resetCursor = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const identity = ++requestIdentity.current;
    setReading(true);
    if (placement === "earlier" && viewport.current) anchor.current = { scrollHeight: viewport.current.scrollHeight, scrollTop: viewport.current.scrollTop };
    const abort = new AbortController();
    controller.current = abort;
    try {
      const query = before ? `?before=${encodeURIComponent(before)}` : "";
      const page = SessionHistoryPageSchema.parse(await readJson(`/api/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}/history${query}`, { signal: abort.signal }));
      if (!active.current || requestIdentity.current !== identity) return;
      const hadMessages = messagesRef.current.length > 0;
      const merged = mergeNativeHistory(messagesRef.current, page.messages, placement);
      messagesRef.current = merged;
      setMessages(merged);
      if (placement === "earlier" || resetCursor || !initialized.current || !hadMessages) setOlderCursor(page.olderCursor);
      initialized.current = true;
      setError("");
    } catch (error) {
      anchor.current = null;
      if (active.current && requestIdentity.current === identity && !abort.signal.aborted) setError(error instanceof Error ? error.message : "Session history is not available");
    } finally {
      if (requestIdentity.current === identity) {
        if (controller.current === abort) controller.current = null;
        inFlight.current = false;
        if (active.current) setReading(false);
      }
    }
  }, [sessionId, taskId]);

  useEffect(() => {
    active.current = true;
    void read();
    const timer = poll ? setInterval(() => void read(), 3_000) : null;
    return () => {
      active.current = false;
      if (timer) clearInterval(timer);
      controller.current?.abort();
      controller.current = null;
      requestIdentity.current += 1;
      inFlight.current = false;
    };
  }, [poll, read]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (anchor.current) {
      element.scrollTop = anchoredScrollTop(anchor.current, element.scrollHeight);
      anchor.current = null;
      return;
    }
    if (followingRef.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const jumpToLive = () => {
    followingRef.current = true;
    setFollowing(true);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  };

  return <div className="relative flex min-h-0 flex-1 flex-col">
    {error ? <div className="shrink-0 px-3 py-2"><Alert variant="destructive"><AlertDescription><span>{messages.length ? "Session history is out of date. " : ""}{error}</span> <Button size="xs" variant="outline" disabled={reading} onClick={() => void read(undefined, "latest", true)}>Retry</Button></AlertDescription></Alert></div> : null}
    <div ref={viewport} data-session-history className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2" onScroll={event => {
      const atBottom = historyAtBottom(event.currentTarget);
      followingRef.current = atBottom;
      setFollowing(atBottom);
    }}>
      {olderCursor ? <div className="mb-3 flex justify-center"><Button size="xs" variant="outline" disabled={reading} onClick={() => void read(olderCursor, "earlier")}>Open earlier messages</Button></div> : null}
      {!messages.length && !reading && !error ? <p className="text-xs text-muted-foreground">No messages yet.</p> : null}
      {!messages.length && reading ? <p className="text-xs text-muted-foreground" aria-busy="true">Forge reads the session history.</p> : null}
      <div className="grid gap-4">{messages.map(message => <article key={message.id} data-native-message-id={message.id} className="min-w-0 border-b pb-4 last:border-b-0">
        <header className="mb-2 flex items-center gap-2 text-xs"><span className="font-medium">{message.role === "user" ? "You" : assistantLabel}</span>{message.createdAt !== null ? <time className="text-muted-foreground" dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> : null}</header>
        <div className="grid min-w-0 gap-2">{message.content.map(part => part.type === "text"
          ? <Markdown key={part.id} source={part.text} />
          : <Tool key={part.id}>
            <ToolHeader type="dynamic-tool" toolName={part.name} state={toolStates[part.status]} />
            <ToolContent><ToolInput input={part.input} /><ToolOutput output={visibleToolText(part.output)} errorText={visibleToolText(part.error) ?? undefined} /></ToolContent>
          </Tool>)}</div>
      </article>)}</div>
    </div>
    {!following && messages.length ? <div className="absolute bottom-3 right-3"><Button size="sm" variant="secondary" onClick={jumpToLive}><ArrowDown />Open latest messages</Button></div> : null}
  </div>;
}

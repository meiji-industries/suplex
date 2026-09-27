import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { SessionHistoryLiveEventSchema, SessionHistoryPageSchema, type NativeHistoryMessage, type SessionHistoryLiveEvent } from "../../../contracts/history.js";
import { readJsonUnchecked } from "../../../lib/api.js";
import { clientTabId } from "../../../shell/client-lifecycle.js";
import { Alert, AlertDescription } from "../../../components/ui/alert.js";
import { Button } from "../../../components/ui/button.js";
import { Markdown } from "../../../components/app/markdown.js";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "../../../components/ai-elements/tool.js";
import { anchoredScrollTop, historyAtBottom, mergeNativeHistory, readSnapshotHistory, reconcileLiveHistory } from "./session-history-state.js";

const toolStates = { pending: "input-streaming", running: "input-available", completed: "output-available", error: "output-error" } satisfies Record<Extract<NativeHistoryMessage["content"][number], { type: "tool" }>["status"], ToolPart["state"]>;
const maximumVisibleToolText = 20_000;

function shortenedToolText(text: string | null): { text: string | null; shortened: boolean } {
  if (!text || text.length <= maximumVisibleToolText) return { text, shortened: false };
  return { text: `${text.slice(0, maximumVisibleToolText)}\n\nOutput was shortened in this view.`, shortened: true };
}

function HistoryToolContent({ part }: { part: Extract<NativeHistoryMessage["content"][number], { type: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const output = shortenedToolText(part.output);
  const error = shortenedToolText(part.error);
  const shortened = output.shortened || error.shortened;
  return <ToolContent>
    <ToolInput input={part.input} />
    <ToolOutput output={expanded ? part.output : output.text} errorText={(expanded ? part.error : error.text) ?? undefined} />
    {shortened && !expanded ? <Button size="xs" variant="outline" onClick={() => setExpanded(true)}>Open full output</Button> : null}
  </ToolContent>;
}

type LiveConnection =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "stale"; message: string };

const reconnectDelay = (attempt: number): number => Math.min(10_000, 1_000 * 2 ** attempt);

export function SessionHistory({ taskId, sessionId }: { taskId: string; sessionId: string }) {
  const [messages, setMessages] = useState<NativeHistoryMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [connection, setConnection] = useState<LiveConnection>({ kind: "connecting" });
  const [reading, setReading] = useState(false);
  const [following, setFollowing] = useState(true);
  const messagesRef = useRef<NativeHistoryMessage[]>([]);
  const liveOrderRef = useRef<string[]>([]);
  const viewport = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const connectionGeneration = useRef(0);
  const initialized = useRef(false);
  const followingRef = useRef(true);
  const anchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const connectRef = useRef<() => void>(() => undefined);
  const resizeFollowing = useRef(false);
  const viewportSize = useRef<{ scrollHeight: number; clientHeight: number } | null>(null);
  const followFrame = useRef<number | undefined>(undefined);
  const releaseFollowFrame = useRef<number | undefined>(undefined);

  const followAfterResize = useCallback(() => {
    const element = viewport.current;
    if (!element || !followingRef.current) return;
    resizeFollowing.current = true;
    if (followFrame.current !== undefined) cancelAnimationFrame(followFrame.current);
    if (releaseFollowFrame.current !== undefined) cancelAnimationFrame(releaseFollowFrame.current);
    followFrame.current = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
      viewportSize.current = { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      releaseFollowFrame.current = requestAnimationFrame(() => { resizeFollowing.current = false; });
    });
  }, []);

  const loadPage = useCallback(async (before: string | undefined, signal: AbortSignal) => {
    const query = before ? `?before=${encodeURIComponent(before)}` : "";
    const path = `/api/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}/history${query}`;
    return SessionHistoryPageSchema.parse(await readJsonUnchecked(path, { signal }));
  }, [sessionId, taskId]);

  useEffect(() => {
    const generation = ++connectionGeneration.current;
    const abort = new AbortController();
    controller.current = abort;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let retryAttempt = 0;
    let eventQueue = Promise.resolve();

    messagesRef.current = [];
    liveOrderRef.current = [];
    initialized.current = false;
    followingRef.current = true;
    setMessages([]);
    setOlderCursor(null);
    setFollowing(true);
    setConnection({ kind: "connecting" });

    const isCurrent = (source: WebSocket): boolean => !disposed && generation === connectionGeneration.current && source === socket;
    const applyEvent = async (event: SessionHistoryLiveEvent, source: WebSocket): Promise<void> => {
      if (!isCurrent(source)) return;
      if (event.type === "error") {
        setConnection({ kind: "stale", message: event.message });
        return;
      }

      let current = { messages: messagesRef.current, order: liveOrderRef.current };
      if (event.type === "snapshot" && initialized.current) {
        try {
          const caughtUp = await readSnapshotHistory(current.messages, event.page, before => loadPage(before, abort.signal));
          if (!isCurrent(source)) return;
          current = { messages: caughtUp.messages, order: current.order };
        } catch (error) {
          if (!abort.signal.aborted && isCurrent(source)) {
            setConnection({ kind: "stale", message: error instanceof Error ? error.message : "Live output is not available." });
            source.close();
          }
          return;
        }
      }

      const next = event.type === "snapshot"
        ? reconcileLiveHistory(current, event.page.messages, event.order)
        : reconcileLiveHistory(current, event.messages, event.order, event.removedIds);
      if (!isCurrent(source)) return;
      messagesRef.current = next.messages;
      liveOrderRef.current = next.order;
      setMessages(next.messages);
      if (!initialized.current && event.type === "snapshot") setOlderCursor(event.page.olderCursor);
      initialized.current = true;
      retryAttempt = 0;
      setConnection({ kind: "live" });
    };

    const connect = (): void => {
      if (disposed) return;
      setConnection(current => current.kind === "live" ? current : { kind: "connecting" });
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const path = `/api/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}/history/live`;
      const tabId = clientTabId();
      const nextSocket = new WebSocket(`${scheme}://${location.host}${path}${tabId ? `?tabId=${encodeURIComponent(tabId)}` : ""}`);
      socket = nextSocket;
      nextSocket.onmessage = messageEvent => {
        if (!isCurrent(nextSocket)) return;
        let raw: unknown;
        try {
          raw = typeof messageEvent.data === "string" ? JSON.parse(messageEvent.data) : undefined;
        } catch {
          setConnection({ kind: "stale", message: "Suplex received an invalid live output event." });
          nextSocket.close();
          return;
        }
        const parsed = SessionHistoryLiveEventSchema.safeParse(raw);
        if (!parsed.success) {
          setConnection({ kind: "stale", message: "Suplex received an invalid live output event." });
          nextSocket.close();
          return;
        }
        eventQueue = eventQueue.then(() => applyEvent(parsed.data, nextSocket));
      };
      nextSocket.onclose = () => {
        if (!isCurrent(nextSocket)) return;
        setConnection({ kind: "stale", message: "Live output is out of date. Suplex will retry." });
        retryTimer = window.setTimeout(connect, reconnectDelay(retryAttempt++));
      };
    };

    connectRef.current = () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      if (socket) {
        const previous = socket;
        socket = null;
        previous.close();
      }
      retryAttempt = 0;
      connect();
    };
    connect();
    return () => {
      disposed = true;
      connectionGeneration.current += 1;
      abort.abort();
      if (controller.current === abort) controller.current = null;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
      socket = null;
      connectRef.current = () => undefined;
    };
  }, [loadPage, sessionId, taskId]);

  const readEarlier = async (): Promise<void> => {
    if (!olderCursor || reading || !controller.current) return;
    const generation = connectionGeneration.current;
    const abort = controller.current;
    setReading(true);
    try {
      const page = await loadPage(olderCursor, abort.signal);
      if (generation !== connectionGeneration.current || abort.signal.aborted) return;
      if (viewport.current) anchor.current = { scrollHeight: viewport.current.scrollHeight, scrollTop: viewport.current.scrollTop };
      const merged = mergeNativeHistory(messagesRef.current, page.messages, "earlier");
      messagesRef.current = merged;
      setMessages(merged);
      setOlderCursor(page.olderCursor);
    } catch (error) {
      anchor.current = null;
      if (generation === connectionGeneration.current && !abort.signal.aborted) {
        setConnection({ kind: "stale", message: error instanceof Error ? error.message : "Earlier output is not available." });
      }
    } finally {
      if (generation === connectionGeneration.current) setReading(false);
    }
  };

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (anchor.current) {
      element.scrollTop = anchoredScrollTop(anchor.current, element.scrollHeight);
      anchor.current = null;
      return;
    }
    if (followingRef.current) element.scrollTop = element.scrollHeight;
    viewportSize.current = { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  }, [messages]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(followAfterResize);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (followFrame.current !== undefined) cancelAnimationFrame(followFrame.current);
      if (releaseFollowFrame.current !== undefined) cancelAnimationFrame(releaseFollowFrame.current);
      resizeFollowing.current = false;
    };
  }, [followAfterResize]);

  const jumpToLive = () => {
    followingRef.current = true;
    setFollowing(true);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  };

  return <div className="relative flex h-full min-h-0 flex-1 flex-col">
    {connection.kind === "stale" ? <div className="shrink-0 px-3 py-2"><Alert variant="destructive"><AlertDescription><span>{connection.message}</span> <Button size="xs" variant="outline" onClick={() => connectRef.current()}>Retry</Button></AlertDescription></Alert></div> : null}
    <div ref={viewport} data-session-history className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2" onScroll={event => {
      const previousSize = viewportSize.current;
      const nextSize = { scrollHeight: event.currentTarget.scrollHeight, clientHeight: event.currentTarget.clientHeight };
      viewportSize.current = nextSize;
      const sizeChanged = previousSize !== null && (previousSize.scrollHeight !== nextSize.scrollHeight || previousSize.clientHeight !== nextSize.clientHeight);
      if (sizeChanged && followingRef.current) {
        followAfterResize();
        return;
      }
      if (resizeFollowing.current) return;
      const atBottom = historyAtBottom(event.currentTarget);
      followingRef.current = atBottom;
      setFollowing(atBottom);
    }}>
      {olderCursor ? <div className="mb-3 flex justify-center"><Button size="xs" variant="outline" disabled={reading} onClick={() => void readEarlier()}>Open earlier messages</Button></div> : null}
      {!messages.length && connection.kind === "live" ? <p className="text-xs text-muted-foreground">No messages yet.</p> : null}
      {!messages.length && connection.kind === "connecting" ? <p className="text-xs text-muted-foreground" aria-busy="true">Suplex connects to live output.</p> : null}
      <div className="grid gap-4">{messages.map(message => <article key={message.id} data-native-message-id={message.id} className="min-w-0">
        {message.role === "user" ? <header className="mb-2 text-xs font-medium">Instruction</header> : null}
        <div className="grid min-w-0 gap-2">{message.content.map(part => part.type === "text"
          ? <Markdown key={part.id} source={part.text} />
          : <Tool key={part.id}>
            <ToolHeader type="dynamic-tool" toolName={part.name} input={part.input} state={toolStates[part.status]} />
            <HistoryToolContent part={part} />
          </Tool>)}</div>
      </article>)}</div>
    </div>
    {!following && messages.length ? <div className="absolute bottom-3 right-3"><Button size="sm" variant="secondary" onClick={jumpToLive}><ArrowDown />Open latest messages</Button></div> : null}
  </div>;
}

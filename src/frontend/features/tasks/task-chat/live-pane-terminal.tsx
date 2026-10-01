import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type JSX, useEffect, useRef, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { Button } from "../../../components/ui/button.js";

export type TerminalStatus = "connecting" | "live" | "reconnecting" | "taken_over" | "ended";

function ReconnectingStatus() {
  const [frame, setFrame] = useState(0);
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  useEffect(() => {
    const timer = window.setInterval(() => setFrame(value => (value + 1) % frames.length), 80);
    return () => window.clearInterval(timer);
  }, [frames.length]);
  return <span role="status">Connection lost <span aria-hidden="true" className="inline-block w-[1ch] font-mono">{frames[frame]}</span></span>;
}

export function reconnectDelayMs(attempt: number): number {
  return [250, 500, 1_000, 2_000, 5_000][Math.min(attempt, 4)] ?? 5_000;
}

export function observerViewport(dimensions: { cols: number; rows: number }): { cols: number; rows: number } {
  return {
    cols: Math.min(300, Math.max(20, Math.round(dimensions.cols))),
    rows: Math.min(150, Math.max(5, Math.round(dimensions.rows))),
  };
}

export function terminalCloseStatus(code: number): TerminalStatus | null {
  if (code === 4498) return "taken_over";
  if (code === 1000 || code === 4403) return "ended";
  return null;
}

export function terminalMessageStatus(current: TerminalStatus, message: "open" | "frame"): TerminalStatus {
  return message === "frame" ? "live" : current;
}

export function viewportAtTail(viewport: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">, tailScrollTop = viewport.scrollHeight - viewport.clientHeight): boolean {
  return Math.abs(viewport.scrollTop - Math.max(0, tailScrollTop)) <= 1;
}

/** Reads the scroll owner from an `open` message: "local" for the host PTY, "remote" (Herdr) otherwise. */
export function terminalScrollMode(value: unknown): "remote" | "local" {
  return value === "local" ? "local" : "remote";
}

/** Replay progress for a host PTY snapshot; terminal-generated input goes to the server only in "idle". */
export type ReplayState = "idle" | "snapshot" | "parsing";

export function nextReplayState(state: ReplayState, event: "start" | "end" | "parsed"): ReplayState {
  if (event === "start") return "snapshot";
  if (event === "end") return state === "snapshot" ? "parsing" : state;
  return state === "parsing" ? "idle" : state;
}

export function bufferAtTail(buffer: { viewportY: number; baseY: number }): boolean {
  return buffer.viewportY >= buffer.baseY;
}

/** Converts a wheel delta into a Herdr scroll command; sub-pixel deltas are ignored. */
export function wheelToScroll(deltaY: number, rowHeightPx: number): { direction: "up" | "down"; lines: number } | null {
  if (!Number.isFinite(deltaY) || !Number.isFinite(rowHeightPx) || rowHeightPx <= 0 || Math.abs(deltaY) < 1) return null;
  return { direction: deltaY < 0 ? "up" : "down", lines: Math.max(1, Math.round(Math.abs(deltaY) / rowHeightPx)) };
}

export function terminalTheme(host: HTMLElement): ITheme {
  const styles = getComputedStyle(host);
  const color = (name: string): string => styles.getPropertyValue(name).trim();
  return { background: color("--background"), foreground: color("--foreground"), cursor: color("--foreground"), cursorAccent: color("--background"), selectionBackground: color("--muted") };
}

export function LivePaneTerminal({ taskId, role, paneId }: { taskId: string; role: "root" | "worker" | "shell"; paneId: string | null }): JSX.Element {
  return <PaneTerminal path={`/api/tasks/${encodeURIComponent(taskId)}/pane/${encodeURIComponent(role)}/terminal`} interactive={role === "shell"} paneId={paneId} label={`Live pane output for ${role}`} />;
}

/** `onEnded` replaces the ended notice: the owner closes the terminal instead. */
export function PaneTerminal({ path, interactive, paneId, label, onEnded }: { path: string; interactive: boolean; paneId: string | null; label: string; onEnded?: () => void }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<TerminalStatus>(paneId || interactive ? "connecting" : "ended");
  const followTailRef = useRef(true);
  const [status, setStatus] = useState<TerminalStatus>(paneId || interactive ? "connecting" : "ended");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [scrolledUp, setScrolledUp] = useState(false);
  const [connection, setConnection] = useState(0);
  const [localScroll, setLocalScroll] = useState(false);
  const jumpToTailRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (!host || !viewport || (!paneId && !interactive)) { statusRef.current = "ended"; setStatus("ended"); return; }
    let disposed = false;
    let attempt = 0;
    let retry: number | undefined;
    let resizeTimer: number | undefined;
    // Host PTY connections keep scrollback in xterm and replay a snapshot on connect.
    let local = false;
    let replay: ReplayState = "idle";
    let replayCount = 0;
    followTailRef.current = true;
    setScrolledUp(false);
    const terminal = new Terminal({ allowProposedApi: true, cursorBlink: interactive, cursorStyle: "block", disableStdin: !interactive, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, lineHeight: 1.2, scrollback: 0, macOptionIsMeta: true, theme: terminalTheme(host) });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener")));
    terminal.open(host);
    try { const webgl = new WebglAddon(); terminal.loadAddon(webgl); webgl.onContextLoss(() => webgl.dispose()); } catch { /* DOM renderer fallback */ }
    const setTerminalStatus = (next: TerminalStatus): void => { statusRef.current = next; setStatus(next); };
    const syncReadOnlySurface = (): void => {
      if (interactive || local) return;
      const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return;
      const bounds = screen.getBoundingClientRect();
      if (bounds.width > 0) host.style.width = `${Math.ceil(bounds.width)}px`;
      if (bounds.height > 0) host.style.height = `${Math.ceil(bounds.height)}px`;
    };
    const localTailScrollTop = (): number => {
      const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
      const screenHeight = screen?.getBoundingClientRect().height ?? 0;
      if (screenHeight <= 0 || terminal.rows <= 0) return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      let tailRow = terminal.buffer.active.cursorY + 1;
      for (let row = terminal.rows - 1; row >= tailRow; row--) {
        if (terminal.buffer.active.getLine(row)?.translateToString(true).trim()) { tailRow = row + 1; break; }
      }
      const contentBottom = tailRow * (screenHeight / terminal.rows);
      return Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, contentBottom - viewport.clientHeight));
    };
    const followTail = (): void => {
      if (!followTailRef.current) return;
      if (local) terminal.scrollToBottom();
      else viewport.scrollTop = interactive ? viewport.scrollHeight : localTailScrollTop();
      setScrolledUp(false);
    };
    const updateLocalScroll = (): void => {
      if (interactive || local) return;
      followTailRef.current = viewportAtTail(viewport, localTailScrollTop());
      setScrolledUp(!followTailRef.current);
    };
    viewport.addEventListener("scroll", updateLocalScroll);
    const send = (message: string | ArrayBuffer): void => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(message);
    };
    jumpToTailRef.current = () => {
      if (interactive && !local) send(JSON.stringify({ type: "scroll", direction: "down", lines: 10_000 }));
      else { followTailRef.current = true; followTail(); }
    };
    const fitToPanel = (): void => {
      const proposed = fit.proposeDimensions();
      if (!proposed) return;
      const next = observerViewport(proposed);
      if (terminal.cols === next.cols && terminal.rows === next.rows) return;
      terminal.resize(next.cols, next.rows);
      send(JSON.stringify({ type: "resize", cols: next.cols, rows: next.rows }));
    };
    const connect = (): void => {
      if (disposed) return;
      local = false;
      replay = "idle";
      const proposed = interactive ? observerViewport(fit.proposeDimensions() ?? { cols: terminal.cols, rows: terminal.rows }) : undefined;
      if (proposed) terminal.resize(proposed.cols, proposed.rows);
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const query = proposed ? `?cols=${proposed.cols}&rows=${proposed.rows}` : "";
      const socket = new WebSocket(`${scheme}://${location.host}${path}${query}`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      if (statusRef.current !== "live") setTerminalStatus(attempt === 0 ? "connecting" : "reconnecting");
      socket.onmessage = (event) => {
        if (socket !== socketRef.current) return;
        if (typeof event.data !== "string") {
          const wasFollowing = followTailRef.current;
          terminal.write(new Uint8Array(event.data as ArrayBuffer), () => {
            if (disposed || socket !== socketRef.current) return;
            syncReadOnlySurface();
            if (wasFollowing) { followTailRef.current = true; followTail(); }
            if (statusRef.current !== "live") setTerminalStatus(terminalMessageStatus(statusRef.current, "frame"));
            attempt = 0;
            setErrorMessage(undefined);
          });
          return;
        }
        let message: { type?: string; cols?: number; rows?: number; reason?: string; message?: string; scroll?: unknown; state?: string };
        try { message = JSON.parse(event.data) as typeof message; }
        catch { setErrorMessage("Suplex received an invalid terminal event."); setTerminalStatus("ended"); socket.close(1000); return; }
        if (message.type === "open") {
          setErrorMessage(undefined);
          setTerminalStatus(terminalMessageStatus(statusRef.current, "open"));
          local = terminalScrollMode(message.scroll) === "local";
          terminal.options.scrollback = local ? 10_000 : 0;
          setLocalScroll(local);
          if (local && !interactive) { host.style.width = ""; host.style.height = ""; fitToPanel(); }
        }
        else if (message.type === "replay" && message.state === "start") {
          terminal.reset();
          replayCount += 1;
          replay = nextReplayState(replay, "start");
          followTailRef.current = true;
          setScrolledUp(false);
        }
        else if (message.type === "replay" && message.state === "end") {
          replay = nextReplayState(replay, "end");
          const current = replayCount;
          // xterm runs write callbacks in order, so this one runs after every snapshot chunk is parsed.
          terminal.write(new Uint8Array(0), () => {
            if (disposed || socket !== socketRef.current || current !== replayCount) return;
            replay = nextReplayState(replay, "parsed");
            followTail();
            if (statusRef.current !== "live") setTerminalStatus(terminalMessageStatus(statusRef.current, "frame"));
          });
        }
        else if (message.type === "size" && typeof message.cols === "number" && typeof message.rows === "number" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0 && message.cols <= 65_535 && message.rows <= 65_535 && (terminal.cols !== message.cols || terminal.rows !== message.rows)) {
          const wasFollowing = followTailRef.current;
          terminal.resize(message.cols, message.rows);
          syncReadOnlySurface();
          if (wasFollowing) requestAnimationFrame(followTail);
        }
        else if (message.type === "closed") setTerminalStatus("ended");
        else if (message.type === "error") {
          setErrorMessage(message.message?.trim() || "The terminal is not available.");
          if (interactive) setTerminalStatus("ended");
          else if (statusRef.current !== "live") setTerminalStatus("reconnecting");
        }
      };
      socket.onclose = (event) => {
        if (disposed || socket !== socketRef.current) return;
        const closed = terminalCloseStatus(event.code);
        if (closed) { setTerminalStatus(closed); return; }
        if (["live", "connecting", "reconnecting"].includes(statusRef.current)) {
          if (attempt >= 20) setTerminalStatus("ended");
          else {
            setTerminalStatus("reconnecting");
            retry = window.setTimeout(() => {
              retry = undefined;
              if (disposed || socketRef.current !== socket || statusRef.current === "ended") return;
              connect();
            }, reconnectDelayMs(attempt++));
          }
        }
      };
    };
    if (interactive) {
      terminal.onData(data => { if (replay === "idle") send(new TextEncoder().encode(data).buffer as ArrayBuffer); });
      terminal.onBinary(data => {
        if (replay !== "idle") return;
        const bytes = new Uint8Array(data.length);
        for (let index = 0; index < data.length; index++) bytes[index] = data.charCodeAt(index) & 0xff;
        send(bytes.buffer as ArrayBuffer);
      });
    }
    terminal.attachCustomWheelEventHandler((event) => {
      if (local) return true;
      if (!interactive || event.type !== "wheel") return false;
      const rowHeight = host.clientHeight > 0 && terminal.rows > 0 ? host.clientHeight / terminal.rows : 0;
      const deltaY = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * rowHeight : event.deltaY;
      const scroll = wheelToScroll(deltaY, rowHeight);
      if (scroll) {
        send(JSON.stringify({ type: "scroll", direction: scroll.direction, lines: scroll.lines }));
        if (scroll.direction === "up") setScrolledUp(true);
        else setScrolledUp(false);
      }
      return false;
    });
    terminal.onScroll(() => {
      if (!local) return;
      followTailRef.current = bufferAtTail(terminal.buffer.active);
      setScrolledUp(!followTailRef.current);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && terminal.getSelection()) { void navigator.clipboard.writeText(terminal.getSelection()).catch(() => undefined); terminal.clearSelection(); return false; }
      return true;
    });
    const observer = new ResizeObserver(() => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => {
      if (statusRef.current === "ended" || statusRef.current === "taken_over") return;
      if (!interactive && !local) {
        const wasFollowing = followTailRef.current;
        syncReadOnlySurface();
        if (wasFollowing) requestAnimationFrame(followTail);
        return;
      }
      fitToPanel();
    }, 150); });
    observer.observe(host);
    connect();
    return () => { disposed = true; window.clearTimeout(retry); window.clearTimeout(resizeTimer); observer.disconnect(); viewport.removeEventListener("scroll", updateLocalScroll); jumpToTailRef.current = () => undefined; socketRef.current?.close(1000); socketRef.current = null; terminal.dispose(); };
  }, [connection, interactive, paneId, path, label]);
  const ended = status === "ended" && !errorMessage;
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;
  useEffect(() => { if (ended) endedRef.current?.(); }, [ended]);
  const reconnect = () => { setConnection((value) => value + 1); statusRef.current = "connecting"; setStatus("connecting"); };
  const jumpToBottom = () => {
    jumpToTailRef.current();
    setScrolledUp(false);
    hostRef.current?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
  };
  const overlay = status === "connecting" ? "Connection in progress" : status === "reconnecting" ? <ReconnectingStatus /> : status === "taken_over" ? "Another viewer took control" : status === "ended" && !(ended && onEnded) ? (errorMessage ?? (paneId || interactive ? "Pane ended" : "No live pane")) : null;
  return <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col"><div className="relative mt-1 min-h-0 min-w-0 w-full flex-1 overflow-hidden bg-background p-2"><div className={interactive || localScroll ? "h-full w-full overflow-hidden" : "h-full w-full max-w-full overflow-auto"} ref={viewportRef}><div aria-label={label} className="h-full" ref={hostRef} /></div>{overlay ? <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/85 text-sm text-foreground"><span>{overlay}</span>{errorMessage || status === "taken_over" ? <Button size="xs" onClick={reconnect}>{status === "taken_over" ? "Take control" : "Retry"}</Button> : null}</div> : null}{status === "live" && scrolledUp ? <div className="absolute bottom-3 right-3 z-10"><Button aria-label="Open latest output" size="icon-xs" variant="secondary" onClick={jumpToBottom}><ArrowDownToLine aria-hidden="true" /></Button></div> : null}</div></div>;
}

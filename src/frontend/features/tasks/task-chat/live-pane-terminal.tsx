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

export function observerDimensionsChanged(current: { cols: number; rows: number } | undefined, next: { cols: number; rows: number }): boolean {
  return !current || current.cols !== next.cols || current.rows !== next.rows;
}

export function observerViewport(dimensions: { cols: number; rows: number }): { cols: number; rows: number } {
  return {
    cols: Math.min(300, Math.max(20, Math.round(dimensions.cols))),
    rows: Math.min(150, Math.max(5, Math.round(dimensions.rows))),
  };
}

export function terminalCloseStatus(code: number): TerminalStatus | null {
  if (code === 4498) return "taken_over";
  if (code === 1000 || code === 4403 || code === 4404) return "ended";
  return null;
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

export function PaneTerminal({ path, interactive, paneId, label }: { path: string; interactive: boolean; paneId: string | null; label: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<TerminalStatus>(paneId || interactive ? "connecting" : "ended");
  const [status, setStatus] = useState<TerminalStatus>(paneId || interactive ? "connecting" : "ended");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [scrolledUp, setScrolledUp] = useState(false);
  const [connection, setConnection] = useState(0);
  const sendRef = useRef<(message: string | ArrayBuffer) => void>(() => undefined);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || (!paneId && !interactive)) { statusRef.current = "ended"; setStatus("ended"); return; }
    let disposed = false;
    let attempt = 0;
    let retry: number | undefined;
    let resizeTimer: number | undefined;
    let activeDimensions: { cols: number; rows: number } | undefined;
    const terminal = new Terminal({ allowProposedApi: true, cursorBlink: interactive, cursorStyle: "block", disableStdin: !interactive, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, lineHeight: 1.2, scrollback: 0, macOptionIsMeta: true, theme: terminalTheme(host) });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener")));
    terminal.open(host);
    try { const webgl = new WebglAddon(); terminal.loadAddon(webgl); webgl.onContextLoss(() => webgl.dispose()); } catch { /* DOM renderer fallback */ }
    const setTerminalStatus = (next: TerminalStatus): void => { statusRef.current = next; setStatus(next); };
    const send = (message: string | ArrayBuffer): void => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(message);
    };
    sendRef.current = send;
    const connect = (): void => {
      if (disposed) return;
      const proposed = observerViewport(fit.proposeDimensions() ?? { cols: terminal.cols, rows: terminal.rows });
      terminal.resize(proposed.cols, proposed.rows);
      const { cols, rows } = proposed;
      activeDimensions = { cols, rows };
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${location.host}${path}?cols=${cols}&rows=${rows}`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      if (statusRef.current !== "live") setTerminalStatus(attempt === 0 ? "connecting" : "reconnecting");
      socket.onmessage = (event) => {
        if (socket !== socketRef.current) return;
        if (typeof event.data !== "string") { terminal.write(new Uint8Array(event.data as ArrayBuffer)); return; }
        let message: { type?: string; cols?: number; rows?: number; reason?: string; message?: string };
        try { message = JSON.parse(event.data) as typeof message; }
        catch { setErrorMessage("Herdr sent an invalid terminal event."); setTerminalStatus("ended"); socket.close(1000); return; }
        if (message.type === "open") { attempt = 0; setErrorMessage(undefined); setScrolledUp(false); setTerminalStatus("live"); }
        else if (message.type === "size" && typeof message.cols === "number" && typeof message.rows === "number" && (terminal.cols !== message.cols || terminal.rows !== message.rows)) terminal.resize(message.cols, message.rows);
        else if (message.type === "closed") setTerminalStatus("ended");
        else if (message.type === "error") { setErrorMessage(message.message?.trim() || "Herdr could not observe this pane."); setTerminalStatus("ended"); }
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
      terminal.onData(data => send(new TextEncoder().encode(data).buffer as ArrayBuffer));
      terminal.onBinary(data => {
        const bytes = new Uint8Array(data.length);
        for (let index = 0; index < data.length; index++) bytes[index] = data.charCodeAt(index) & 0xff;
        send(bytes.buffer as ArrayBuffer);
      });
      terminal.attachCustomWheelEventHandler((event) => {
        if (event.type !== "wheel") return false;
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
    }
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && terminal.getSelection()) { void navigator.clipboard.writeText(terminal.getSelection()).catch(() => undefined); terminal.clearSelection(); return false; }
      return true;
    });
    const observer = new ResizeObserver(() => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => {
      if (statusRef.current === "ended" || statusRef.current === "taken_over") return;
      const proposed = fit.proposeDimensions();
      if (!proposed) return;
      const next = observerViewport(proposed);
      if (!next || !observerDimensionsChanged(activeDimensions, next)) return;
      if (interactive) {
        activeDimensions = next;
        terminal.resize(next.cols, next.rows);
        send(JSON.stringify({ type: "resize", cols: next.cols, rows: next.rows }));
        return;
      }
      window.clearTimeout(retry);
      retry = undefined;
      attempt = 0;
      terminal.resize(next.cols, next.rows);
      const previous = socketRef.current;
      socketRef.current = null;
      previous?.close(1000, "viewport changed");
      connect();
    }, 150); });
    observer.observe(host);
    connect();
    return () => { disposed = true; window.clearTimeout(retry); window.clearTimeout(resizeTimer); observer.disconnect(); socketRef.current?.close(1000); socketRef.current = null; terminal.dispose(); };
  }, [connection, interactive, paneId, path, label]);
  const reconnect = () => { setConnection((value) => value + 1); statusRef.current = "connecting"; setStatus("connecting"); };
  const jumpToBottom = () => { sendRef.current(JSON.stringify({ type: "scroll", direction: "down", lines: 10_000 })); setScrolledUp(false); hostRef.current?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus(); };
  const overlay = status === "connecting" ? "Connection in progress" : status === "reconnecting" ? <ReconnectingStatus /> : status === "taken_over" ? "Another viewer took control" : status === "ended" ? (errorMessage ?? (paneId || interactive ? "Pane ended" : "No live pane")) : null;
  return <div className="flex h-full min-h-0 flex-col"><div className="relative mt-1 min-h-0 flex-1 overflow-hidden bg-background p-2"><div aria-label={label} className="h-full" ref={hostRef} />{overlay ? <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/85 text-sm text-foreground"><span>{overlay}</span>{errorMessage || status === "taken_over" ? <Button size="xs" onClick={reconnect}>{status === "taken_over" ? "Take control" : "Retry"}</Button> : null}</div> : null}{interactive && status === "live" && scrolledUp ? <Button aria-label="Jump to bottom" className="absolute bottom-3 right-3" size="icon-xs" variant="secondary" onClick={jumpToBottom}><ArrowDownToLine aria-hidden="true" /></Button> : null}</div></div>;
}

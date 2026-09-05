import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type JSX, useEffect, useRef, useState } from "react";
import { Button } from "../../ui/button.js";

export type TerminalStatus = "connecting" | "live" | "reconnecting" | "taken_over" | "ended";

export function wheelToScroll(deltaY: number, rowHeightPx: number): { direction: "up" | "down"; lines: number } | null {
  if (Math.abs(deltaY) < 1) return null;
  return { direction: deltaY < 0 ? "up" : "down", lines: Math.max(1, Math.round(Math.abs(deltaY) / rowHeightPx)) };
}

export function reconnectDelayMs(attempt: number): number {
  return [250, 500, 1_000, 2_000, 5_000][Math.min(attempt, 4)] ?? 5_000;
}

export function statusForClosedReason(reason: string): "taken_over" | "ended" {
  return reason.includes("taken over") ? "taken_over" : "ended";
}

export function terminalCloseStatus(code: number, reason: string): "taken_over" | "ended" | null {
  if (code === 1000 || code === 4403 || code === 4404) return statusForClosedReason(reason);
  return null;
}

export function LivePaneTerminal({ taskId, role, paneId }: { taskId: string; role: "root" | "worker"; paneId: string | null }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<TerminalStatus>(paneId ? "connecting" : "ended");
  const [status, setStatus] = useState<TerminalStatus>(paneId ? "connecting" : "ended");
  const [showJump, setShowJump] = useState(false);
  const [connection, setConnection] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !paneId) { statusRef.current = "ended"; setStatus("ended"); return; }
    let disposed = false;
    let attempt = 0;
    let retry: number | undefined;
    let resizeTimer: number | undefined;
    const terminal = new Terminal({ allowProposedApi: true, cursorBlink: false, cursorStyle: "block", disableStdin: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, lineHeight: 1.2, scrollback: 0, macOptionIsMeta: true, theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#cdd6f4", selectionBackground: "#45475a" } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener")));
    terminal.open(host);
    try { const webgl = new WebglAddon(); terminal.loadAddon(webgl); webgl.onContextLoss(() => webgl.dispose()); } catch { /* DOM renderer fallback */ }
    const setTerminalStatus = (next: TerminalStatus): void => { statusRef.current = next; setStatus(next); };
    const dimensions = (): { cols: number; rows: number } => { fit.fit(); return fit.proposeDimensions() ?? { cols: terminal.cols, rows: terminal.rows }; };
    const send = (value: string | Uint8Array): boolean => {
      const socket = socketRef.current;
      if (statusRef.current !== "live" || !socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(value);
      return true;
    };
    const connect = (): void => {
      if (disposed) return;
      const { cols, rows } = dimensions();
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${location.host}/api/tasks/${encodeURIComponent(taskId)}/pane/${encodeURIComponent(role)}/terminal?cols=${cols}&rows=${rows}`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      setTerminalStatus(attempt === 0 ? "connecting" : "reconnecting");
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") { terminal.write(new Uint8Array(event.data as ArrayBuffer)); return; }
        const message = JSON.parse(event.data) as { type?: string; cols?: number; rows?: number; reason?: string; message?: string };
        if (message.type === "open") { attempt = 0; setTerminalStatus("live"); if (!document.hidden) terminal.focus(); }
        else if (message.type === "size" && typeof message.cols === "number" && typeof message.rows === "number" && (terminal.cols !== message.cols || terminal.rows !== message.rows)) terminal.resize(message.cols, message.rows);
        else if (message.type === "closed") setTerminalStatus(statusForClosedReason(message.reason ?? ""));
        else if (message.type === "error") console.warn("Herdr terminal bridge error", message.message);
      };
      socket.onclose = (event) => {
        if (disposed || statusRef.current === "taken_over") return;
        const closed = terminalCloseStatus(event.code, event.reason);
        if (closed) { setTerminalStatus(closed); return; }
        if (["live", "connecting", "reconnecting"].includes(statusRef.current)) {
          if (attempt >= 20) setTerminalStatus("ended");
          else { setTerminalStatus("reconnecting"); retry = window.setTimeout(connect, reconnectDelayMs(attempt++)); }
        }
      };
    };
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && terminal.getSelection()) { void navigator.clipboard.writeText(terminal.getSelection()); terminal.clearSelection(); return false; }
      return true;
    });
    terminal.attachCustomWheelEventHandler((event) => {
      const scroll = wheelToScroll(event.deltaY, host.clientHeight / terminal.rows);
      if (scroll && send(JSON.stringify({ type: "scroll", ...scroll })) && scroll.direction === "up") setShowJump(true);
      return false;
    });
    const observer = new ResizeObserver(() => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => { const before = { cols: terminal.cols, rows: terminal.rows }; const next = dimensions(); if (before.cols !== terminal.cols || before.rows !== terminal.rows) send(JSON.stringify({ type: "resize", cols: next.cols, rows: next.rows })); }, 100); });
    observer.observe(host);
    connect();
    return () => { disposed = true; window.clearTimeout(retry); window.clearTimeout(resizeTimer); observer.disconnect(); socketRef.current?.close(1000); socketRef.current = null; terminal.dispose(); };
  }, [connection, paneId, role, taskId]);
  const overlay = status === "connecting" ? "Forge connects" : status === "reconnecting" ? "Forge reconnects" : status === "taken_over" ? "Another viewer took control" : status === "ended" ? (paneId ? "Pane ended" : "No live pane") : null;
  return <div className="flex h-full min-h-0 flex-col"><div className="relative mt-1 min-h-0 flex-1 overflow-hidden bg-[#1e1e2e] p-2"><div aria-label={`Live pane output for ${role}`} className="h-full" ref={hostRef} />{overlay ? <div className="absolute inset-0 flex items-center justify-center gap-2 bg-[#1e1e2e]/85 text-sm text-[#cdd6f4]">{overlay}{status === "taken_over" ? <Button size="xs" onClick={() => { setConnection((value) => value + 1); statusRef.current = "connecting"; setStatus("connecting"); }}>Take control</Button> : null}</div> : null}{showJump ? <Button className="absolute bottom-2 right-2" size="xs" onClick={() => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "scroll", direction: "down", lines: 65_535 })); setShowJump(false); }}>Jump to bottom</Button> : null}</div></div>;
}

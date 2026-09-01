import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

export function preservedViewportLine(wasFollowing: boolean, distanceFromBottom: number, newBottom: number): number {
  return wasFollowing ? newBottom : Math.max(0, newBottom - distanceFromBottom);
}

export function LivePaneTerminal({ role, text }: { role: string; text: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writeVersionRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 11,
      lineHeight: 1.2,
      scrollback: 2_000,
      theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#1e1e2e", selectionBackground: "#45475a" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const resize = new ResizeObserver(() => {
      const distanceFromBottom = terminal.buffer.active.baseY - terminal.buffer.active.viewportY;
      const wasFollowing = distanceFromBottom === 0;
      fit.fit();
      terminal.scrollToLine(preservedViewportLine(wasFollowing, distanceFromBottom, terminal.buffer.active.baseY));
    });
    resize.observe(host);
    fit.fit();
    return () => {
      resize.disconnect();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const version = ++writeVersionRef.current;
    const distanceFromBottom = terminal.buffer.active.baseY - terminal.buffer.active.viewportY;
    const wasFollowing = distanceFromBottom === 0;
    terminal.reset();
    terminal.write(text, () => {
      if (version !== writeVersionRef.current || terminalRef.current !== terminal) return;
      const target = preservedViewportLine(wasFollowing, distanceFromBottom, terminal.buffer.active.baseY);
      terminal.scrollToLine(target);
    });
  }, [text]);

  return <div aria-label={`Live pane output for ${role}`} className="mt-1 h-48 overflow-hidden bg-[#1e1e2e] p-2" ref={hostRef} />;
}

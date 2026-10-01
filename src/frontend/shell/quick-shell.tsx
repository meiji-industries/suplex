import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent, type ReactElement } from "react";

import { SquareTerminal } from "lucide-react";
import suplexMark from "../assets/suplex-mark.svg?inline";
import { useOptionalCompanyContext } from "./company-context.js";

const PaneTerminal = lazy(() => import("../features/tasks/task-chat/live-pane-terminal.js").then(module => ({ default: module.PaneTerminal })));

const TOGGLE = "suplex:quick-shell";
/** Pulled up this far, or flicked up this fast (px/ms), the console snaps shut. */
const CLOSE_DISTANCE = 0.25;
const CLOSE_SPEED = 0.6;
const OPEN = "transform 140ms cubic-bezier(0.2, 0.9, 0.3, 1)";
const SETTLE = "transform 220ms cubic-bezier(0.3, 1.5, 0.5, 1)";
const CLOSE = "transform 110ms cubic-bezier(0.55, 0, 0.9, 0.4)";
/** P1 green phosphor, as a VT100 drew it, on the console chrome only. */
const GLOW = "0 0 6px rgb(65 255 122 / 0.75)";

/** The quick shell icon, lit like the console chrome. */
export function PhosphorTerminalIcon(): ReactElement {
  return <SquareTerminal className="text-[#1fbf55] dark:text-[#41ff7a]" style={{ filter: "drop-shadow(0 0 3px rgb(65 255 122 / 0.85))" }} />;
}

export function toggleQuickShell(): void {
  window.dispatchEvent(new Event(TOGGLE));
}

const isToggleKey = (event: KeyboardEvent): boolean => event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "`" || event.code === "Backquote");

/**
 * A Quake console: the person's host shell drops from the top of the window.
 * Closing it only hides the view; the shell keeps running on the host.
 */
export function QuickShell(): ReactElement | null {
  const admin = useOptionalCompanyContext()?.user?.role === "admin";
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pull, setPull] = useState<number | null>(null);
  const [transition, setTransition] = useState(OPEN);
  const panel = useRef<HTMLDivElement>(null);
  const grab = useRef<{ y: number; time: number; pull: number } | null>(null);
  const shown = useRef(false);
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const show = (next: boolean, motion: string): void => {
    shown.current = next;
    setTransition(motion);
    setOpen(next);
  };

  useEffect(() => {
    if (!admin) return;
    const toggle = (): void => show(!shown.current, shown.current ? CLOSE : OPEN);
    // Capture runs before the terminal, so the shortcut also closes the console from inside the shell.
    const key = (event: KeyboardEvent): void => {
      if (!isToggleKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    window.addEventListener(TOGGLE, toggle);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener(TOGGLE, toggle); window.removeEventListener("keydown", key, true); };
  }, [admin]);

  // The terminal mounts on open and unmounts after the close animation; the host keeps the shell.
  useEffect(() => {
    if (open) setMounted(true);
    else if (panel.current?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // The terminal loads lazily, so focus waits for its input to appear.
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (!open) { setMounted(false); window.clearInterval(timer); return; }
      const input = panel.current?.querySelector<HTMLElement>(".xterm-helper-textarea");
      input?.focus();
      if (input || tries > 40) window.clearInterval(timer);
    }, reduced ? 0 : 150);
    return () => window.clearInterval(timer);
  }, [open, reduced]);

  if (!admin) return null;
  const transform = !open ? "translateY(-100%)" : pull === null ? "translateY(0)" : `translateY(${-pull}px)`;

  const down = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    grab.current = { y: event.clientY, time: event.timeStamp, pull: 0 };
    setPull(0);
  };
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    if (!grab.current) return;
    const up = grab.current.y - event.clientY;
    // Pulling down stretches a little and resists, like a rubber band.
    const next = up >= 0 ? up : -Math.min(24, Math.sqrt(-up) * 3);
    grab.current = { y: grab.current.y, time: grab.current.time, pull: next };
    setPull(next);
  };
  const release = (event: PointerEvent<HTMLDivElement>): void => {
    const start = grab.current;
    grab.current = null;
    if (!start) return;
    const height = panel.current?.offsetHeight ?? 1;
    const speed = start.pull / Math.max(1, event.timeStamp - start.time);
    const shut = start.pull > height * CLOSE_DISTANCE || speed > CLOSE_SPEED;
    setPull(null);
    show(!shut, shut ? CLOSE : SETTLE);
  };

  return <>
    {open ? <div aria-hidden="true" className="fixed inset-0 z-40" onClick={() => show(false, CLOSE)} /> : null}
    <div ref={panel} role="dialog" aria-label="Quick shell" aria-hidden={!open} inert={!open}
      className="dark fixed inset-x-0 top-0 z-50 flex h-[min(55dvh,640px)] flex-col border-b-2 border-[#41ff7a] bg-background text-foreground"
      style={{ transform, transition: pull !== null || reduced ? "none" : transition, visibility: !open && !mounted ? "hidden" : undefined, boxShadow: "0 0 14px rgb(65 255 122 / 0.55), 0 0 2px rgb(65 255 122 / 0.9), 0 16px 48px rgb(0 0 0 / 0.55)" }}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <img src={suplexMark} alt="" aria-hidden="true" className="pointer-events-none absolute top-1/2 left-1/2 z-10 h-[85%] w-auto -translate-x-1/2 -translate-y-1/2 opacity-[0.012] select-none" />
        {mounted ? <Suspense fallback={null}><PaneTerminal path="/api/quick-shell/terminal" interactive paneId="quick-shell" label="Quick shell" onEnded={() => show(false, CLOSE)} /></Suspense> : null}
      </div>
      <div role="separator" aria-label="Drag up to close the quick shell" title="Drag up to close"
        className="flex h-6 shrink-0 cursor-row-resize touch-none select-none items-center justify-between gap-3 border-t border-[#41ff7a]/25 px-3 font-mono text-[11px] uppercase tracking-widest text-[#41ff7a]"
        style={{ textShadow: GLOW, backgroundImage: "repeating-linear-gradient(0deg, rgb(65 255 122 / 0.06) 0 1px, transparent 1px 3px)" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={release} onPointerCancel={release}>
        <span>] quick shell<span className="motion-safe:animate-pulse">_</span></span>
        <span aria-hidden="true" className="h-1 w-12 rounded-full bg-[#41ff7a]" style={{ boxShadow: GLOW }} />
        <span>ctrl+` to close</span>
      </div>
    </div>
  </>;
}

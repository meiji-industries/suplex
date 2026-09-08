import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TaskActivity } from "../task-work.js";
import { LivePaneTerminal } from "./live-pane-terminal.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs.js";
import { roleLabel } from "../../../../coordination/workflows.js";

const storageKey = "forge.live-pane-height";
const clampHeight = (height: number) => Math.min(720, Math.max(160, height));

function readHeight(): number {
  try { const saved = window.localStorage.getItem(storageKey); const value = saved?.trim() ? Number(saved) : 320; return Number.isFinite(value) ? clampHeight(value) : 320; }
  catch { return 320; }
}

function saveHeight(height: number): void {
  try { window.localStorage.setItem(storageKey, String(height)); } catch { /* Browser storage can be disabled. */ }
}

export function LivePaneDock({ taskId, activity }: { taskId: string; activity: TaskActivity }) {
  const panes = activity.sessions.filter(session => session.current && session.paneId);
  const [selectedRole, setSelectedRole] = useState<string>();
  const selected = panes.find(session => session.kind === selectedRole) ?? panes.find(session => session.kind === "worker") ?? panes[0];
  const [height, setHeight] = useState(readHeight);
  const resize = useRef<{ originY: number; height: number } | null>(null);
  const updateResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resize.current) return;
    resize.current.height = clampHeight(resize.current.height + resize.current.originY - event.clientY);
    resize.current.originY = event.clientY;
    setHeight(resize.current.height);
  };
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resize.current = { originY: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    updateResize(event);
    if (resize.current) saveHeight(resize.current.height);
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const adjustResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next = clampHeight(height + (event.key === "ArrowUp" ? 24 : -24));
    setHeight(next); saveHeight(next);
  };
  if (!selected) return null;
  return <section data-live-pane-dock className="dark sticky bottom-0 z-10 mt-auto flex w-full shrink-0 flex-col bg-background text-foreground" aria-label="Live agent output" style={{ height, maxHeight: "75dvh", colorScheme: "dark" }}>
    <div role="slider" tabIndex={0} aria-label="Resize live agent output" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={720} aria-valuenow={height} aria-valuetext={`${height} pixels`} className="flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center border-t focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" title="Drag to resize live output" onKeyDown={adjustResize} onPointerDown={startResize} onPointerMove={updateResize} onPointerUp={endResize} onPointerCancel={endResize}><span aria-hidden="true" className="h-px w-8 bg-muted-foreground" /></div>
    <Tabs className="min-h-0 flex-1" value={selected.kind} onValueChange={value => setSelectedRole(String(value))}>
      <div className="shrink-0 overflow-x-auto px-1" aria-label="Live pane tabs"><TabsList variant="line">{panes.map(session => {
        const pending = activity.turns.find(turn => turn.sessionId === session.id && !["completed", "cancelled"].includes(turn.status));
        const dot = pending?.status === "prompted" ? "animate-pulse bg-emerald-500" : pending ? "bg-amber-500" : "bg-muted-foreground";
        return <TabsTrigger key={session.id} value={session.kind}><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />{roleLabel(session)}</TabsTrigger>;
      })}</TabsList></div>
      <TabsContent className="mt-0 min-h-0" value={selected.kind}><LivePaneTerminal key={selected.id} taskId={taskId} role={selected.kind} paneId={selected.paneId} /></TabsContent>
    </Tabs>
  </section>;
}

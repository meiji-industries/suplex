import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TaskActivity } from "../task-work.js";
import { LivePaneTerminal } from "./live-pane-terminal.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs.js";
import { roleLabel } from "../../../../coordination/workflows.js";
import { SessionHistory } from "./session-history.js";
import { sessionHistoryLabels } from "./session-history-state.js";

const storageKey = "forge.live-pane-height";
const clampHeight = (height: number) => Math.min(720, Math.max(160, height));
const shellTabId = "shell";

function readHeight(): number {
  try { const saved = window.localStorage.getItem(storageKey); const value = saved?.trim() ? Number(saved) : 320; return Number.isFinite(value) ? clampHeight(value) : 320; }
  catch { return 320; }
}

function saveHeight(height: number): void {
  try { window.localStorage.setItem(storageKey, String(height)); } catch { /* Browser storage can be disabled. */ }
}

export function LivePaneDock({ taskId, activity }: { taskId: string; activity: TaskActivity }) {
  const sessions = activity.sessions.filter(session => session.nativeSessionId || (session.current && session.paneId));
  const shell = activity.shellPaneId || sessions.some(session => session.current) ? { id: shellTabId } : null;
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [view, setView] = useState("terminal");
  const selected = sessions.find(session => session.id === selectedSessionId) ?? sessions.find(session => session.current && session.kind === "worker") ?? sessions.find(session => session.current) ?? sessions.at(-1);
  const selectedTab = selectedSessionId === shellTabId && shell ? shellTabId : selected?.id ?? (shell ? shellTabId : undefined);
  const labels = sessionHistoryLabels(sessions);
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
  if (!selectedTab) return null;
  return <section data-live-pane-dock className="dark sticky bottom-0 z-10 mt-auto flex w-full max-w-full shrink-0 flex-col overflow-hidden bg-background text-foreground" aria-label="Live agent output" style={{ height, maxHeight: "75dvh", colorScheme: "dark" }}>
    <div role="slider" tabIndex={0} aria-label="Resize live agent output" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={720} aria-valuenow={height} aria-valuetext={`${height} pixels`} className="flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center border-t focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" title="Drag to resize live output" onKeyDown={adjustResize} onPointerDown={startResize} onPointerMove={updateResize} onPointerUp={endResize} onPointerCancel={endResize}><span aria-hidden="true" className="h-px w-8 bg-muted-foreground" /></div>
    <Tabs className="min-h-0 min-w-0 flex-1 gap-0" value={selectedTab} onValueChange={value => { setSelectedSessionId(String(value)); setView("terminal"); }}>
      <div className="min-w-0 shrink-0 overflow-x-auto border-b px-1" aria-label="Sessions"><TabsList variant="line">{shell ? <TabsTrigger value={shellTabId}>Shell</TabsTrigger> : null}{sessions.map(session => <TabsTrigger key={session.id} value={session.id}>{labels.get(session.id) ?? roleLabel(session)}</TabsTrigger>)}</TabsList></div>
      {shell ? <TabsContent className="mt-0 flex min-h-0 min-w-0 overflow-hidden" value={shellTabId}>
        <LivePaneTerminal taskId={taskId} role="shell" paneId={activity.shellPaneId} />
      </TabsContent> : null}
      {sessions.map(session => <TabsContent key={session.id} className="mt-0 flex min-h-0 min-w-0 overflow-hidden" value={session.id}>
        <Tabs className="min-h-0 min-w-0 flex-1 gap-0" value={view === "terminal" && (!session.current || !session.paneId) ? "history" : view} onValueChange={value => setView(String(value))}>
          <div className="flex shrink-0 justify-end border-b px-2" aria-label="Session output"><TabsList variant="line"><TabsTrigger value="history">History</TabsTrigger><TabsTrigger value="terminal" disabled={!session.current || !session.paneId}>Terminal</TabsTrigger></TabsList></div>
          <TabsContent className="mt-0 flex min-h-0 max-h-full overflow-hidden" value="history"><SessionHistory taskId={taskId} sessionId={session.id} assistantLabel={labels.get(session.id) ?? roleLabel(session)} poll={session.current} /></TabsContent>
          <TabsContent className="mt-0 min-h-0 overflow-hidden" value="terminal">{session.current && session.paneId ? <LivePaneTerminal taskId={taskId} role={session.kind} paneId={session.paneId} /> : null}</TabsContent>
        </Tabs>
      </TabsContent>)}
    </Tabs>
  </section>;
}

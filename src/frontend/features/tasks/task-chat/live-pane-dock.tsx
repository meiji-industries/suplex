import { lazy, Suspense, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { SquareTerminal } from "lucide-react";
import type { TaskActivity } from "../task-work.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs.js";
import { Avatar, AvatarFallback, AvatarGroup } from "../../../components/ui/avatar.js";
import { EntityAvatar } from "../../../components/app/entity-avatar.js";
import { ProviderIcon, providerIcons } from "../../../components/app/provider-icons.js";
import { roleLabel } from "../workflow-presentation.js";
import { SessionHistory } from "./session-history.js";
import { sessionHistoryLabels } from "./session-history-state.js";

const LivePaneTerminal = lazy(() => import("./live-pane-terminal.js").then(module => ({ default: module.LivePaneTerminal })));
const storageKey = "suplex.live-pane-height";
const clampHeight = (height: number) => Math.min(720, Math.max(160, height));
const shellTabId = "shell";
type AgentOutputView = "live" | "mirror";
type SessionHarness = NonNullable<TaskActivity["sessions"][number]["harness"]>;
const sessionTabClassName = "h-9 flex-none rounded-none border-x-0 border-y-0 border-r border-transparent px-3 text-xs group-data-[variant=line]/tabs-list:data-active:border-border dark:group-data-[variant=line]/tabs-list:data-active:border-border group-data-[variant=line]/tabs-list:data-active:bg-background dark:group-data-[variant=line]/tabs-list:data-active:bg-background dark:group-data-[variant=line]/tabs-list:data-active:text-foreground after:top-0 after:bottom-auto after:bg-primary data-active:after:opacity-100";

function SessionAvatars({ profileId, label, harness }: { profileId: string; label: string; harness?: SessionHarness }) {
  return <AvatarGroup>
    <EntityAvatar kind="agent" id={profileId} name={label} size="xs" />
    {harness ? <Avatar size="xs" shape="square" title={providerIcons[harness].label}><AvatarFallback><ProviderIcon provider={harness} /></AvatarFallback></Avatar> : null}
  </AvatarGroup>;
}

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
  const [view, setView] = useState<AgentOutputView>("live");
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
    <Tabs className="min-h-0 min-w-0 flex-1 gap-0" value={selectedTab} onValueChange={value => setSelectedSessionId(String(value))}>
      <div className="flex min-w-0 shrink-0 items-stretch border-b border-border bg-muted/40" aria-label="Sessions">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <TabsList variant="line" className="h-9 gap-0 rounded-none p-0">
            {shell ? <TabsTrigger value={shellTabId} className={sessionTabClassName}><SquareTerminal className="size-3.5" /><span className="max-w-40 truncate">Shell</span></TabsTrigger> : null}
            {sessions.map(session => {
              const label = labels.get(session.id) ?? roleLabel(session);
              return <TabsTrigger key={session.id} value={session.id} className={sessionTabClassName} aria-label={label}><SessionAvatars profileId={session.profileId} label={label} {...(session.harness ? { harness: session.harness } : {})} /><span className="max-w-40 truncate">{label}</span></TabsTrigger>;
            })}
          </TabsList>
        </div>
        {selectedTab !== shellTabId && selected ? <div className="flex shrink-0 items-center border-l border-border px-1" aria-label="Session output">
          <button type="button" className="h-7 rounded-sm px-2 text-xs text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-pressed={view === "live" || !selected.current || !selected.paneId} onClick={() => setView("live")}>Live</button>
          <button type="button" className="h-7 rounded-sm px-2 text-xs text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" aria-pressed={view === "mirror" && selected.current && !!selected.paneId} disabled={!selected.current || !selected.paneId} onClick={() => setView("mirror")}>Mirror</button>
        </div> : null}
      </div>
      {shell ? <TabsContent className="mt-0 flex min-h-0 min-w-0 overflow-hidden" value={shellTabId}>
        <Suspense fallback={null}><LivePaneTerminal taskId={taskId} role="shell" paneId={activity.shellPaneId} /></Suspense>
      </TabsContent> : null}
      {sessions.map(session => <TabsContent key={session.id} className="mt-0 flex min-h-0 min-w-0 overflow-hidden" value={session.id}>
        {view === "mirror" && session.current && session.paneId
          ? <Suspense fallback={null}><LivePaneTerminal taskId={taskId} role={session.kind} paneId={session.paneId} /></Suspense>
          : <SessionHistory taskId={taskId} sessionId={session.id} />}
      </TabsContent>)}
    </Tabs>
  </section>;
}

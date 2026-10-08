import { useEffect, useRef, useState, type ReactElement } from "react";
import { AppWindow, ChevronDown, Copy } from "lucide-react";
import type { WorktreeApp } from "../../contracts/generated/WorktreeApp.js";
import type { WorktreeAppOption } from "../../contracts/generated/WorktreeAppOption.js";
import { listWorktreeApps, openWorktree } from "./lib/task-api.js";
import { Button } from "../../components/ui/button.js";
import { ButtonGroup } from "../../components/ui/button-group.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { copyToClipboard } from "../../lib/clipboard.js";

const lastAppKey = "suplex.worktreeApp";

function localOrigin(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

// Worktree paths only mean something on the host's own machine.
export function showWorktreeMenu(): boolean {
  return localOrigin();
}

function readLastApp(): string | null {
  try { return localStorage.getItem(lastAppKey); } catch { return null; }
}

function AppIcon({ app }: { app: WorktreeAppOption }): ReactElement {
  return app.icon ? <img src={app.icon} alt="" className="size-4" /> : <AppWindow />;
}

export function TaskWorktreeMenu({ taskId, path, onError }: { taskId: string; path: string; onError: (message: string) => void }): ReactElement {
  const [apps, setApps] = useState<WorktreeAppOption[] | null>(null);
  const [lastApp, setLastApp] = useState(readLastApp);
  const [copyState, setCopyState] = useState<"" | "copied" | "failed">("");
  const copyGeneration = useRef(0);
  useEffect(() => {
    let current = true;
    copyGeneration.current += 1;
    setApps(null);
    setCopyState("");
    if (!localOrigin()) return;
    void listWorktreeApps(taskId).then(result => {
      if (current) setApps(result.apps);
    }).catch(() => { if (current) setApps([]); });
    return () => { current = false; copyGeneration.current += 1; };
  }, [taskId, path]);
  const copy = async () => {
    const copiedPath = path;
    const generation = ++copyGeneration.current;
    setCopyState("");
    const copied = await copyToClipboard(copiedPath, "Copied the worktree path to clipboard");
    if (generation === copyGeneration.current) setCopyState(copied ? "copied" : "failed");
  };
  const open = async (app: WorktreeApp) => {
    setLastApp(app);
    try { localStorage.setItem(lastAppKey, app); } catch { /* The choice applies to this page only. */ }
    try {
      const result = await openWorktree(taskId, app);
      if (!result.ok) onError(result.error ?? "The worktree could not be opened");
    } catch (error) { onError(error instanceof Error ? error.message : "The worktree could not be opened"); }
  };
  const primary = apps?.find(app => app.id === lastApp) ?? apps?.[0];
  const feedback = copyState === "copied" ? "Path copied" : copyState === "failed" ? "Path copy failed" : "";
  return <div className="flex shrink-0 items-center gap-2">
    <ButtonGroup>
      {primary ? <Button type="button" variant="outline" size="icon-sm" aria-label={`Open in ${primary.label}`} title={`Open in ${primary.label}`} onClick={() => void open(primary.id)}><AppIcon app={primary} /></Button> : null}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="outline" size="icon-sm" aria-label="Select an app or copy the path" title="Select an app or copy the path" />}><ChevronDown /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {apps?.map(app => <DropdownMenuItem key={app.id} onClick={() => void open(app.id)}><AppIcon app={app} />{app.label}</DropdownMenuItem>)}
          {apps?.length ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={() => void copy()}><Copy />Copy path</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
    <span aria-live="polite" className="text-xs text-muted-foreground">{feedback}</span>
  </div>;
}

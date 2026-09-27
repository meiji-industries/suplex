import { useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronDown, Copy, FolderOpen } from "lucide-react";
import { WorktreeAppsResponseSchema, type WorktreeAppSchema } from "../../contracts/task-responses.js";
import { readJsonUnchecked } from "../../lib/api.js";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";

type WorktreeApp = { id: typeof WorktreeAppSchema._output; label: string };

function localOrigin(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

export function TaskWorktreeMenu({ taskId, path, onError }: { taskId: string; path: string; onError: (message: string) => void }): ReactElement {
  const [apps, setApps] = useState<WorktreeApp[] | null>(null);
  const [copyState, setCopyState] = useState<"" | "copied" | "failed">("");
  const copyGeneration = useRef(0);
  useEffect(() => {
    let current = true;
    copyGeneration.current += 1;
    setApps(null);
    setCopyState("");
    if (!localOrigin()) return;
    void readJsonUnchecked(`/api/tasks/${taskId}/worktree/apps`).then(value => {
      const result = WorktreeAppsResponseSchema.parse(value);
      if (current) setApps(result.apps);
    }).catch(() => { if (current) setApps([]); });
    return () => { current = false; copyGeneration.current += 1; };
  }, [taskId, path]);
  const copy = async () => {
    const copiedPath = path;
    const generation = ++copyGeneration.current;
    setCopyState("");
    try {
      await navigator.clipboard.writeText(copiedPath);
      if (generation === copyGeneration.current) setCopyState("copied");
    } catch {
      if (generation === copyGeneration.current) setCopyState("failed");
    }
  };
  const open = async (app: WorktreeApp["id"]) => {
    try {
      const result = await readJsonUnchecked<{ ok: boolean; error?: string }>(`/api/tasks/${taskId}/worktree/open`, { method: "POST", body: JSON.stringify({ app }) });
      if (!result.ok) onError(result.error ?? "The worktree could not be opened");
    } catch (error) { onError(error instanceof Error ? error.message : "The worktree could not be opened"); }
  };
  const feedback = copyState === "copied" ? "Path copied" : copyState === "failed" ? "Path copy failed" : "";
  return <div className="flex shrink-0 items-center gap-2"><DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" aria-label="Open in" />}><FolderOpen />Open in<ChevronDown /></DropdownMenuTrigger><DropdownMenuContent align="end">{apps?.map(app => <DropdownMenuItem key={app.id} onClick={() => void open(app.id)}>{app.label}</DropdownMenuItem>)}{apps?.length ? <DropdownMenuSeparator /> : null}<DropdownMenuItem onClick={() => void copy()}><Copy />Copy path</DropdownMenuItem></DropdownMenuContent></DropdownMenu><span aria-live="polite" className="text-xs text-muted-foreground">{feedback}</span></div>;
}

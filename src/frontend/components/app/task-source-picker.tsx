import { GitBranch, GitPullRequest, Search, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { Input } from "../ui/input.js";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.js";
import { readJson } from "../../lib/api.js";

export type TaskSourceSummary =
  | { kind: "pull_request"; number: number; title: string; body: string; author: string; headBranch: string; baseBranch: string; isDraft: boolean }
  | { kind: "branch"; branch: string; headSha: string; subject: string; author: string };
export type TaskSourceSelector = { kind: "pull_request"; number: number } | { kind: "branch"; branch: string };
export const taskSourceTabs = [{ value: "pull_request", label: "Pull requests" }, { value: "branch", label: "Branches" }] as const;

export function selectorForTaskSource(source: TaskSourceSummary): TaskSourceSelector {
  return source.kind === "pull_request" ? { kind: "pull_request", number: source.number } : { kind: "branch", branch: source.branch };
}

export function filterTaskSources(rows: TaskSourceSummary[], query: string): TaskSourceSummary[] {
  const normalized = query.trim().toLowerCase();
  return normalized ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(normalized)) : rows;
}

export function prefillForTaskSource(source: TaskSourceSummary): { title: string; description: string } {
  return source.kind === "pull_request"
    ? { title: source.title, description: source.body || `Continue pull request #${source.number} (${source.headBranch} → ${source.baseBranch}).` }
    : { title: source.subject || source.branch, description: `Continue work from branch \`${source.branch}\` at \`${source.headSha.slice(0, 8)}\`.\n\n${source.subject}` };
}

export function preserveEditedPrefill(current: { title: string; description: string }, previous: { title: string; description: string }, next: { title: string; description: string }): { title: string; description: string } {
  return { title: !current.title || current.title === previous.title ? next.title : current.title, description: !current.description || current.description === previous.description ? next.description : current.description };
}

export function TaskSourcePicker({ projectId, value, disabled, onSelect, onClear }: { projectId: string; value?: TaskSourceSummary | undefined; disabled?: boolean; onSelect: (source: TaskSourceSummary, selector: TaskSourceSelector) => void; onClear: () => void }): ReactElement {
  const [kind, setKind] = useState<"pull_request" | "branch">("pull_request");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<TaskSourceSummary[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setRows([]); setQuery(""); }, [projectId]);
  const load = async (nextKind = kind): Promise<void> => {
    if (!projectId) return;
    setLoading(true);
    try { const result = await readJson<{ available: boolean; sources: TaskSourceSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/task-sources?kind=${nextKind}`); setAvailable(result.available); setRows(result.sources); }
    catch { setAvailable(false); setRows([]); }
    finally { setLoading(false); }
  };
  const filtered = useMemo(() => filterTaskSources(rows, query), [query, rows]);
  return <DropdownMenu onOpenChange={(open) => { if (open) void load(); }}>
    {value ? <div className="flex items-center gap-2 text-sm">
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled || !projectId} aria-label="Create from source" />}>
        {value.kind === "pull_request" ? <><Badge variant="outline">PR #{value.number}</Badge><span className="max-w-[24rem] truncate">{value.headBranch}</span></> : <><GitBranch /><span className="max-w-[24rem] truncate">{value.branch}</span></>}
      </DropdownMenuTrigger>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear source" onClick={onClear}><X className="size-3.5" /></Button>
    </div> : <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled || !projectId} aria-label="Create from source" />}>
      <GitBranch />Create from…
    </DropdownMenuTrigger>}
    <DropdownMenuContent align="end" className="w-[min(26rem,calc(100vw-2rem))] p-2">
      <Tabs value={kind} onValueChange={(next) => { const selected = next as typeof kind; setKind(selected); setRows([]); void load(selected); }}>
        <TabsList>{taskSourceTabs.map((tab) => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>)}</TabsList>
      </Tabs>
      <div className="relative mt-2"><Search className="absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input aria-label="Search task sources" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="pl-7" /></div>
      <div className="mt-2 max-h-64 overflow-y-auto" aria-live="polite">
        {loading ? <p className="p-2 text-xs text-muted-foreground">Loading…</p> : !available ? <p className="p-2 text-xs text-muted-foreground">{kind === "pull_request" ? "Pull requests are unavailable." : "Branches are unavailable."}</p> : filtered.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No {kind === "pull_request" ? "pull requests" : "branches"} found.</p> : filtered.map((row) => <DropdownMenuItem key={row.kind === "pull_request" ? row.number : row.branch} onSelect={() => onSelect(row, selectorForTaskSource(row))}>
          {row.kind === "pull_request" ? <GitPullRequest className="mt-0.5 size-3.5" /> : <GitBranch className="mt-0.5 size-3.5" />}<span className="min-w-0"><span className="block truncate font-medium">{row.kind === "pull_request" ? `#${row.number} ${row.title}` : row.branch}</span><span className="block truncate text-muted-foreground">{row.kind === "pull_request" ? `${row.author} · ${row.headBranch} → ${row.baseBranch}` : `${row.headSha.slice(0, 8)} · ${row.subject} · ${row.author}`}</span></span>
        </DropdownMenuItem>)}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}

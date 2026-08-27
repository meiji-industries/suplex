import { GitBranch, GitPullRequest, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { Input } from "../ui/input.js";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.js";
import { readJson } from "../../lib/api.js";

export type TaskSourceSummary =
  | { kind: "pull_request"; number: number; title: string; body: string; author: string; headBranch: string; baseBranch: string; isDraft: boolean }
  | { kind: "branch"; branch: string; headSha: string; subject: string; author: string };
export type TaskSourceSelector = { kind: "pull_request"; number: number } | { kind: "branch"; branch: string };

export function TaskSourcePicker({ projectId, value, disabled, onSelect }: { projectId: string; value?: TaskSourceSummary | undefined; disabled?: boolean; onSelect: (source: TaskSourceSummary, selector: TaskSourceSelector) => void }): ReactElement {
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
  const filtered = useMemo(() => rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query.toLowerCase())), [query, rows]);
  const label = value?.kind === "pull_request" ? `PR #${value.number}` : value?.kind === "branch" ? value.branch : "Create from…";
  return <DropdownMenu onOpenChange={(open) => { if (open) void load(); }}>
    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled || !projectId} aria-label="Create from source" />}>
      {value?.kind === "pull_request" ? <GitPullRequest /> : <GitBranch />}{label}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-[min(26rem,calc(100vw-2rem))] p-2">
      <Tabs value={kind} onValueChange={(next) => { const selected = next as typeof kind; setKind(selected); setRows([]); void load(selected); }}>
        <TabsList><TabsTrigger value="pull_request">Pull requests</TabsTrigger><TabsTrigger value="branch">Branches</TabsTrigger></TabsList>
      </Tabs>
      <div className="relative mt-2"><Search className="absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input aria-label="Search task sources" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="pl-7" /></div>
      <div className="mt-2 max-h-64 overflow-y-auto" aria-live="polite">
        {loading ? <p className="p-2 text-xs text-muted-foreground">Loading…</p> : !available ? <p className="p-2 text-xs text-muted-foreground">{kind === "pull_request" ? "Pull requests are unavailable." : "Branches are unavailable."}</p> : filtered.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No {kind === "pull_request" ? "pull requests" : "branches"} found.</p> : filtered.map((row) => <button type="button" className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" key={row.kind === "pull_request" ? row.number : row.branch} onClick={() => onSelect(row, row.kind === "pull_request" ? { kind: "pull_request", number: row.number } : { kind: "branch", branch: row.branch })}>
          {row.kind === "pull_request" ? <GitPullRequest className="mt-0.5 size-3.5" /> : <GitBranch className="mt-0.5 size-3.5" />}<span className="min-w-0"><span className="block truncate font-medium">{row.kind === "pull_request" ? `#${row.number} ${row.title}` : row.branch}</span><span className="block truncate text-muted-foreground">{row.kind === "pull_request" ? `${row.author} · ${row.headBranch} → ${row.baseBranch}` : `${row.headSha.slice(0, 8)} · ${row.subject} · ${row.author}`}</span></span>
        </button>)}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}

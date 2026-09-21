import { CircleDot, CirclePlus, GitBranch, GitPullRequest, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Input } from "../../components/ui/input.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { readJson } from "../../lib/api.js";
import type { IssueAssociation } from "../../../tasks/issue-association.js";

export type TaskSourceSummary =
  | { kind: "issue"; issue: IssueAssociation }
  | { kind: "pull_request"; number: number; title: string; body: string; author: string; headBranch: string; baseBranch: string; isDraft: boolean }
  | { kind: "branch"; branch: string; headSha: string; subject: string; author: string };
export type TaskSourceSelector = { kind: "issue"; number: number } | { kind: "pull_request"; number: number } | { kind: "branch"; branch: string };
export const taskSourceTabs = [{ value: "pull_request", label: "Pull requests" }, { value: "issue", label: "Issues" }, { value: "branch", label: "Branches" }] as const;

export function issueTaskSource(issue: IssueAssociation): TaskSourceSummary {
  return { kind: "issue", issue };
}

export function selectorForTaskSource(source: Exclude<TaskSourceSummary, { kind: "issue" }>): Exclude<TaskSourceSelector, { kind: "issue" }> {
  return source.kind === "pull_request" ? { kind: source.kind, number: source.number } : { kind: "branch", branch: source.branch };
}

export function filterTaskSources(rows: TaskSourceSummary[], query: string): TaskSourceSummary[] {
  const normalized = query.trim().toLowerCase();
  return normalized ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(normalized)) : rows;
}

export function prefillForTaskSource(source: TaskSourceSummary): { title: string; description: string } {
  if (source.kind === "issue") return { title: source.issue.title, description: `Work on ${source.issue.key}: ${source.issue.url}` };
  return source.kind === "pull_request"
    ? { title: source.title, description: "" }
    : { title: source.subject || source.branch, description: `Continue work from branch \`${source.branch}\` at \`${source.headSha.slice(0, 8)}\`.\n\n${source.subject}` };
}

export function preserveEditedPrefill(current: { title: string; description: string }, previous: { title: string; description: string }, next: { title: string; description: string }): { title: string; description: string } {
  return { title: !current.title || current.title === previous.title ? next.title : current.title, description: !current.description || current.description === previous.description ? next.description : current.description };
}

export function TaskSourcePicker({ projectId, value, disabled, pullRequestsOnly = false, onSelect, onClear }: { projectId: string; value?: TaskSourceSummary | undefined; disabled?: boolean; pullRequestsOnly?: boolean; onSelect: (source: TaskSourceSummary, selector?: Exclude<TaskSourceSelector, { kind: "issue" }>) => void; onClear: () => void }): ReactElement {
  const [selectedKind, setKind] = useState<TaskSourceSelector["kind"]>("pull_request");
  const kind = pullRequestsOnly ? "pull_request" : selectedKind;
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<TaskSourceSummary[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const requestGeneration = useRef(0);
  useEffect(() => { requestGeneration.current += 1; setRows([]); setQuery(""); }, [projectId]);
  const load = async (nextKind = kind, issueQuery = query): Promise<void> => {
    if (!projectId) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setLoading(true);
    try {
      if (nextKind === "issue") {
        const result = await readJson<{ issues: IssueAssociation[] }>(`/api/projects/${encodeURIComponent(projectId)}/issues?query=${encodeURIComponent(issueQuery)}`);
        if (generation !== requestGeneration.current) return;
        setAvailable(true); setRows(result.issues.map(issueTaskSource));
      } else {
        const result = await readJson<{ available: boolean; sources: TaskSourceSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/task-sources?kind=${nextKind}`);
        if (generation !== requestGeneration.current) return;
        setAvailable(result.available); setRows(result.sources);
      }
    }
    catch { if (generation === requestGeneration.current) { setAvailable(false); setRows([]); } }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  };
  const filtered = useMemo(() => kind === "issue" ? rows : filterTaskSources(rows, query), [kind, query, rows]);
  return <DropdownMenu onOpenChange={(open) => { if (open) void load(); }}>
    {value ? <div className="flex items-center gap-2 text-sm">
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled || !projectId} aria-label="New from source" />}>
        {value.kind === "issue" ? <><CircleDot /><span>{value.issue.key}</span></> : value.kind === "pull_request" ? <><Badge variant="outline">PR #{value.number}</Badge><span className="max-w-[24rem] truncate">{value.headBranch}</span></> : <><GitBranch /><span className="max-w-[24rem] truncate">{value.branch}</span></>}
      </DropdownMenuTrigger>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear source" onClick={onClear}><X className="size-3.5" /></Button>
    </div> : <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled || !projectId} aria-label="New from source" />}>
      <CirclePlus />{pullRequestsOnly ? "Select a pull request" : "New from…"}
    </DropdownMenuTrigger>}
    <DropdownMenuContent align="end" className="w-[min(26rem,calc(100vw-2rem))] p-2">
      {pullRequestsOnly ? <p className="px-1 text-xs text-muted-foreground">Open pull requests</p> : <Tabs value={kind} onValueChange={(next) => { const selected = next as typeof kind; setKind(selected); setRows([]); void load(selected); }}>
        <TabsList>{taskSourceTabs.map((tab) => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>)}</TabsList>
      </Tabs>}
      <div className="relative mt-2"><Search className="absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input aria-label="Search task sources" value={query} onChange={(event) => { setQuery(event.target.value); if (kind === "issue") void load("issue", event.target.value); }} onKeyDown={(event) => { if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation(); }} placeholder="Search" className="pl-7" /></div>
      <div className="mt-2 max-h-64 overflow-y-auto" aria-live="polite">
         {loading ? <p className="flex items-center gap-2 p-2 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading task sources…</span></p> : !available ? <p className="p-2 text-xs text-muted-foreground">{kind === "pull_request" ? "Pull requests are not available." : kind === "issue" ? "Issues are not available." : "Branches are not available."}</p> : filtered.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No {kind === "pull_request" ? "pull requests" : kind === "issue" ? "issues" : "branches"} found.</p> : filtered.map((row) => <DropdownMenuItem key={row.kind === "issue" ? `${row.issue.kind}:${row.issue.id}` : row.kind === "pull_request" ? row.number : row.branch} onClick={() => row.kind === "issue" ? onSelect(row) : onSelect(row, selectorForTaskSource(row))}>
          {row.kind === "pull_request" ? <GitPullRequest className="mt-0.5 size-3.5" /> : row.kind === "issue" ? <CircleDot className="mt-0.5 size-3.5" /> : <GitBranch className="mt-0.5 size-3.5" />}<span className="min-w-0"><span className="block truncate font-medium">{row.kind === "issue" ? `${row.issue.key} ${row.issue.title}` : row.kind === "pull_request" ? `#${row.number} ${row.title}` : row.branch}</span><span className="block truncate text-muted-foreground">{row.kind === "pull_request" ? `${row.author} · ${row.headBranch} → ${row.baseBranch}` : row.kind === "issue" ? row.issue.kind : `${row.headSha.slice(0, 8)} · ${row.subject} · ${row.author}`}</span></span>
        </DropdownMenuItem>)}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}

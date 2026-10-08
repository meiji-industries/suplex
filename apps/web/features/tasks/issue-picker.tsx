import { useEffect, useState, type ReactElement } from "react";
import type { IssueSummary } from "./task-source-picker.js";
import type { IssueAssociation } from "../../contracts/issues.js";
import { readJsonUnchecked } from "../../lib/api.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";

export function IssuePicker({ projectId, issue, onChange, disabled = false }: { projectId: string; issue: IssueAssociation | null | undefined; onChange: (issue: IssueAssociation | null) => void | Promise<void>; disabled?: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      void readJsonUnchecked<{ issues: IssueSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/issues?query=${encodeURIComponent(query)}`).then(result => { if (!cancelled) setIssues(result.issues); }).catch(reason => { if (!cancelled) { setIssues([]); setError(reason instanceof Error ? reason.message : "Issues are not available"); } }).finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, projectId, query]);
  const select = async (selected: IssueAssociation | null) => {
    setBusy(true); setError("");
    try { await onChange(selected); setOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The issue could not be saved"); }
    finally { setBusy(false); }
  };
  return <>
    <div className="flex min-w-0 items-center gap-2">
      {issue ? <a className="min-w-0 truncate" href={issue.url} target="_blank" rel="noreferrer" title={issue.title}>{issue.key}: {issue.title}</a> : null}
      <Button type="button" size="xs" variant="ghost" disabled={disabled || busy || !projectId} aria-label="Select issue" onClick={() => { setQuery(""); setOpen(true); }}>{issue ? "Select" : "None"}</Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Select issue</DialogTitle></DialogHeader>
      <Input aria-label="Search issues" placeholder="Search by key, number, or title" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="flex max-h-80 min-w-0 flex-col gap-1 overflow-y-auto">
        {issue ? <Button type="button" variant="outline" disabled={busy} onClick={() => void select(null)}>Clear issue</Button> : null}
        {loading ? <p>Suplex reads the issues.</p> : issues.map(({ usedBy, ...candidate }) => <Button key={`${candidate.kind}:${candidate.id}`} type="button" variant="ghost" disabled={busy || !!usedBy} onClick={() => void select(candidate)}><span className="min-w-0"><span className="block truncate">{candidate.key}: {candidate.title}</span>{usedBy ? <span className="block truncate text-muted-foreground">Open task: {usedBy.title}</span> : null}</span></Button>)}
        {!loading && !error && issues.length === 0 ? <p>No matching issues.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </DialogContent></Dialog>
  </>;
}

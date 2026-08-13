import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from ".././components/ui/accordion.js";
import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { Badge } from ".././components/ui/badge.js";
import { Textarea } from ".././components/ui/textarea.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from ".././components/ui/alert-dialog.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { ApplicationFrame } from ".././components/app/application-frame.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { isApiError, readJson, withCompany } from ".././lib/api.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { ApiAttentionAction, ApiAttentionCompany, ApiAttentionEvidence, ApiAttentionItem } from "../lib/view-shared.js";

export function AttentionView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const [companies, setCompanies] = useState<ApiAttentionCompany[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [evidence, setEvidence] = useState<Record<string, ApiAttentionEvidence>>({});
  const [evidenceLoading, setEvidenceLoading] = useState<Record<string, boolean>>({});
  const [noteAction, setNoteAction] = useState<{ item: ApiAttentionItem; action: ApiAttentionAction }>();
  const [cancelAction, setCancelAction] = useState<{ item: ApiAttentionItem; action: ApiAttentionAction }>();
  const [note, setNote] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const reload = useCallback(async (): Promise<void> => {
    try { setError(""); setCompanies((await readJson<{ companies: ApiAttentionCompany[] }>("/api/attention")).companies); }
    catch (reason) { if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth"); else setError("Unable to load attention"); }
  }, []);
  useEffect(() => { void reload(); const timer = window.setInterval(() => void reload(), 15_000); return () => window.clearInterval(timer); }, [reload]);

  const loadEvidence = useCallback(async (item: ApiAttentionItem): Promise<void> => {
    if (evidence[item.id] || evidenceLoading[item.id]) return;
    setEvidenceLoading((current) => ({ ...current, [item.id]: true }));
    try {
      const result = await readJson<ApiAttentionEvidence>(item.evidence.href);
      setEvidence((current) => ({ ...current, [item.id]: result }));
    } catch {
      setError("Unable to load safe evidence");
    } finally {
      setEvidenceLoading((current) => ({ ...current, [item.id]: false }));
    }
  }, [evidence, evidenceLoading]);

  const performAction = useCallback(async (item: ApiAttentionItem, action: ApiAttentionAction, actionNote?: string): Promise<void> => {
    const path = action.command === "cancel_issue" ? "cancel" : action.command.replaceAll("_", "-");
    setActionBusy(`${item.id}:${action.command}`);
    setError("");
    try {
      await readJson(`/api/tasks/${encodeURIComponent(item.taskId)}/${path}`, { method: "POST", body: JSON.stringify({ expectedRevision: action.expectedRevision, ...(actionNote ? { note: actionNote } : {}) }) });
      setNoteAction(undefined);
      setCancelAction(undefined);
      setNote("");
      setStatus("");
      await reload();
    } catch (reason) {
      if (isApiError(reason, 409)) {
        setNoteAction(undefined);
        setCancelAction(undefined);
        setNote("");
        setStatus("This issue changed. Refreshing the current attention state.");
        await reload();
      } else {
        setError(reason instanceof Error ? reason.message : "Unable to apply attention action");
      }
    } finally {
      setActionBusy("");
    }
  }, [reload]);

  const requestAction = (item: ApiAttentionItem, action: ApiAttentionAction): void => {
    if (action.requiresNote) {
      setNote("");
      setNoteAction({ item, action });
    } else if (action.destructive) {
      setCancelAction({ item, action });
    } else {
      void performAction(item, action);
    }
  };

  const visibleCompanies = currentCompany ? companies.filter((company) => company.companyId === currentCompany.id) : companies;
  return (
    <ApplicationFrame title="Attention">
      <div>
        <div className="flex h-9 items-center justify-between px-3 text-xs sm:px-4"><span className="font-medium">Agency attention</span><Button variant="ghost" size="sm" onClick={() => void reload()}>Refresh</Button></div>
        {visibleCompanies.map((company) => <section className="bg-background p-3 sm:p-4" key={company.companyId}>
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2"><div className="flex items-center gap-2 text-[13px] font-medium"><span className={company.attentionCount ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-emerald-500"} />{company.companyName}</div><div className="text-[11px] text-muted-foreground">{company.activeIssueCount} active · {company.attentionCount} needs a person</div></div>
          <div className="mb-2 text-[11px] text-muted-foreground" data-projection-status={company.projectionHealth.status}>{company.projectionHealth.status === "stale" ? `Projection stale · r${company.projectionHealth.projectedRevision} → r${company.projectionHealth.sourceRevision}` : company.projectionHealth.status === "unknown" ? "Projection status unknown" : `Projection current · r${company.projectionHealth.projectedRevision}`}</div>
          <Accordion className="text-xs" multiple onValueChange={(value) => { for (const id of (Array.isArray(value) ? value : [value])) { const item = company.attention.find((candidate) => candidate.id === id); if (item) void loadEvidence(item); } }}>
            {company.attention.map((item) => <AccordionItem className="py-1" key={item.id} value={item.id}>
              <AccordionTrigger className="py-3"><span className="min-w-0 text-left"><Badge variant="secondary" className="mr-2 align-middle text-[10px]">{item.category.replaceAll("_", " ")}</Badge><span className="font-medium">{item.taskTitle}</span><span className="mt-1 block text-muted-foreground">{item.summary}</span></span></AccordionTrigger>
              <AccordionContent className="grid gap-3 pl-3 text-[11px] text-muted-foreground sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="min-w-0 space-y-2"><div>Evidence · {item.evidence.kind} · {item.evidence.byteSize} bytes</div>{evidence[item.id] ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-[11px] text-foreground">{evidence[item.id]?.content}{evidence[item.id]?.truncated ? "\n[truncated]" : ""}</pre> : <div>{evidenceLoading[item.id] ? "Loading safe evidence…" : "Safe evidence is available."}</div>}</div>
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">{item.actions.map((action) => <Button key={action.command} size="sm" variant={action.destructive ? "destructive" : "outline"} onClick={() => requestAction(item, action)} disabled={Boolean(actionBusy)}>{action.label}{action.requiresNote ? " · note" : ""}</Button>)}<a className="px-2 text-foreground underline underline-offset-2" href={withCompany(`/tasks/${encodeURIComponent(item.taskId)}`, item.companyId)}>Open issue</a></div>
              </AccordionContent>
            </AccordionItem>)}
          </Accordion>
          {company.attention.length === 0 ? <div className="py-5 text-center text-xs text-muted-foreground">No decision needed.</div> : null}
          {company.recentOutcomes.length ? <div className="mt-3 pt-2 text-[11px] text-muted-foreground">Recent: {company.recentOutcomes.map((outcome) => `${outcome.taskTitle} · ${outcome.phase}`).join(" · ")}</div> : null}
        </section>)}
        {visibleCompanies.length === 0 && !error ? <div className="p-8 text-center text-xs text-muted-foreground">No companies visible.</div> : null}
        {status ? <div role="status" aria-live="polite" className="px-4 py-2 text-xs text-amber-700">{status}</div> : null}
        {error ? <div className="mx-4 my-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      </div>
      <Dialog open={Boolean(noteAction)} onOpenChange={(open) => { if (!open && !actionBusy) setNoteAction(undefined); }}><DialogContent><DialogHeader><DialogTitle>{noteAction?.action.label}</DialogTitle><DialogDescription>A note is required before this issue can be updated.</DialogDescription></DialogHeader><Textarea aria-label={`${noteAction?.action.label ?? "Action"} note`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a concise decision note" /><DialogFooter><DialogClose render={<Button type="button" variant="ghost" />}>Keep issue</DialogClose><Button onClick={() => { if (noteAction) void performAction(noteAction.item, noteAction.action, note); }} disabled={!note.trim() || Boolean(actionBusy)}>{noteAction?.action.label}</Button></DialogFooter></DialogContent></Dialog>
      <AlertDialog open={Boolean(cancelAction)} onOpenChange={(open) => { if (!open && !actionBusy) setCancelAction(undefined); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cancel {cancelAction?.item.taskTitle}?</AlertDialogTitle><AlertDialogDescription>This stops the current issue workflow and keeps its history available.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep issue</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { if (cancelAction) void performAction(cancelAction.item, cancelAction.action); }} disabled={Boolean(actionBusy)}>Cancel issue</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </ApplicationFrame>
  );
}

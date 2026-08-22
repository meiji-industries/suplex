import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { Textarea } from ".././components/ui/textarea.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from ".././components/ui/alert-dialog.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { SettingsLayout } from ".././components/app/settings-layout.js";
import { isApiError, readJson, withCompany } from ".././lib/api.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { relativeTime, type ApiAttentionAction, type ApiAttentionCompany, type ApiAttentionItem } from "../lib/view-shared.js";

export function AttentionView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const [companies, setCompanies] = useState<ApiAttentionCompany[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [noteAction, setNoteAction] = useState<{ item: ApiAttentionItem; action: ApiAttentionAction }>();
  const [cancelAction, setCancelAction] = useState<{ item: ApiAttentionItem; action: ApiAttentionAction }>();
  const [note, setNote] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const reload = useCallback(async (): Promise<void> => {
    try { setError(""); setCompanies((await readJson<{ companies: ApiAttentionCompany[] }>("/api/attention")).companies); }
    catch (reason) { if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth"); else setError("Unable to load attention"); }
  }, []);
  useEffect(() => { void reload(); const timer = window.setInterval(() => void reload(), 15_000); return () => window.clearInterval(timer); }, [reload]);

  const performAction = useCallback(async (item: ApiAttentionItem, action: ApiAttentionAction, actionNote?: string): Promise<void> => {
    const path = action.command === "cancel_issue" ? "cancel" : action.command.replaceAll("_", "-");
    setActionBusy(`${item.taskId}:${action.command}`);
    setError("");
    try {
      await readJson(`/api/tasks/${encodeURIComponent(item.taskId)}/${path}`, { method: "POST", body: JSON.stringify({ expectedRevision: action.expectedRevision, ...(actionNote ? { note: actionNote } : {}) }) });
      setNoteAction(undefined); setCancelAction(undefined); setNote(""); setStatus(""); await reload();
    } catch (reason) {
      if (isApiError(reason, 409)) { setNoteAction(undefined); setCancelAction(undefined); setNote(""); setStatus("This issue changed. Refreshing the current attention state."); await reload(); }
      else setError(reason instanceof Error ? reason.message : "Unable to apply attention action");
    } finally { setActionBusy(""); }
  }, [reload]);

  const requestAction = (item: ApiAttentionItem, action: ApiAttentionAction): void => {
    if (action.requiresNote) { setNote(""); setNoteAction({ item, action }); }
    else if (action.destructive) setCancelAction({ item, action });
    else void performAction(item, action);
  };

  const visibleCompanies = currentCompany ? companies.filter((company) => company.companyId === currentCompany.id) : companies;
  const companyId = currentCompany?.id ?? "";
  return (
    <SettingsLayout title="Attention" companyId={companyId} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/attention", companyId)} contentClassName="">
      <div>
        <div className="flex h-9 items-center justify-between px-3 text-xs sm:px-4"><span className="font-medium">Attention</span><Button variant="ghost" size="sm" onClick={() => void reload()}>Refresh</Button></div>
        {visibleCompanies.map((company) => <section className="bg-background" key={company.companyId}>
          <div className="flex items-center justify-between border-y px-3 py-2 text-xs sm:px-4"><span className="font-medium">{company.companyName}</span><span className="text-muted-foreground">{company.attentionCount} needs a person</span></div>
          {company.attention.map((item) => <div className="grid gap-2 border-b px-3 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4" key={item.taskId}>
            <div className="min-w-0"><div className="font-medium">{item.issueKey ? <span className="mr-1.5 text-muted-foreground">{item.issueKey}</span> : null}{item.taskTitle}</div>{item.summary ? <div className="mt-0.5 text-muted-foreground">{item.summary}</div> : null}<div className="mt-1 text-[11px] text-muted-foreground">{relativeTime(item.activatedAt)}</div></div>
            <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">{item.actions.map((action) => <Button key={action.command} size="sm" variant={action.destructive ? "destructive" : "outline"} onClick={() => requestAction(item, action)} disabled={Boolean(actionBusy)}>{action.label}</Button>)}<a className="px-2 text-foreground underline underline-offset-2" href={withCompany(`/tasks/${encodeURIComponent(item.taskId)}`, item.companyId)}>Open issue</a></div>
          </div>)}
          {company.attention.length === 0 ? <div className="px-3 py-5 text-center text-xs text-muted-foreground sm:px-4">No tasks need a person.</div> : null}
        </section>)}
        {visibleCompanies.length === 0 && !error ? <div className="p-8 text-center text-xs text-muted-foreground">No companies visible.</div> : null}
        {status ? <div role="status" aria-live="polite" className="px-4 py-2 text-xs text-amber-700">{status}</div> : null}
        {error ? <div className="mx-4 my-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      </div>
      <Dialog open={Boolean(noteAction)} onOpenChange={(open) => { if (!open && !actionBusy) setNoteAction(undefined); }}><DialogContent><DialogHeader><DialogTitle>{noteAction?.action.label}</DialogTitle><DialogDescription>A note is required before this issue can be updated.</DialogDescription></DialogHeader><Textarea aria-label={`${noteAction?.action.label ?? "Action"} note`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a concise decision note" /><DialogFooter><DialogClose render={<Button type="button" variant="ghost" />}>Keep issue</DialogClose><Button onClick={() => { if (noteAction) void performAction(noteAction.item, noteAction.action, note); }} disabled={!note.trim() || Boolean(actionBusy)}>{noteAction?.action.label}</Button></DialogFooter></DialogContent></Dialog>
      <AlertDialog open={Boolean(cancelAction)} onOpenChange={(open) => { if (!open && !actionBusy) setCancelAction(undefined); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cancel {cancelAction?.item.issueKey ? `${cancelAction.item.issueKey} · ` : ""}{cancelAction?.item.taskTitle}?</AlertDialogTitle><AlertDialogDescription>This stops the current issue workflow and keeps its history available.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep issue</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { if (cancelAction) void performAction(cancelAction.item, cancelAction.action); }} disabled={Boolean(actionBusy)}>Cancel issue</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </SettingsLayout>
  );
}

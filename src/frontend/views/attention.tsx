import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { Textarea } from ".././components/ui/textarea.js";
import { RadioGroup, RadioGroupItem } from ".././components/ui/radio-group.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from ".././components/ui/alert-dialog.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { SettingsLayout } from ".././components/app/settings-layout.js";
import { isApiError, readJson, withCompany } from ".././lib/api.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { relativeTime, type ApiAttentionAction, type ApiAttentionCompany, type ApiAttentionItem } from "../lib/view-shared.js";
import { RefreshCw } from "lucide-react";

export function AttentionView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const [companies, setCompanies] = useState<ApiAttentionCompany[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [noteAction, setNoteAction] = useState<{ item: ApiAttentionItem; action: ApiAttentionAction }>();
  const [cancelAction, setCancelAction] = useState<{ item: ApiAttentionItem; action: ApiAttentionAction }>();
  const [note, setNote] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
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

  const cardAction = (item: ApiAttentionItem, cardAction: ApiAttentionItem["card"]["primaryAction"]): ApiAttentionAction => item.actions.find((action) => action.command === cardAction.command) ?? { command: cardAction.command as ApiAttentionAction["command"], label: cardAction.label, expectedRevision: item.sourceRevision, requiresNote: Boolean(cardAction.requiresNote), destructive: Boolean(cardAction.destructive) };

  const visibleCompanies = currentCompany ? companies.filter((company) => company.companyId === currentCompany.id) : companies;
  const companyId = currentCompany?.id ?? "";
  return (
    <SettingsLayout title="Tasks that need you" companyId={companyId} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/attention", companyId)} contentClassName="">
      <div>
        <div className="flex h-9 items-center justify-between px-3 text-xs sm:px-4"><span className="font-medium">Tasks that need you</span><Button variant="ghost" size="icon-xs" aria-label="Refresh" title="Refresh" onClick={() => void reload()}><RefreshCw aria-hidden="true" /></Button></div>
        {visibleCompanies.map((company) => <section className="bg-background" key={company.companyId}>
          <div className="flex items-center justify-between border-y px-3 py-2 text-xs sm:px-4"><span className="font-medium">{company.companyName}</span><span className="text-muted-foreground">{company.attentionCount}</span></div>
          {company.attention.map((item) => <div className="grid gap-2 border-b px-3 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4" key={item.taskId}>
            <div className="min-w-0"><a className="font-medium hover:underline" href={withCompany(`/tasks/${encodeURIComponent(item.taskId)}`, item.companyId)}>{item.taskTitle}</a><div className="mt-0.5 text-muted-foreground">{item.card.title}</div><div className="mt-0.5 text-muted-foreground">{item.card.explanation}</div><div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">{item.card.evidence.map((evidence) => evidence.kind === "url" ? <a className="hover:underline" href={evidence.ref} key={evidence.ref}>{evidence.label || evidence.ref}</a> : <span key={evidence.ref}>{evidence.label || evidence.ref}</span>)}</div>{item.card.decision ? <div className="mt-2"><RadioGroup value={decisions[item.taskId] || item.card.decision.recommendedChoiceId} onValueChange={(value) => setDecisions((current) => ({ ...current, [item.taskId]: value }))} aria-label={item.card.title}>{item.card.decision.choices.map((choice) => <label className="flex items-center gap-1.5 py-0.5" key={choice.id}><RadioGroupItem value={choice.id} />{choice.label}</label>)}</RadioGroup><Textarea aria-label={`${item.card.title} note`} className="mt-1" value={decisionNotes[item.taskId] || ""} onChange={(event) => setDecisionNotes((current) => ({ ...current, [item.taskId]: event.target.value }))} placeholder={item.card.decision.freeTextPrompt} /></div> : null}</div>
            <div className="flex flex-wrap items-center gap-1.5 sm:justify-end"><Button size="sm" variant={item.card.primaryAction.destructive ? "destructive" : "outline"} onClick={() => { const action = cardAction(item, item.card.primaryAction); const decision = item.card.decision; const choice = decision?.choices.find((entry) => entry.id === (decisions[item.taskId] || decision.recommendedChoiceId)); if (action.requiresNote) void performAction(item, action, [choice?.label, decisionNotes[item.taskId]].filter(Boolean).join("\n")); else requestAction(item, action); }} disabled={Boolean(actionBusy)}>{item.card.primaryAction.label}</Button>{item.card.secondaryAction ? <Button size="sm" variant={item.card.secondaryAction.destructive ? "destructive" : "ghost"} onClick={() => requestAction(item, cardAction(item, item.card.secondaryAction!))} disabled={Boolean(actionBusy)}>{item.card.secondaryAction.label}</Button> : null}<span className="whitespace-nowrap text-[11px] text-muted-foreground">{relativeTime(item.activatedAt)}</span></div>
          </div>)}
          {company.attention.length === 0 ? <div className="px-3 py-5 text-center text-xs text-muted-foreground sm:px-4">Nothing needs you right now.</div> : null}
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

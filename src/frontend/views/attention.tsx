import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { TaskAttentionCard } from ".././components/app/task-attention-card.js";
import { LiveStatusDot, TaskStatusIcon } from ".././components/app/task-status.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { SettingsLayout } from ".././components/app/settings-layout.js";
import { isApiError, readJson, withCompany } from ".././lib/api.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { relativeTime, type ApiAttentionAction, type ApiAttentionCompany, type ApiAttentionItem } from "../lib/view-shared.js";
import { RefreshCw } from "lucide-react";
import type { IssuePhase } from "../../issue-phases.js";

function isIssuePhase(phase: string): phase is IssuePhase {
  return ["backlog", "planning", "approval", "building", "reviewing", "shipping", "done", "cancelled"].includes(phase);
}

export function attentionActionBody(action: ApiAttentionAction, actionNote: string | undefined, idempotencyKey: string): Record<string, unknown> {
  return { expectedRevision: action.expectedRevision, ...(actionNote ? { note: actionNote } : {}), ...(action.idempotency === "required" ? { idempotencyKey } : {}) };
}
export function documentTitle(count: number): string { return count > 0 ? `(${count}) Forge` : "Forge"; }

export function AttentionView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const [companies, setCompanies] = useState<ApiAttentionCompany[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const reload = useCallback(async (): Promise<void> => {
    try { setError(""); setCompanies((await readJson<{ companies: ApiAttentionCompany[] }>("/api/attention")).companies); }
    catch (reason) { if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth"); else setError("Unable to load attention"); }
  }, []);
  useEffect(() => { void reload(); const timer = window.setInterval(() => void reload(), 15_000); return () => window.clearInterval(timer); }, [reload]);

  const performAction = useCallback(async (item: ApiAttentionItem, action: ApiAttentionAction, actionNote: string | undefined, idempotencyKey: string): Promise<void> => {
    const path = action.command === "cancel_issue" ? "cancel" : action.command.replaceAll("_", "-");
    setActionBusy(`${item.taskId}:${action.command}`);
    setError("");
    try {
      await readJson(`/api/tasks/${encodeURIComponent(item.taskId)}/${path}`, { method: "POST", body: JSON.stringify(attentionActionBody(action, actionNote, idempotencyKey)) });
      setStatus(""); await reload();
    } catch (reason) {
      if (isApiError(reason, 409)) { setStatus("This task changed. Forge refreshes the attention state."); await reload(); }
      else setError(reason instanceof Error ? reason.message : "Unable to apply attention action");
    } finally { setActionBusy(""); }
  }, [reload]);

  const cardAction = (item: ApiAttentionItem, cardAction: ApiAttentionItem["card"]["primaryAction"]): ApiAttentionAction => item.actions.find((action) => action.command === cardAction.command) ?? { command: cardAction.command as ApiAttentionAction["command"], label: cardAction.label, expectedRevision: item.sourceRevision, requiresNote: Boolean(cardAction.requiresNote), destructive: Boolean(cardAction.destructive), idempotency: "none" };

  const visibleCompanies = currentCompany ? companies.filter((company) => company.companyId === currentCompany.id) : companies;
  const attentionCount = visibleCompanies.reduce((total, company) => total + company.attentionCount, 0);
  useEffect(() => { document.title = documentTitle(attentionCount); }, [attentionCount]);
  const companyId = currentCompany?.id ?? "";
  return (
    <SettingsLayout title="Tasks that need you" companyId={companyId} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/attention", companyId)} contentClassName="">
      <div>
        <div className="flex h-9 items-center justify-between px-3 text-xs sm:px-4"><span className="font-medium">Tasks that need you</span><Button variant="ghost" size="icon-xs" aria-label="Refresh" title="Refresh" onClick={() => void reload()}><RefreshCw aria-hidden="true" /></Button></div>
        {visibleCompanies.map((company) => <section className="bg-background" key={company.companyId}>
          <div className="flex items-center justify-between border-y px-3 py-2 text-xs sm:px-4"><span className="font-medium">{company.companyName}</span><span className="text-muted-foreground">{company.attentionCount}</span></div>
          {[...company.attention].sort((left, right) => {
            const group = (item: ApiAttentionItem): number => item.actions.some((action) => action.command === "approve_plan") ? 2 : item.liveStatus.some((entry) => entry.status === "blocked" || entry.status === "awaiting_human") ? 1 : 0;
            return group(left) - group(right);
          }).map((item) => <div className="grid gap-2 border-b px-3 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4" key={item.taskId}>
            <div className="min-w-0"><a className="flex items-center gap-1.5 font-medium hover:underline" href={withCompany(`/tasks/${encodeURIComponent(item.taskId)}`, item.companyId)}><TaskStatusIcon phase={isIssuePhase(item.phase) ? item.phase : "approval"} /><LiveStatusDot liveStatus={item.liveStatus} /><span>{item.taskTitle}</span></a><div className="mt-2"><TaskAttentionCard card={item.card} busy={Boolean(actionBusy)} onAction={(command, note, idempotencyKey) => void performAction(item, cardAction(item, { command, label: command }), note, idempotencyKey)} /></div></div>
            <span className="whitespace-nowrap text-[11px] text-muted-foreground sm:self-end">{relativeTime(item.activatedAt)}</span>
          </div>)}
          {company.attention.length === 0 ? <div className="px-3 py-5 text-center text-xs text-muted-foreground sm:px-4">Nothing needs you right now.</div> : null}
        </section>)}
        {visibleCompanies.length === 0 && !error ? <div className="p-8 text-center text-xs text-muted-foreground">No companies visible.</div> : null}
        {status ? <div role="status" aria-live="polite" className="px-4 py-2 text-xs text-amber-700">{status}</div> : null}
        {error ? <div className="mx-4 my-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      </div>
    </SettingsLayout>
  );
}

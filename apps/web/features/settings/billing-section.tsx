import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Spinner } from "../../components/ui/spinner.js";
import { isApiError } from "../../lib/api.js";
import type { BillingSummary } from "../../contracts/billing.js";
import { changePlan, getBillingSummary, openBillingPortal, startCheckout, startTrial } from "./lib/billing-api.js";
import { PlanTable, type PlanTarget } from "./plan-table.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { useVisibleRefresh } from "../../shell/use-visible-refresh.js";
import { SettingsSection, SettingRow } from "./settings-layout.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

export { formatUsd } from "./plan-table.js";

/** The page reads the plan this often while it is shown, so a change made in Stripe or another tab appears. */
const refreshIntervalMs = 15_000;

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString();
}

function actionMessage(reason: unknown): string {
  if (isApiError(reason)) {
    if (reason.code === "billing_unavailable" || reason.code === "billing_not_configured") return "Suplex cannot check the subscription. Retry the request.";
    if (reason.code === "trial_used") return "This Suplex account used its trial. Select Pro to continue.";
    if (reason.code === "account_required") return "Log in to your Suplex account. Then retry.";
    if (reason.code === "billing_payment_pending") return "A payment is pending. Approve the payment or check the subscription.";
    if (reason.code === "billing_operation_not_applied") return "The change was not applied. Try again.";
    return reason.message;
  }
  return reason instanceof Error ? reason.message : "Suplex cannot check the subscription.";
}


// A browser allows a new tab only during the click, so open it before the
// request and send it to the hosted URL when the answer arrives.
function pendingTab(): { go: (url: string) => void; close: () => void } {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  return {
    go: (url) => { if (tab) tab.location.href = url; else window.location.assign(url); },
    close: () => tab?.close(),
  };
}

function limitText(used: number, limit: number | null): string {
  return `${used} / ${limit === null ? "Unlimited" : limit}`;
}

function planDetail(summary: BillingSummary): string {
  if (summary.teamLapsed) return "Team ended. Work is read-only until you select Team again.";
  if (summary.plan === "team") {
    if (summary.cancelAtPeriodEnd && summary.accessUntil) return `Team ends on ${formatDate(summary.accessUntil)}.`;
    return summary.renewalAt ? `Renews on ${formatDate(summary.renewalAt)}.` : "Team is active.";
  }
  const trial = summary.plan === "pro" && summary.subscriptionStatus === "trialing";
  if (trial) return summary.accessUntil ? `The trial ends on ${formatDate(summary.accessUntil)}. Add a payment method in Open billing to keep Pro.` : "The trial is active.";
  // The summary does not tell monthly from yearly, so the price is not shown.
  if (summary.plan === "pro") {
    if (summary.cancelAtPeriodEnd && summary.accessUntil) return `Pro ends on ${formatDate(summary.accessUntil)}.`;
    return summary.renewalAt ? `Renews on ${formatDate(summary.renewalAt)}.` : "Pro is active.";
  }
  return "Free includes 1 company, 2 projects, 3 tasks at a time, and 50 tasks each month.";
}

// Copy that tells why the plan cannot change from here.
function planNotice(summary: BillingSummary): string | undefined {
  if (!summary.purchaseConfigured) return "Billing is not configured on this host.";
  if (!summary.accountLinked) return "Log in to your Suplex account to start a trial or select Pro.";
  if (!summary.checked) return "Suplex cannot check the subscription. The last confirmed plan applies.";
  return undefined;
}

export function BillingSection(): ReactElement {
  const [summary, setSummary] = useState<BillingSummary>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const checkoutKey = useRef<string | undefined>(undefined);
  const checkoutChoice = useRef("");
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const reading = useRef(false);
  // Each applied summary starts a new version, so a background read that
  // began before an action does not replace the action's newer answer.
  const version = useRef(0);

  const applyBillingSummary = useOptionalCompanyContext()?.applyBillingSummary;
  const applySummary = useCallback((next: BillingSummary): void => {
    version.current += 1;
    setSummary(next);
    // A live read refreshes the plan in the shell.
    applyBillingSummary?.(next);
    setState("ready");
    setErrorText("");
  }, [applyBillingSummary]);

  const load = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const next = await getBillingSummary();
      if (mounted.current) applySummary(next);
    } catch (reason) {
      if (!mounted.current) return;
      setState("error");
      setErrorText(reason instanceof Error ? reason.message : "Suplex cannot check the subscription.");
    }
  }, [applySummary]);

  // A background read never shows the loading state, and a failed one keeps
  // the last summary. It waits while an action runs.
  const reload = useCallback((): void => {
    if (reading.current || busyRef.current) return;
    reading.current = true;
    const started = version.current;
    void getBillingSummary().then((next) => {
      if (mounted.current && !busyRef.current && version.current === started) applySummary(next);
    }, () => undefined).finally(() => { reading.current = false; });
  }, [applySummary]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  useVisibleRefresh(reload, refreshIntervalMs);

  const run = async (name: string, action: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(name);
    setActionError("");
    try {
      await action();
    } catch (reason) {
      setActionError(actionMessage(reason));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };

  const trial = (): Promise<void> => run("trial", async () => { applySummary(await startTrial()); });

  const checkout = ({ plan, interval, quantity }: PlanTarget): Promise<void> => run(`plan:${plan}`, async () => {
    if (plan === "free") return;
    const tab = pendingTab();
    try {
      // One key per plan, period, and seats: a retry of the same choice reuses it.
      const choice = `${plan}:${interval}:${quantity}`;
      if (checkoutChoice.current !== choice) checkoutKey.current = undefined;
      checkoutChoice.current = choice;
      checkoutKey.current ??= crypto.randomUUID();
      const result = await startCheckout(checkoutKey.current, interval, plan, quantity);
      if (result.status === "redirect") {
        tab.go(result.url);
        return;
      }
      tab.close();
      applySummary(result.summary);
      checkoutKey.current = undefined;
    } catch (reason) {
      tab.close();
      // The hosted service ended this checkout command. A new key starts a fresh one.
      if (isApiError(reason) && reason.code === "billing_operation_not_applied") checkoutKey.current = undefined;
      throw reason;
    }
  });

  const change = ({ plan, interval, quantity }: PlanTarget): Promise<void> => run(`plan:${plan}`, async () => {
    const tab = pendingTab();
    try {
      tab.go((await changePlan(plan, interval, quantity)).url);
    } catch (reason) {
      tab.close();
      throw reason;
    }
  });

  const portal = (): Promise<void> => run("portal", async () => {
    const tab = pendingTab();
    try {
      tab.go((await openBillingPortal()).url);
    } catch (reason) {
      tab.close();
      throw reason;
    }
  });

  if (state !== "ready" || !summary) {
    return (
      <SettingsSection>
        {state === "error" ? (
          <div className="py-3"><Alert variant="destructive"><AlertDescription>{/[.!?]$/.test(errorText) ? errorText : `${errorText}.`} Reload the page to retry.</AlertDescription></Alert></div>
        ) : (
          <div className="space-y-2 py-3" aria-busy="true" aria-label="Billing status">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner /><span>Billing status</span></div>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        )}
      </SettingsSection>
    );
  }

  const trialing = summary.plan === "pro" && summary.subscriptionStatus === "trialing";
  const notice = planNotice(summary);
  const ready = summary.canManageBilling && notice === undefined;
  const hasSubscription = summary.subscriptionStatus !== null && summary.subscriptionStatus !== "none";
  const showPortal = ready && (summary.plan !== "free" || hasSubscription);
  const { limits, usage } = summary;
  const planLabel = trialing ? "Pro trial" : summary.teamLapsed ? "Team ended" : `${summary.plan[0]!.toUpperCase()}${summary.plan.slice(1)} plan`;

  return (
    <>
      {actionError ? <div className="mb-4"><Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert></div> : null}
      <SettingsSection>
        <SettingRow label={planLabel} description={notice ? <>{planDetail(summary)}<br />{notice}</> : planDetail(summary)}>
          {showPortal ? <Button size="sm" variant="outline" onClick={() => void portal()} disabled={busy !== ""}>{busy === "portal" ? <Spinner /> : null}Open billing</Button> : null}
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Plans">
        <PlanTable summary={summary} canChange={ready && !summary.paymentActionRequired} busy={busy} onTrial={() => void trial()} onCheckout={target => void checkout(target)} onChange={target => void change(target)} />
      </SettingsSection>
      <SettingsSection title="Usage">
        {summary.plan === "team" ? <SettingRow label="Seats" description="Each user who is not revoked uses a seat."><span className="text-xs text-muted-foreground">{summary.seatsUsed} of {summary.purchasedSeats}</span></SettingRow> : null}
        <SettingRow label="Companies" description="Archived companies do not count."><span className="text-xs text-muted-foreground">{limitText(usage.companies, limits.companies)}</span></SettingRow>
        <SettingRow label="Projects" description="Projects in all companies count."><span className="text-xs text-muted-foreground">{limitText(usage.projects, limits.projects)}</span></SettingRow>
        <SettingRow label="Tasks at a time" description="Other tasks wait in the queue."><span className="text-xs text-muted-foreground">{limitText(usage.runningTasks, limits.runningTasks)}</span></SettingRow>
        <SettingRow label="Tasks this month" description="The count starts again on the first day of each month."><span className="text-xs text-muted-foreground">{limitText(usage.monthlyTasks, limits.monthlyTasks)}</span></SettingRow>
      </SettingsSection>
      {summary.paymentActionRequired ? (
        <SettingsSection title="Billing details">
          <SettingRow label="Payment" description="Suplex applies the change after you approve the payment.">
            {summary.paymentActionUrl ? <a className="text-xs text-primary underline underline-offset-2" href={summary.paymentActionUrl} target="_blank" rel="noopener noreferrer">Approve the payment</a> : <span className="text-xs text-muted-foreground">Open billing to approve it.</span>}
          </SettingRow>
        </SettingsSection>
      ) : null}
    </>
  );
}

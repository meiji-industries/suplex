import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Spinner } from "../../components/ui/spinner.js";
import { isApiError } from "../../lib/api.js";
import { PRO_MONTHLY_AMOUNT, type BillingSummary } from "../../contracts/billing.js";
import { getBillingSummary, openBillingPortal, startCheckout, startTrial } from "./lib/billing-api.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { SettingsSection, SettingRow } from "./settings-layout.js";
import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

// USD has two minor-unit digits. Whole dollars read "$20"; any cents are exact: "$13.33".
export function formatUsd(minorUnits: number): string {
  const digits = minorUnits % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minorUnits / 100);
}

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

const PRO_FEATURES = ["3 companies", "10 projects", "Unlimited tasks at a time", "Unlimited tasks each month"];

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
  const trial = summary.plan === "pro" && summary.subscriptionStatus === "trialing";
  if (trial) return summary.accessUntil ? `The trial ends on ${formatDate(summary.accessUntil)}. Add a payment method in Open billing to keep Pro.` : "The trial is active.";
  if (summary.plan === "pro") {
    const price = `${formatUsd(PRO_MONTHLY_AMOUNT)} each month`;
    if (summary.cancelAtPeriodEnd && summary.accessUntil) return `${price}. Pro ends on ${formatDate(summary.accessUntil)}.`;
    return summary.renewalAt ? `${price}. Renews on ${formatDate(summary.renewalAt)}.` : `${price}.`;
  }
  return "Free includes 1 company, 1 project, 3 tasks at a time, and 50 tasks each month.";
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
  const [externalOpen, setExternalOpen] = useState(false);
  const checkoutKey = useRef<string | undefined>(undefined);
  const mounted = useRef(true);

  const setPlan = useOptionalCompanyContext()?.setPlan;
  const applySummary = useCallback((next: BillingSummary): void => {
    setSummary(next);
    // A live read refreshes the switcher label.
    if (next.checked) setPlan?.(next.plan);
    setState("ready");
    setErrorText("");
    if (next.plan === "pro" && !next.paymentActionRequired) setExternalOpen(false);
  }, [setPlan]);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setState("loading");
    try {
      const next = await getBillingSummary();
      if (mounted.current) applySummary(next);
    } catch (reason) {
      if (!mounted.current) return;
      setState("error");
      setErrorText(reason instanceof Error ? reason.message : "Suplex cannot check the subscription.");
    }
  }, [applySummary]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  useEffect(() => {
    if (!externalOpen) return;
    const onFocus = (): void => { void load(true); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [externalOpen, load]);

  const run = async (name: string, action: () => Promise<void>): Promise<void> => {
    if (busy !== "") return;
    setBusy(name);
    setActionError("");
    try {
      await action();
    } catch (reason) {
      setActionError(actionMessage(reason));
    } finally {
      setBusy("");
    }
  };

  const trial = (): Promise<void> => run("trial", async () => { applySummary(await startTrial()); });

  const checkout = (): Promise<void> => run("checkout", async () => {
    const tab = pendingTab();
    try {
      checkoutKey.current ??= crypto.randomUUID();
      const result = await startCheckout(checkoutKey.current);
      if (result.status === "redirect") {
        tab.go(result.url);
        setExternalOpen(true);
        return;
      }
      tab.close();
      applySummary(result.summary);
      checkoutKey.current = undefined;
      if (result.status === "payment_required") setExternalOpen(true);
    } catch (reason) {
      tab.close();
      // The hosted service ended this checkout command. A new key starts a fresh one.
      if (isApiError(reason) && reason.code === "billing_operation_not_applied") checkoutKey.current = undefined;
      throw reason;
    }
  });

  const portal = (): Promise<void> => run("portal", async () => {
    const tab = pendingTab();
    try {
      tab.go((await openBillingPortal()).url);
      setExternalOpen(true);
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
  const canUpgrade = ready && summary.plan === "free" && !summary.paymentActionRequired;
  const showPortal = ready && (summary.plan === "pro" || hasSubscription);
  const { limits, usage } = summary;

  return (
    <>
      {actionError ? <div className="mb-4"><Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert></div> : null}
      <SettingsSection>
        <SettingRow label={trialing ? "Pro trial" : summary.plan === "pro" ? "Pro plan" : "Free plan"} description={notice ? <>{planDetail(summary)}<br />{notice}</> : planDetail(summary)}>
          {showPortal ? <Button size="sm" variant="outline" onClick={() => void portal()} disabled={busy !== ""}>{busy === "portal" ? <Spinner /> : null}Open billing</Button> : null}
        </SettingRow>
      </SettingsSection>
      {canUpgrade ? (
        <SettingsSection>
          <SettingRow label="Upgrade to Pro" description={summary.trialAvailable ? `Pro is free for 30 days. No credit card is necessary. Then ${formatUsd(PRO_MONTHLY_AMOUNT)} each month. Taxes are additional.` : `${formatUsd(PRO_MONTHLY_AMOUNT)} each month. Taxes are additional.`}>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {summary.trialAvailable ? <Button size="sm" onClick={() => void trial()} disabled={busy !== ""}>{busy === "trial" ? <Spinner /> : null}Start the 30-day trial</Button> : null}
              <Button size="sm" variant={summary.trialAvailable ? "outline" : "default"} onClick={() => void checkout()} disabled={busy !== ""}>{busy === "checkout" ? <Spinner /> : null}Select Pro</Button>
            </div>
          </SettingRow>
          <ul className="grid gap-2 border-t py-3 text-xs sm:grid-cols-2">
            {PRO_FEATURES.map(feature => <li key={feature} className="flex items-center gap-2"><Check aria-hidden="true" className="size-3.5 text-primary" />{feature}</li>)}
          </ul>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Usage">
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

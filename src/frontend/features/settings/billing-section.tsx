import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Spinner } from "../../components/ui/spinner.js";
import { isApiError } from "../../lib/api.js";
import { BILLING_SEAT_UNIT_AMOUNT, type BillingSummary, type HostedSeatPreview } from "../../contracts/billing.js";
import { changeSeats, getBillingSummary, openBillingPortal, previewSeats, startCheckout } from "./lib/billing-api.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { SettingsSection, SettingRow } from "./settings-layout.js";
import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

// USD has two minor-unit digits. Whole dollars read "$40"; any cents are exact: "$13.33".
export function formatUsd(minorUnits: number): string {
  const digits = minorUnits % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minorUnits / 100);
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString();
}

function parseSeats(value: string): number {
  return /^\d+$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : Number.NaN;
}

function seatQuantityValid(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 9999;
}

function summaryPaymentUrl(summary: BillingSummary): string | undefined {
  return summary.plan === "unknown" ? undefined : (summary.paymentActionUrl ?? undefined);
}

function summaryPaymentRequired(summary: BillingSummary): boolean {
  return summary.plan !== "unknown" && summary.paymentActionRequired === true;
}

function actionMessage(reason: unknown): string {
  if (isApiError(reason)) {
    if (reason.code === "billing_unavailable" || reason.code === "billing_not_configured") return "Suplex cannot check the subscription. Retry the request.";
    if (reason.code === "invalid_seat_quantity") return "The seat count is not valid.";
    if (reason.code === "idempotency_conflict") return "Suplex saved a different request with this key. Check the subscription and retry.";
    if (reason.code === "billing_payment_pending") return "A payment is pending. Approve the payment or check the subscription.";
    if (reason.code === "billing_operation_not_applied") return "The change was not applied. Review a new quote and try again.";
    if (reason.code === "no_subscription") return "No subscription exists for this company.";
    return reason.message;
  }
  return reason instanceof Error ? reason.message : "Suplex cannot check the subscription.";
}

const PRO_FEATURES = ["Unlimited projects", "One seat for each active account", "Prorated seat increases", "Payment and invoices in Stripe"];

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

// Source-derived terminal subscription statuses permit a fresh purchase. Any
// other real status means a subscription still exists and must not be
// duplicated, even when paid access is gone.
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

// One immutable seat command identity: an increase is bound to its quote, a
// decrease to the acknowledged no-refund quantity. A transport retry repeats
// the stored key; a new preview or acknowledgment gets a new key.
type SeatCommandIntent =
  | { kind: "increase"; key: string; quantity: number; previewId: string }
  | { kind: "decrease"; key: string; quantity: number };

export function BillingSection({ companyId }: { companyId: string }): ReactElement {
  const [summary, setSummary] = useState<BillingSummary>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchaseSeats, setPurchaseSeats] = useState("");
  const [seatSeats, setSeatSeats] = useState("");
  const [preview, setPreview] = useState<HostedSeatPreview>();
  const [decreaseQuantity, setDecreaseQuantity] = useState<number>();
  const [paymentUrl, setPaymentUrl] = useState<string>();
  const [externalOpen, setExternalOpen] = useState(false);

  const generation = useRef(0);
  const checkoutKey = useRef<{ key: string; quantity: number } | undefined>(undefined);
  const seatKey = useRef<SeatCommandIntent | undefined>(undefined);

  const setCompanyPlan = useOptionalCompanyContext()?.setCompanyPlan;
  const applySummary = useCallback((next: BillingSummary): void => {
    setSummary(next);
    // A live read refreshes the switcher label; an unknown plan keeps the last one.
    if (next.plan !== "unknown") setCompanyPlan?.(companyId, next.plan);
    setState("ready");
    setErrorText("");
    setPaymentUrl(summaryPaymentUrl(next));
    if (next.plan === "pro" && !next.paymentActionRequired) {
      setExternalOpen(false);
    }
  }, [companyId, setCompanyPlan]);

  const load = useCallback(async (silent = false): Promise<void> => {
    const gen = generation.current;
    if (!silent) setState("loading");
    try {
      const next = await getBillingSummary(companyId);
      if (gen !== generation.current) return;
      applySummary(next);
    } catch (reason) {
      if (gen !== generation.current) return;
      setState("error");
      setErrorText(reason instanceof Error ? reason.message : "Suplex cannot check the subscription.");
    }
  }, [companyId, applySummary]);

  useEffect(() => {
    generation.current += 1;
    setSummary(undefined);
    setState("loading");
    setErrorText("");
    setActionError("");
    setBusy("");
    setPurchaseOpen(false);
    setPurchaseSeats("");
    setSeatSeats("");
    setPreview(undefined);
    setDecreaseQuantity(undefined);
    setPaymentUrl(undefined);
    setExternalOpen(false);
    checkoutKey.current = undefined;
    seatKey.current = undefined;
    void load();
    return () => { generation.current += 1; };
  }, [companyId, load]);

  useEffect(() => {
    if (!externalOpen) return;
    const onFocus = (): void => { void load(true); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [externalOpen, load]);

  const submitPurchase = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const quantity = parseSeats(purchaseSeats);
    if (!seatQuantityValid(quantity) || busy !== "") return;
    setBusy("checkout");
    setActionError("");
    const tab = pendingTab();
    try {
      if (!checkoutKey.current || checkoutKey.current.quantity !== quantity) {
        checkoutKey.current = { key: crypto.randomUUID(), quantity };
      }
      const result = await startCheckout(companyId, quantity, checkoutKey.current.key);
      if (result.status === "redirect") {
        tab.go(result.url);
        setExternalOpen(true);
        setPurchaseOpen(false);
      } else {
        tab.close();
        applySummary(result.summary);
        if (result.status === "subscribed") checkoutKey.current = undefined;
        if (result.status === "payment_required") {
          setPaymentUrl(result.url ?? summaryPaymentUrl(result.summary));
          setExternalOpen(true);
        }
        setPurchaseOpen(false);
      }
    } catch (reason) {
      tab.close();
      if (isApiError(reason) && reason.code === "billing_operation_not_applied") {
        // The hosted service marked this checkout command terminal. Clearing
        // the key lets a new confirmation start a fresh purchase; it never
        // replays the expired attempt.
        checkoutKey.current = undefined;
        setActionError("The purchase was not applied. Review the seat count and try again.");
      } else {
        setActionError(actionMessage(reason));
      }
    } finally {
      setBusy("");
    }
  };

  const submitSeats = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const quantity = parseSeats(seatSeats === "" && summary?.plan === "pro" ? String(summary.purchasedSeats) : seatSeats);
    if (!seatQuantityValid(quantity) || busy !== "" || !summary || summary.plan !== "pro") return;
    if (quantity === summary.purchasedSeats) return;
    setActionError("");
    if (quantity < summary.purchasedSeats) {
      setDecreaseQuantity(quantity);
      return;
    }
    setBusy("preview");
    try {
      const result = await previewSeats(companyId, quantity);
      setPreview(result);
    } catch (reason) {
      setActionError(actionMessage(reason));
    } finally {
      setBusy("");
    }
  };

  const confirmIncrease = async (): Promise<void> => {
    const quote = preview;
    if (!quote || busy !== "") return;
    setBusy("seats");
    setActionError("");
    try {
      if (seatKey.current?.kind !== "increase" || seatKey.current.quantity !== quote.requestedQuantity || seatKey.current.previewId !== quote.previewId) {
        seatKey.current = { kind: "increase", key: crypto.randomUUID(), quantity: quote.requestedQuantity, previewId: quote.previewId };
      }
      const result = await changeSeats(companyId, { quantity: quote.requestedQuantity, previewId: quote.previewId }, seatKey.current.key);
      applySummary(result.summary);
      setPreview(undefined);
      setSeatSeats("");
      seatKey.current = undefined;
      if (result.status === "payment_required") {
        setPaymentUrl(result.url ?? summaryPaymentUrl(result.summary));
        setExternalOpen(true);
      }
    } catch (reason) {
      if (isApiError(reason) && reason.code === "billing_quote_changed") {
        // The replacement quote is a new intent; a new key avoids an
        // idempotency conflict with the consumed preview.
        seatKey.current = undefined;
        try {
          const next = await previewSeats(companyId, quote.requestedQuantity);
          setPreview(next);
          setActionError("The quote changed. Review the new amounts before you save.");
        } catch (previewReason) {
          setActionError(actionMessage(previewReason));
        }
      } else if (isApiError(reason) && reason.code === "billing_operation_not_applied") {
        // Terminal command: discard it and offer a new preview instead of
        // retrying a request the hosted service will never apply.
        seatKey.current = undefined;
        setPreview(undefined);
        setActionError("The change was not applied. Review a new quote and try again.");
      } else {
        setActionError(actionMessage(reason));
      }
    } finally {
      setBusy("");
    }
  };

  const confirmDecrease = async (): Promise<void> => {
    const quantity = decreaseQuantity;
    if (quantity === undefined || busy !== "") return;
    // The acknowledged quantity identifies the decrease command. The key
    // survives a failed send so a resubmission retries the same command;
    // canceling the confirmation or a terminal response clears it.
    if (seatKey.current?.kind !== "decrease" || seatKey.current.quantity !== quantity) {
      seatKey.current = { kind: "decrease", key: crypto.randomUUID(), quantity };
    }
    const key = seatKey.current.key;
    setDecreaseQuantity(undefined);
    setBusy("seats");
    setActionError("");
    try {
      const result = await changeSeats(companyId, { quantity, confirmNoRefund: true }, key);
      applySummary(result.summary);
      setSeatSeats("");
      seatKey.current = undefined;
      if (result.status === "payment_required") {
        setPaymentUrl(result.url ?? summaryPaymentUrl(result.summary));
        setExternalOpen(true);
      }
    } catch (reason) {
      if (isApiError(reason) && reason.code === "billing_operation_not_applied") {
        seatKey.current = undefined;
        setActionError("The change was not applied. Review a new quote and try again.");
      } else {
        setActionError(actionMessage(reason));
      }
    } finally {
      setBusy("");
    }
  };

  const openPortal = async (): Promise<void> => {
    if (busy !== "") return;
    setBusy("portal");
    setActionError("");
    const tab = pendingTab();
    try {
      const result = await openBillingPortal(companyId);
      tab.go(result.url);
      setExternalOpen(true);
    } catch (reason) {
      tab.close();
      setActionError(actionMessage(reason));
    } finally {
      setBusy("");
    }
  };

  const lifecycleStatus = summary && summary.plan !== "unknown" ? summary.subscriptionStatus : undefined;
  const accessUntil = summary && summary.plan !== "unknown" ? (summary.accessUntil ?? undefined) : undefined;
  const paymentRequired = summary ? summaryPaymentRequired(summary) : false;
  // A subscription exists at the provider when the summary carries a real
  // lifecycle status or unresolved payment work. "none" is the hosted default
  // for an account without a subscription, including an abandoned Checkout.
  const hasSubscription = summary?.plan === "free" && ((lifecycleStatus !== undefined && lifecycleStatus !== "none") || paymentRequired || summary.paymentActionUrl != null);
  const purchaseAllowed = !paymentRequired && (lifecycleStatus === undefined || lifecycleStatus === "none" || TERMINAL_SUBSCRIPTION_STATUSES.has(lifecycleStatus));
  const canPurchase = summary?.plan === "free" && summary.canManageBilling === true && summary.purchaseConfigured && purchaseAllowed;
  const canManage = summary?.canManageBilling === true;
  const showPortal = canManage && summary !== undefined && (summary.plan === "pro" || hasSubscription);
  const statusInactiveCopy = lifecycleStatus === "active" || lifecycleStatus === "trialing" ? "The subscription has no paid access." : "The subscription is not active.";
  const purchaseQuantity = parseSeats(purchaseSeats);
  const seatInputValue = summary?.plan === "pro" && seatSeats === "" ? String(summary.purchasedSeats) : seatSeats;
  const seatQuantity = parseSeats(seatInputValue);

  const link = (href: string, label: string): ReactElement => <a className="text-xs text-primary underline underline-offset-2" href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
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
  const monthlyTotal = summary.plan === "pro" ? formatUsd(summary.monthlySubtotal ?? summary.purchasedSeats * BILLING_SEAT_UNIT_AMOUNT) : "";
  const planDetail = summary.plan === "pro"
    ? [
        `${formatUsd(BILLING_SEAT_UNIT_AMOUNT)} per seat each month`,
        `${summary.purchasedSeats} ${summary.purchasedSeats === 1 ? "seat" : "seats"}`,
        summary.cancelAtPeriodEnd && summary.accessUntil ? `Ends on ${formatDate(summary.accessUntil)}` : summary.renewalAt ? `Renews at ${monthlyTotal} on ${formatDate(summary.renewalAt)}` : undefined,
      ].filter(Boolean).join(" · ")
    : summary.plan === "free"
      ? [`Free includes ${summary.projectLimit} projects`, accessUntil ? `Paid access ended ${formatDate(accessUntil)}` : undefined].filter(Boolean).join(" · ")
      : "Suplex cannot check the subscription.";
  const showDetails = summary.plan === "pro" || hasSubscription || paymentRequired || paymentUrl !== undefined;

  return (
    <>
      {actionError ? <div className="mb-4"><Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert></div> : null}
      <SettingsSection>
        <SettingRow label={summary.plan === "pro" ? "Pro plan" : summary.plan === "free" ? "Free plan" : "Plan not available"} description={summary.purchaseConfigured ? planDetail : <>{planDetail}<br />Billing is not configured. An operator configures the hosted billing service.</>}>
          {showPortal ? <Button size="sm" variant="outline" onClick={() => void openPortal()} disabled={busy !== ""}>Open billing</Button> : null}
        </SettingRow>
      </SettingsSection>
      {canPurchase ? (
        <SettingsSection>
          <SettingRow label="Upgrade to Pro" description={`${formatUsd(BILLING_SEAT_UNIT_AMOUNT)} per seat each month. Taxes are additional.`}>
            {purchaseOpen ? (
              <form className="flex flex-wrap items-center gap-2 sm:justify-end" onSubmit={(event) => void submitPurchase(event)}>
                <div className="w-20"><Input aria-label="Seats" type="number" min={1} max={9999} step={1} value={purchaseSeats} onChange={(event) => setPurchaseSeats(event.target.value)} /></div>
                <Button type="submit" size="sm" disabled={busy !== "" || !seatQuantityValid(purchaseQuantity) || purchaseQuantity < summary.requiredSeats}>{busy === "checkout" ? <Spinner /> : null}Select Pro</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => { setPurchaseOpen(false); checkoutKey.current = undefined; }}>Cancel</Button>
              </form>
            ) : (
              <Button size="sm" onClick={() => { setPurchaseSeats(String(summary.requiredSeats)); setPurchaseOpen(true); setActionError(""); }}>Select Pro</Button>
            )}
          </SettingRow>
          {purchaseOpen ? (
            <p className="pb-3 text-xs text-muted-foreground">
              {!seatQuantityValid(purchaseQuantity)
                ? "Select a seat count."
                : purchaseQuantity < summary.requiredSeats
                  ? `At least ${summary.requiredSeats} seats are necessary.`
                  : `${formatUsd(purchaseQuantity * BILLING_SEAT_UNIT_AMOUNT)} each month before tax.`}
            </p>
          ) : null}
          <ul className="grid gap-2 border-t py-3 text-xs sm:grid-cols-2">
            {PRO_FEATURES.map(feature => <li key={feature} className="flex items-center gap-2"><Check aria-hidden="true" className="size-3.5 text-primary" />{feature}</li>)}
          </ul>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Usage">
        <SettingRow label="Projects" description="Empty projects count toward the allowance.">
          <span className="text-xs text-muted-foreground">{summary.projectCount}{" / "}{summary.plan === "unknown" ? "Unknown" : summary.projectLimit === null ? "Unlimited" : summary.projectLimit}</span>
        </SettingRow>
        {summary.plan === "pro" && summary.canManageBilling ? (
          <SettingRow
            label="Seats"
            description={`${summary.purchasedSeats} purchased, ${summary.requiredSeats} active. ${seatQuantityValid(seatQuantity) && seatQuantity < summary.requiredSeats ? `At least ${summary.requiredSeats} seats are necessary.` : preview ? `New total ${preview.requestedQuantity} seats. Due now ${formatUsd(preview.amountDueNow)}. Each month after ${formatUsd(preview.nextSubtotal)} before tax.` : "Increases charge a prorated amount now."}`}
          >
            {preview ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button size="sm" onClick={() => void confirmIncrease()} disabled={busy !== ""}>{busy === "seats" ? <Spinner /> : null}Save seats</Button>
                <Button size="sm" variant="ghost" onClick={() => { setPreview(undefined); seatKey.current = undefined; }} disabled={busy !== ""}>Cancel</Button>
              </div>
            ) : (
              <form className="flex items-center gap-2" onSubmit={(event) => void submitSeats(event)}>
                <div className="w-20">
                  <Input aria-label="Purchased seats" type="number" min={1} max={9999} step={1} value={seatInputValue} onChange={(event) => { setSeatSeats(event.target.value); setPreview(undefined); seatKey.current = undefined; }} />
                </div>
                <Button type="submit" size="sm" disabled={busy !== "" || !seatQuantityValid(seatQuantity) || seatQuantity === summary.purchasedSeats || seatQuantity < summary.requiredSeats}>Save seats</Button>
              </form>
            )}
          </SettingRow>
        ) : (
          <SettingRow label="Seats" description="Active Suplex accounts use purchased seats.">
            <span className="text-xs text-muted-foreground">{summary.plan === "unknown" ? "Unknown" : summary.purchasedSeats}{" purchased, "}{summary.requiredSeats}{" active"}</span>
          </SettingRow>
        )}
        {summary.plan === "pro" && summary.restriction === "seat_limit_exceeded" ? (
          <div className="border-t py-3"><Alert><AlertDescription>Purchased seats do not cover the active accounts. Suplex blocks new projects beyond the Free allowance until you add seats.</AlertDescription></Alert></div>
        ) : null}
      </SettingsSection>
      {showDetails ? (
        <SettingsSection title="Billing details">
          {summary.plan === "pro" ? (
            <SettingRow label="Monthly total" description={`${formatUsd(BILLING_SEAT_UNIT_AMOUNT)} per seat each month before tax.`}>
              <span className="text-xs text-muted-foreground">{monthlyTotal}</span>
            </SettingRow>
          ) : null}
          {summary.plan === "pro" && summary.cancelAtPeriodEnd ? (
            <SettingRow label="Cancellation" description="Cancellation takes effect at the period end. Pro access continues until then.">
              <span className="text-xs text-muted-foreground">{summary.accessUntil ? formatDate(summary.accessUntil) : "Not available"}</span>
            </SettingRow>
          ) : null}
          {hasSubscription ? (
            <SettingRow label="Status" description={statusInactiveCopy}>
              <span className="text-xs text-muted-foreground">{lifecycleStatus ?? "Not active"}</span>
            </SettingRow>
          ) : null}
          {paymentRequired || paymentUrl ? (
            <SettingRow label="Payment" description="Suplex applies the change after you approve the payment.">
              {paymentUrl ? link(paymentUrl, "Approve the payment") : <span className="text-xs text-muted-foreground">Open billing to approve it.</span>}
            </SettingRow>
          ) : null}
          {summary.plan === "pro" ? <SettingRow label="Payment method and invoices" description="Stripe keeps the payment method, billing address, and invoices. Select Open billing to change them." /> : null}
        </SettingsSection>
      ) : null}
      <AlertDialog open={decreaseQuantity !== undefined} onOpenChange={(open) => { if (!open) { setDecreaseQuantity(undefined); if (seatKey.current?.kind === "decrease") seatKey.current = undefined; } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save fewer seats?</AlertDialogTitle>
            <AlertDialogDescription>Suplex does not refund the remaining paid period. The lower total applies at the next renewal.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDecrease()} disabled={busy !== ""}>Save seats</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

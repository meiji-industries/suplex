import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Spinner } from "../../components/ui/spinner.js";
import { isApiError } from "../../lib/api.js";
import { BILLING_SEAT_UNIT_AMOUNT, type BillingSummary, type HostedSeatPreview } from "../../contracts/billing.js";
import { changeSeats, getBillingSummary, openBillingPortal, previewSeats, startCheckout } from "./lib/billing-api.js";
import { SettingsSection, SettingRow } from "./settings-layout.js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

// USD has two minor-unit digits; the confirmation must show cents exactly.
const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatUsd(minorUnits: number): string {
  // ICU separates the currency code with a non-breaking space; use a plain
  // space so copy reads "USD 40.00" everywhere.
  return usdFormatter.format(minorUnits / 100).replace(/\u00A0/g, " ");
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
  const [checkoutUrl, setCheckoutUrl] = useState<string>();
  const [portalUrl, setPortalUrl] = useState<string>();
  const [paymentUrl, setPaymentUrl] = useState<string>();
  const [externalOpen, setExternalOpen] = useState(false);

  const generation = useRef(0);
  const pollTimer = useRef<number | undefined>(undefined);
  const checkoutKey = useRef<{ key: string; quantity: number } | undefined>(undefined);
  const seatKey = useRef<SeatCommandIntent | undefined>(undefined);

  const stopPolling = useCallback((): void => {
    if (pollTimer.current !== undefined) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    }
  }, []);

  const applySummary = useCallback((next: BillingSummary): void => {
    setSummary(next);
    setState("ready");
    setErrorText("");
    setPaymentUrl(summaryPaymentUrl(next));
    if (next.plan === "pro" && !next.paymentActionRequired) {
      setExternalOpen(false);
      setCheckoutUrl(undefined);
    }
  }, []);

  const load = useCallback(async (silent = false): Promise<void> => {
    const gen = generation.current;
    if (!silent) setState("loading");
    try {
      const next = await getBillingSummary(companyId);
      if (gen !== generation.current) return;
      applySummary(next);
      if (next.plan === "pro" && !next.paymentActionRequired) stopPolling();
    } catch (reason) {
      if (gen !== generation.current) return;
      setState("error");
      setErrorText(reason instanceof Error ? reason.message : "Suplex cannot check the subscription.");
    }
  }, [companyId, applySummary, stopPolling]);

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
    setCheckoutUrl(undefined);
    setPortalUrl(undefined);
    setPaymentUrl(undefined);
    setExternalOpen(false);
    checkoutKey.current = undefined;
    seatKey.current = undefined;
    void load();
    return () => {
      generation.current += 1;
      stopPolling();
    };
  }, [companyId, load, stopPolling]);

  useEffect(() => {
    if (!externalOpen) return;
    const onFocus = (): void => { void load(true); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [externalOpen, load]);

  const checkSubscription = useCallback((): void => {
    setBusy("check");
    void load().finally(() => setBusy(""));
    if (!externalOpen) return;
    // The administrator explicitly checks after an external payment. Poll the
    // server state for at most 30 seconds; a return URL never grants Pro.
    stopPolling();
    const deadline = Date.now() + 30_000;
    pollTimer.current = window.setInterval(() => {
      if (Date.now() >= deadline) {
        stopPolling();
        return;
      }
      void load(true);
    }, 2_000);
  }, [externalOpen, load, stopPolling]);

  const submitPurchase = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const quantity = parseSeats(purchaseSeats);
    if (!seatQuantityValid(quantity) || busy !== "") return;
    setBusy("checkout");
    setActionError("");
    try {
      if (!checkoutKey.current || checkoutKey.current.quantity !== quantity) {
        checkoutKey.current = { key: crypto.randomUUID(), quantity };
      }
      const result = await startCheckout(companyId, quantity, checkoutKey.current.key);
      if (result.status === "redirect") {
        setCheckoutUrl(result.url);
        setExternalOpen(true);
        setPurchaseOpen(false);
      } else {
        applySummary(result.summary);
        if (result.status === "subscribed") checkoutKey.current = undefined;
        if (result.status === "payment_required") {
          setPaymentUrl(result.url ?? summaryPaymentUrl(result.summary));
          setExternalOpen(true);
        }
        setPurchaseOpen(false);
      }
    } catch (reason) {
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
    try {
      const result = await openBillingPortal(companyId);
      setPortalUrl(result.url);
      setExternalOpen(true);
    } catch (reason) {
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

  return (
    <SettingsSection>
      {state === "loading" ? (
        <div className="space-y-2 px-4 py-3.5" aria-busy="true" aria-label="Billing status">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner /><span>Billing status</span></div>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      ) : state === "error" ? (
        <div className="space-y-2 px-4 py-3.5">
          <Alert variant="destructive"><AlertDescription>{errorText}</AlertDescription></Alert>
          <div><Button size="sm" variant="outline" onClick={checkSubscription} disabled={busy === "check"}>Check subscription</Button></div>
        </div>
      ) : summary ? (
        <>
          <SettingRow
            label="Plan"
            description={summary.plan === "pro" ? "Pro costs USD 20 per seat each month. Taxes are additional." : summary.plan === "free" ? `Free includes ${summary.projectLimit} projects.` : "Suplex cannot check the subscription."}
          >
            <span className="text-xs text-muted-foreground">{summary.plan === "pro" ? "Pro" : summary.plan === "free" ? "Free" : "Unknown"}</span>
          </SettingRow>
          <SettingRow label="Projects" description="Empty projects count toward the allowance.">
            <span className="text-xs text-muted-foreground">
              {summary.projectCount}{" / "}{summary.plan === "unknown" ? "Unknown" : summary.projectLimit === null ? "Unlimited" : summary.projectLimit}
            </span>
          </SettingRow>
          <SettingRow label="Seats" description="Active Suplex accounts use purchased seat capacity.">
            <span className="text-xs text-muted-foreground">
              {summary.plan === "unknown" ? "Unknown" : summary.purchasedSeats}{" purchased, "}{summary.requiredSeats}{" active"}
            </span>
          </SettingRow>
          {summary.plan === "pro" ? (
            <SettingRow label="Monthly total" description={`${formatUsd(BILLING_SEAT_UNIT_AMOUNT)} per seat each month before tax.`}>
              <span className="text-xs text-muted-foreground">{formatUsd(summary.monthlySubtotal ?? summary.purchasedSeats * BILLING_SEAT_UNIT_AMOUNT)}</span>
            </SettingRow>
          ) : null}
          {summary.plan === "pro" && (summary.renewalAt || summary.cancelAtPeriodEnd) ? (
            <SettingRow label="Renewal" {...(summary.cancelAtPeriodEnd ? { description: "Cancellation takes effect at the period end. Pro access continues until then." } : {})}>
              <span className="text-xs text-muted-foreground">{summary.cancelAtPeriodEnd && summary.accessUntil ? formatDate(summary.accessUntil) : summary.renewalAt ? formatDate(summary.renewalAt) : "Not available"}</span>
            </SettingRow>
          ) : null}
          {hasSubscription ? (
            <SettingRow label="Status" description={statusInactiveCopy}>
              <span className="text-xs text-muted-foreground">{lifecycleStatus ?? "Not active"}</span>
            </SettingRow>
          ) : null}
          {summary.plan === "free" && accessUntil ? (
            <SettingRow label="Access">
              <span className="text-xs text-muted-foreground">Paid access ended {formatDate(accessUntil)}</span>
            </SettingRow>
          ) : null}
          {summary.plan === "pro" && summary.restriction === "seat_limit_exceeded" ? (
            <div className="px-4 py-3">
              <Alert><AlertDescription>Purchased seats do not cover the active accounts. Suplex blocks new projects beyond the Free allowance until you add seats.</AlertDescription></Alert>
            </div>
          ) : null}
          {!summary.purchaseConfigured ? (
            <SettingRow label="Setup" description="An operator configures the hosted billing service.">
              <span className="text-xs text-muted-foreground">Billing is not configured.</span>
            </SettingRow>
          ) : null}
          {paymentRequired || paymentUrl ? (
            <SettingRow label="Payment" description="Suplex applies the change after you approve the payment.">
              {paymentUrl
                ? <a className="text-xs text-primary underline underline-offset-2" href={paymentUrl} target="_blank" rel="noopener noreferrer">Approve the payment</a>
                : <span className="text-xs text-muted-foreground">Open billing to approve it.</span>}
            </SettingRow>
          ) : null}
          {canPurchase ? (
            <SettingRow label="Pro" description="Pro costs USD 20 per seat each month. Taxes are additional.">
              {purchaseOpen ? (
                <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void submitPurchase(event)}>
                  <div className="w-24"><Input aria-label="Seats" type="number" min={1} max={9999} step={1} value={purchaseSeats} onChange={(event) => setPurchaseSeats(event.target.value)} /></div>
                  <span className="text-xs text-muted-foreground">
                    {!seatQuantityValid(purchaseQuantity)
                      ? "Select a seat count."
                      : summary.plan === "free" && purchaseQuantity < summary.requiredSeats
                        ? `At least ${summary.requiredSeats} seats are necessary.`
                        : `${formatUsd(purchaseQuantity * BILLING_SEAT_UNIT_AMOUNT)} each month before tax.`}
                  </span>
                  <Button type="submit" size="sm" disabled={busy !== "" || !seatQuantityValid(purchaseQuantity) || purchaseQuantity < summary.requiredSeats}>{busy === "checkout" ? <Spinner /> : null}Select Pro</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setPurchaseOpen(false); checkoutKey.current = undefined; }}>Cancel</Button>
                </form>
              ) : (
                <Button size="sm" onClick={() => { setPurchaseSeats(String(summary.requiredSeats)); setPurchaseOpen(true); setActionError(""); }}>Select Pro</Button>
              )}
            </SettingRow>
          ) : null}
          {summary.plan === "pro" && summary.canManageBilling ? (
            <SettingRow
              label="Purchased seats"
              description={seatQuantityValid(seatQuantity) && seatQuantity < summary.requiredSeats ? `At least ${summary.requiredSeats} seats are necessary.` : "Select a new seat count. Increases charge a prorated amount now."}
            >
              {preview ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="text-xs text-muted-foreground">Due now {formatUsd(preview.amountDueNow)}. Each month after {formatUsd(preview.nextSubtotal)} before tax.</span>
                  <Button size="sm" onClick={() => void confirmIncrease()} disabled={busy !== ""}>{busy === "seats" ? <Spinner /> : null}Save seats</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setPreview(undefined); seatKey.current = undefined; }} disabled={busy !== ""}>Cancel</Button>
                </div>
              ) : (
                <form className="flex items-center gap-2" onSubmit={(event) => void submitSeats(event)}>
                  <div className="w-24">
                    <Input
                      aria-label="Purchased seats"
                      type="number"
                      min={1}
                      max={9999}
                      step={1}
                      value={seatInputValue}
                      onChange={(event) => { setSeatSeats(event.target.value); setPreview(undefined); seatKey.current = undefined; }}
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={busy !== "" || !seatQuantityValid(seatQuantity) || seatQuantity === summary.purchasedSeats || seatQuantity < summary.requiredSeats}>Save seats</Button>
                </form>
              )}
            </SettingRow>
          ) : null}
          {canManage ? (
            <SettingRow label="Subscription">
              <div className="flex flex-wrap items-center gap-2">
                {showPortal ? <Button size="sm" variant="outline" onClick={() => void openPortal()} disabled={busy !== ""}>Open billing</Button> : null}
                <Button size="sm" variant="outline" onClick={checkSubscription} disabled={busy === "check"}>{busy === "check" ? <Spinner /> : null}Check subscription</Button>
              </div>
            </SettingRow>
          ) : null}
          {checkoutUrl ? (
            <SettingRow label="Checkout" description="The checkout page opens in a new tab. Suplex checks the result when you return.">
              <a className="text-xs text-primary underline underline-offset-2" href={checkoutUrl} target="_blank" rel="noopener noreferrer">Open checkout</a>
            </SettingRow>
          ) : null}
          {portalUrl ? (
            <SettingRow label="Billing portal" description="The billing portal opens in a new tab.">
              <a className="text-xs text-primary underline underline-offset-2" href={portalUrl} target="_blank" rel="noopener noreferrer">Open billing</a>
            </SettingRow>
          ) : null}
          {actionError ? (
            <div className="px-4 py-3"><Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert></div>
          ) : null}
        </>
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
    </SettingsSection>
  );
}

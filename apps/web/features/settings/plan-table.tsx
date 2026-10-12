import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { PRO_ANNUAL_AMOUNT, PRO_MONTHLY_AMOUNT, TEAM_ANNUAL_AMOUNT, TEAM_ANNUAL_SEAT_AMOUNT, TEAM_INCLUDED_SEATS, TEAM_MONTHLY_AMOUNT, TEAM_MONTHLY_SEAT_AMOUNT, type BillingInterval, type BillingSummary, type Plan } from "../../contracts/billing.js";
import { cn } from "../../lib/utils.js";
import { Check, Minus } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

const PLANS: Plan[] = ["free", "pro", "team"];
const NAMES: Record<Plan, string> = { free: "Free", pro: "Pro", team: "Team" };
const ROWS: Array<[string, Record<Plan, ReactNode>]> = [
  ["Companies", { free: "1", pro: "3", team: "Unlimited" }],
  ["Projects", { free: "2", pro: "25", team: "Unlimited" }],
  ["Tasks at a time", { free: "3", pro: "Unlimited", team: "Unlimited" }],
  ["Tasks each month", { free: "50", pro: "Unlimited", team: "Unlimited" }],
  ["Seats", { free: "1", pro: "1", team: `${TEAM_INCLUDED_SEATS} included, then each seat` }],
  ["Choose what each teammate sees and changes", { free: <Minus aria-label="No" className="size-3.5" />, pro: <Minus aria-label="No" className="size-3.5" />, team: <Check aria-label="Yes" className="size-3.5" /> }],
];

/** Subscription statuses that no longer hold a plan; a new plan starts with Checkout. */
const ENDED = new Set(["none", "canceled", "incomplete_expired"]);

export type PlanTarget = { plan: Plan; interval: BillingInterval; quantity: number };

// USD has two minor-unit digits. Whole dollars read "$20"; any cents are exact: "$13.33".
export function formatUsd(minorUnits: number): string {
  const digits = minorUnits % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minorUnits / 100);
}

export function teamAmount(interval: BillingInterval, seats: number): number {
  const [flat, seat] = interval === "year" ? [TEAM_ANNUAL_AMOUNT, TEAM_ANNUAL_SEAT_AMOUNT] : [TEAM_MONTHLY_AMOUNT, TEAM_MONTHLY_SEAT_AMOUNT];
  return flat + Math.max(0, seats - TEAM_INCLUDED_SEATS) * seat;
}

/**
 * Free, Pro, and Team side by side. Without a live subscription a paid plan
 * starts with Checkout (or the Pro trial); with one, every change opens the
 * Stripe page that confirms that exact change.
 */
export function PlanTable({ summary, canChange, busy, onTrial, onCheckout, onChange }: {
  summary: BillingSummary;
  canChange: boolean;
  busy: string;
  onTrial: () => void;
  onCheckout: (target: PlanTarget) => void;
  onChange: (target: PlanTarget) => void;
}): ReactElement {
  const [interval, setInterval] = useState<BillingInterval>(summary.interval ?? "month");
  const [seats, setSeats] = useState(Math.max(TEAM_INCLUDED_SEATS, summary.plan === "team" ? summary.purchasedSeats : summary.seatsUsed));
  const live = summary.subscriptionStatus !== null && !ENDED.has(summary.subscriptionStatus);
  const current = (plan: Plan): boolean => plan === summary.plan && (plan === "free" || (interval === (summary.interval ?? "month") && (plan !== "team" || seats === summary.purchasedSeats)));
  const period = interval === "year" ? "/yr" : "/mo";
  // The current plan's column is shaded, like a selected row.
  const highlight = (plan: Plan): string | undefined => plan === summary.plan ? "bg-muted" : undefined;

  const price = (plan: Plan): ReactNode => {
    if (plan === "free") return "$0";
    if (plan === "pro") return <>{formatUsd(interval === "year" ? PRO_ANNUAL_AMOUNT : PRO_MONTHLY_AMOUNT)}{period}</>;
    return <>{formatUsd(teamAmount(interval, seats))}{period} <span className="text-muted-foreground">for {seats} seats</span></>;
  };

  const action = (plan: Plan): ReactNode => {
    if (current(plan)) return <span className="text-xs text-muted-foreground">Current plan</span>;
    if (!canChange) return null;
    const target = { plan, interval, quantity: plan === "team" ? seats : 1 };
    const pending = busy === `plan:${plan}`;
    const disabled = busy !== "";
    if (!live) {
      if (plan === "free") return null;
      if (plan === "pro" && summary.trialAvailable && interval === "month") {
        return <Button size="sm" onClick={onTrial} disabled={disabled}>{busy === "trial" ? <Spinner /> : null}Start 14-day trial</Button>;
      }
      return <Button size="sm" onClick={() => onCheckout(target)} disabled={disabled}>{pending ? <Spinner /> : null}Select {NAMES[plan]}</Button>;
    }
    if (plan === "free") return <Button size="sm" variant="outline" onClick={() => onChange(target)} disabled={disabled}>{pending ? <Spinner /> : null}Cancel plan</Button>;
    const label = plan !== summary.plan ? `Switch to ${NAMES[plan]}`
      : interval !== (summary.interval ?? "month") ? `Switch to ${interval === "year" ? "annual" : "monthly"}`
        : "Change seats";
    return <Button size="sm" onClick={() => onChange(target)} disabled={disabled}>{pending ? <Spinner /> : null}{label}</Button>;
  };

  const seatsInput = <div className="w-16"><Input size="sm" type="number" min={TEAM_INCLUDED_SEATS} max={9999} aria-label="Team seats" title="Team seats" value={seats} onChange={event => setSeats(Math.min(9999, Math.max(TEAM_INCLUDED_SEATS, Math.trunc(Number(event.target.value)) || TEAM_INCLUDED_SEATS)))} /></div>;

  return (
    <div className="py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs value={interval} onValueChange={next => setInterval(next as BillingInterval)}>
          <TabsList aria-label="Billing period"><TabsTrigger value="month">Monthly</TabsTrigger><TabsTrigger value="year">Annual (save 20%)</TabsTrigger></TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">Prices are in USD. Taxes are additional.</span>
      </div>
      <div className="grid gap-3 md:hidden">
        {PLANS.map(plan => (
          <div key={plan} className={cn("grid gap-2 rounded-md p-2", plan === summary.plan ? "bg-muted" : "")}>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-medium">{NAMES[plan]}{plan === summary.plan ? <Badge variant="secondary">Current</Badge> : null}</span>
              <span className="text-sm">{price(plan)}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {ROWS.map(([label, values]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd>{values[plan]}</dd></div>)}
            </dl>
            <div className="flex flex-wrap items-center gap-2">{plan === "team" && canChange ? seatsInput : null}{action(plan)}</div>
          </div>
        ))}
      </div>
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead><span className="sr-only">Plan feature</span></TableHead>
            {PLANS.map(plan => <TableHead key={plan} className={highlight(plan)}><span className="flex items-center gap-2">{NAMES[plan]}{plan === summary.plan ? <Badge variant="secondary">Current</Badge> : null}</span></TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="text-muted-foreground">Price</TableCell>
            {PLANS.map(plan => <TableCell key={plan} className={highlight(plan)}>{price(plan)}</TableCell>)}
          </TableRow>
          {ROWS.map(([label, values]) => (
            <TableRow key={label}>
              <TableCell className="text-muted-foreground">{label}</TableCell>
              {PLANS.map(plan => <TableCell key={plan} className={highlight(plan)}>{values[plan]}</TableCell>)}
            </TableRow>
          ))}
          <TableRow>
            <TableCell><span className="sr-only">Plan action</span></TableCell>
            <TableCell className={highlight("free")}>{action("free")}</TableCell>
            <TableCell className={highlight("pro")}>{action("pro")}</TableCell>
            <TableCell className={highlight("team")}>
              <div className="flex flex-wrap items-center gap-2">
                {canChange ? seatsInput : null}
                {action("team")}
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      {canChange && !live && summary.trialAvailable ? <p className="mt-2 text-xs text-muted-foreground">The 14-day Pro trial needs no credit card.</p> : null}
      {canChange && live ? <p className="mt-2 text-xs text-muted-foreground">Stripe shows the amount and asks you to confirm each change. An upgrade credits the unused time and charges the difference now; a downgrade applies at the end of the period.</p> : null}
    </div>
  );
}

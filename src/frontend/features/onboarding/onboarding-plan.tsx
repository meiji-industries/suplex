import type { ReactElement } from "react";

import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.js";
import { Table, TableBody, TableCell, TableRow } from "../../components/ui/table.js";
import { PRO_MONTHLY_AMOUNT } from "../../contracts/billing.js";

export type OnboardingPlan = "free" | "pro";

export function OnboardingPlanPicker({ value, onChange, projectCount, trialAvailable = false, disabled = false }: {
  value: OnboardingPlan;
  onChange: (plan: OnboardingPlan) => void;
  projectCount: number;
  trialAvailable?: boolean;
  disabled?: boolean;
}): ReactElement {
  const plans = [
    { id: "free", label: "Free", detail: "1 company, 1 project, 3 tasks at a time, 50 tasks each month", price: "$0", interval: "/month", disabled: projectCount >= 2 },
    { id: "pro", label: "Pro", detail: "3 companies, 10 projects, unlimited tasks", price: `$${PRO_MONTHLY_AMOUNT / 100}`, interval: "/month", disabled: false },
    { id: "enterprise", label: "Enterprise", detail: "", price: "", interval: "", disabled: true },
  ];

  return <div className="space-y-3">
    <RadioGroup aria-label="Plan" value={value} disabled={disabled} onValueChange={next => {
      if (next === "pro" || (next === "free" && projectCount < 2)) onChange(next);
    }}>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableBody>
            {plans.map(plan => <TableRow key={plan.id} data-state={value === plan.id ? "selected" : undefined}>
              <TableCell>
                <label className={`grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-3 px-2 py-3 sm:px-3 ${plan.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
                  <RadioGroupItem value={plan.id} disabled={plan.disabled} aria-label={plan.label} />
                  <span className="min-w-0 whitespace-normal">
                    <span className="block font-medium">{plan.label}</span>
                    {plan.detail ? <span className="mt-1 block text-xs text-muted-foreground">{plan.detail}</span> : null}
                  </span>
                  {plan.price ? <span className="text-right text-sm">
                    {plan.price}<span className="block text-xs text-muted-foreground sm:inline">{plan.interval}</span>
                  </span> : null}
                </label>
              </TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
    </RadioGroup>
    <p className="text-xs text-muted-foreground">
      {value === "free" ? "No credit card is necessary." : trialAvailable ? "Pro is free for 30 days. No credit card is necessary." : projectCount >= 2 ? "Pro is necessary for 2 or more projects." : "Taxes are additional."}
    </p>
  </div>;
}

import type { ReactElement } from "react";
import { compact, costExplanation, money, tokenExplanation } from "../../features/analytics/lib/analytics.js";
import { useUsageDisplay } from "../../features/analytics/lib/usage-display.js";

export function CostValue({ value, tokens, subsidized, partial, className, suffix = "" }: {
  value: number | null;
  tokens: number | null;
  subsidized: boolean;
  partial: boolean;
  className?: string;
  suffix?: string;
}): ReactElement {
  const display = useUsageDisplay();
  const text = display === "tokens" ? tokens === null ? "Not available" : compact(tokens) : money(value);
  const explanation = display === "tokens" ? tokenExplanation(partial) : costExplanation(subsidized, partial);
  return <span className={className} title={explanation} aria-label={`${text}. ${explanation}`}>{text}{suffix}</span>;
}

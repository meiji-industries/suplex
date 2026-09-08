import type { ReactElement } from "react";
import { costExplanation, money } from "../../features/analytics/lib/analytics.js";

export function CostValue({ value, subsidized, partial, className, suffix = "" }: {
  value: number | null;
  subsidized: boolean;
  partial: boolean;
  className?: string;
  suffix?: string;
}): ReactElement {
  const text = money(value);
  const explanation = costExplanation(subsidized, partial);
  return <span className={className} title={explanation} aria-label={`${text}. ${explanation}`}>{text}{suffix}</span>;
}

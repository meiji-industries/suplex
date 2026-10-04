export { useTaskCosts } from "../../tasks/task-data.js";

// Formatters are module constants: constructing one per call is slow, and list rows call these on every poll.
const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function money(value: number | null): string {
  if (value === null) return "Not available";
  if (value > 0 && value < 0.01) return "<$0.01";
  return usdFormat.format(value);
}
export function costExplanation(subsidized: boolean, partial: boolean): string {
  if (subsidized) return `OpenCode reported zero cost. Suplex estimates this value with the public models.dev list price. Suplex estimates are not bills.${partial ? " Usage is partial." : ""}`;
  return `Estimated cost (USD)${partial ? ", partial usage" : ""}. OpenCode estimates are not bills.`;
}
export function duration(value: number | null): string {
  if (value === null) return "Not available";
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}
export function compact(value: number): string { return compactFormat.format(value); }

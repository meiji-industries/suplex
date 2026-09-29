import type { TaskAnalytics } from "../../../contracts/analytics.js";
import type { TaskUsage } from "../../../contracts/usage.js";
import { usageIsUnpriced } from "./usage-metrics.js";

const daysPerWeek = 7;
const chartWeeks = 54;

export const activityMetrics = ["spend", "tokens", "turns"] as const;
export type ActivityMetric = (typeof activityMetrics)[number];

export type ActivityCell = { date: string; future: false; value: number; level: 0 | 1 | 2 | 3 | 4 } | { date: string; future: true; value: null; level: null };
export type ActivityWeek = { cells: ActivityCell[] };
export type ActivityMonthLabel = { label: string; week: number };
export type ActivityStats = { total: number; longestStreak: number; averagePerDay: number; averagePerWeek: number; days: number; weeks: number };
export type ActivityData = { weeks: ActivityWeek[]; monthLabels: ActivityMonthLabel[]; stats: ActivityStats };

function localDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function usageValue(usage: TaskUsage, metric: ActivityMetric): number {
  if (metric === "spend") return usageIsUnpriced(usage) ? 0 : usage.cost;
  if (metric === "tokens") return usage.tokens.input + usage.tokens.output + usage.tokens.reasoning + usage.tokens.cache.read + usage.tokens.cache.write;
  return 0;
}

function level(value: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value === 0) return 0;
  if (value <= thresholds[0]!) return 1;
  if (value <= thresholds[1]!) return 2;
  if (value <= thresholds[2]!) return 3;
  return 4;
}

function longestStreak(values: number[]): number {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    current = value > 0 ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

export function buildActivity(tasks: TaskAnalytics[], metric: ActivityMetric, now: Date): ActivityData {
  const today = localDay(now);
  const firstDay = addDays(addDays(today, -today.getDay()), -(chartWeeks - 1) * daysPerWeek);
  const values = new Map<string, number>();
  const turns = new Map<string, Set<string>>();

  for (const task of tasks) for (const usage of task.usage) {
    const date = localDay(new Date(usage.startedAt));
    if (date < firstDay || date > today) continue;
    const key = dayKey(date);
    if (metric === "turns") {
      const dayTurns = turns.get(key) ?? new Set<string>();
      dayTurns.add(`${usage.sessionId}:${usage.turnId}`);
      turns.set(key, dayTurns);
    } else values.set(key, (values.get(key) ?? 0) + usageValue(usage, metric));
  }
  if (metric === "turns") for (const [key, dayTurns] of turns) values.set(key, dayTurns.size);

  const dates = Array.from({ length: chartWeeks * daysPerWeek }, (_, index) => addDays(firstDay, index));
  const completeDates = dates.filter(date => date <= today);
  const dayValues = completeDates.map(date => values.get(dayKey(date)) ?? 0);
  const nonZeroValues = dayValues.filter(value => value > 0).sort((left, right) => left - right);
  const thresholds = [0.25, 0.5, 0.75].map(quantile => nonZeroValues[Math.ceil(nonZeroValues.length * quantile) - 1] ?? 0);
  const weeks = Array.from({ length: chartWeeks }, (_, week) => ({
    cells: dates.slice(week * daysPerWeek, (week + 1) * daysPerWeek).map(date => {
      if (date > today) return { date: dayKey(date), future: true as const, value: null, level: null };
      const value = values.get(dayKey(date)) ?? 0;
      return { date: dayKey(date), future: false as const, value, level: level(value, thresholds) };
    }),
  }));
  const monthLabels = weeks.flatMap((week, index) => {
    const date = week.cells.map(cell => new Date(`${cell.date}T00:00:00`)).find(value => value.getDate() === 1)
      ?? (index === 0 ? new Date(`${week.cells[0]!.date}T00:00:00`) : undefined);
    return date ? [{ label: new Intl.DateTimeFormat(undefined, { month: "short" }).format(date), week: index }] : [];
  }).filter((label, index, labels) => index !== 0 || labels[1] === undefined || labels[1].week - label.week >= 3);
  const total = dayValues.reduce((sum, value) => sum + value, 0);
  return { weeks, monthLabels, stats: { total, longestStreak: longestStreak(dayValues), averagePerDay: total / completeDates.length, averagePerWeek: total / chartWeeks, days: completeDates.length, weeks: chartWeeks } };
}

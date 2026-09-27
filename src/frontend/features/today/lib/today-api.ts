import { readJson } from "../../../lib/api.js";
import { TodayResponseSchema, type Today } from "../../../contracts/today.js";

export type TodayWeek = { startsAt: string; endsAt: string };

export function currentLocalWeek(now: Date): TodayWeek {
  const start = new Date(now);
  const day = start.getDay();
  start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

export async function getToday(week: TodayWeek, signal?: AbortSignal): Promise<Today> {
  const query = new URLSearchParams({ weekStartsAt: week.startsAt, weekEndsAt: week.endsAt });
  return TodayResponseSchema.parse(await readJson(`/api/today?${query}`, signal ? { signal } : undefined));
}

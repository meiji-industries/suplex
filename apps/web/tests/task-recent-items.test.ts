import { expect, test } from "vitest";
import { recentItems } from "../features/tasks/lib/task-list.js";

const now = new Date(Date.UTC(2026, 9, 7, 12));
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const at = (item: { at: string }) => item.at;

test("recent items keeps the last seven days in the given order and drops older items", () => {
  const items = [{ at: daysAgo(0) }, { at: daysAgo(6.9) }, { at: daysAgo(30) }, { at: daysAgo(7.1) }, { at: daysAgo(3) }];
  expect(recentItems(items, at, now)).toEqual([items[0], items[1], items[4]]);
});

test("recent items keeps an item exactly at the window boundary", () => {
  expect(recentItems([{ at: daysAgo(7) }], at, now)).toHaveLength(1);
});

test("recent items handles an empty list and a custom window", () => {
  expect(recentItems([], at, now)).toEqual([]);
  expect(recentItems([{ at: daysAgo(2) }], at, now, 1)).toEqual([]);
});

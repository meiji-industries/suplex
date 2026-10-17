import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";

const render = (variant?: "line" | "pill") => renderToStaticMarkup(createElement(Tabs, { value: "b" }, createElement(TabsList, { variant },
  createElement(TabsTrigger, { value: "a" }, "A"), createElement(TabsTrigger, { value: "b" }, "B"))));
const classesOf = (html: string, slot: string) => [...html.matchAll(new RegExp(`data-slot="${slot}"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*data-slot="${slot}"`, "g"))].map(match => match[1] ?? match[2] ?? "");

test("a bare TabsList is a flat, rounded, bordered pill list with a sliding indicator", () => {
  const html = render();
  const [list] = classesOf(html, "tabs-list"); const [indicator] = classesOf(html, "tabs-indicator"); const triggers = classesOf(html, "tabs-trigger");
  expect(list).toContain("rounded-full"); expect(list).toContain("border"); expect(list).toContain("bg-background"); expect(list).not.toContain("rounded-lg");
  expect(indicator).toContain("rounded-full"); expect(indicator).toContain("bg-muted"); expect(indicator).toContain("border");
  expect(indicator).toContain("left-(--active-tab-left)"); expect(indicator).toContain("w-(--active-tab-width)");
  expect(indicator).toContain("transition-[left,width]"); expect(indicator).toContain("motion-reduce:transition-none");
  expect(triggers).toHaveLength(2);
  for (const value of [list, indicator, ...triggers]) expect(value).not.toMatch(/shadow/);
  for (const trigger of triggers) { expect(trigger).toContain("text-muted-foreground"); expect(trigger).toContain("hover:text-foreground"); expect(trigger).toContain("data-active:text-foreground"); expect(trigger).toContain("focus-visible:ring-[3px]"); }
});

test("the line variant remains transparent and uses the active underline without an indicator", () => {
  const html = render("line");
  expect(html).not.toContain("tabs-indicator");
  expect(classesOf(html, "tabs-list")[0]).toContain("bg-transparent");
  for (const trigger of classesOf(html, "tabs-trigger")) {
    expect(trigger).toContain("rounded-md");
    expect(trigger).toContain("data-active:text-foreground");
    expect(trigger).toContain("dark:data-active:text-foreground");
    expect(trigger).toContain("group-data-[variant=line]/tabs-list:data-active:after:opacity-100");
  }
});

test("Date range, task source picker, and list view tabs use the pill variant", () => {
  for (const path of [
    "../components/app/date-range-filter.tsx",
    "../features/tasks/task-source-picker.tsx",
    "../components/app/data-list.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).toMatch(/<TabsList variant="pill">/);
  }
});

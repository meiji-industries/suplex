import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { Tabs, TabsList, TabsTrigger } from "../src/frontend/components/ui/tabs.js";

const render = (variant?: "default" | "line" | "pill") => renderToStaticMarkup(createElement(Tabs, { value: "b" }, createElement(TabsList, { variant },
  createElement(TabsTrigger, { value: "a" }, "A"), createElement(TabsTrigger, { value: "b" }, "B"))));
const classesOf = (html: string, slot: string) => [...html.matchAll(new RegExp(`data-slot="${slot}"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*data-slot="${slot}"`, "g"))].map(match => match[1] ?? match[2] ?? "");

test("the pill variant is a flat, rounded, bordered list with a sliding indicator", () => {
  const html = render("pill");
  const [list] = classesOf(html, "tabs-list"); const [indicator] = classesOf(html, "tabs-indicator"); const triggers = classesOf(html, "tabs-trigger");
  expect(list).toContain("rounded-full"); expect(list).toContain("border"); expect(list).toContain("bg-background"); expect(list).not.toContain("rounded-lg");
  expect(indicator).toContain("rounded-full"); expect(indicator).toContain("bg-muted"); expect(indicator).toContain("border");
  expect(indicator).toContain("left-(--active-tab-left)"); expect(indicator).toContain("w-(--active-tab-width)");
  expect(indicator).toContain("transition-[left,width]"); expect(indicator).toContain("motion-reduce:transition-none");
  expect(triggers).toHaveLength(2);
  for (const value of [list, indicator, ...triggers]) expect(value).not.toMatch(/shadow/);
  for (const trigger of triggers) { expect(trigger).toContain("text-muted-foreground"); expect(trigger).toContain("hover:text-foreground"); expect(trigger).toContain("data-active:text-foreground"); expect(trigger).toContain("focus-visible:ring-[3px]"); }
});

test("the default and line variants keep their triggers and render no indicator", () => {
  for (const variant of [undefined, "line"] as const) {
    const html = render(variant);
    expect(html).not.toContain("tabs-indicator");
    for (const trigger of classesOf(html, "tabs-trigger")) { expect(trigger).toContain("rounded-md"); expect(trigger).toContain("group-data-[variant=default]/tabs-list:data-active:shadow-sm"); }
  }
  expect(classesOf(render(), "tabs-list")[0]).toContain("bg-muted");
  expect(classesOf(render("line"), "tabs-list")[0]).toContain("bg-transparent");
});

test("the task filter tabs use the pill variant", () => {
  const source = readFileSync(new URL("../src/frontend/features/tasks/tasks.tsx", import.meta.url), "utf8");
  expect(source).toContain('setStatus(value === "archived" ? "all" : String(value)); }}><TabsList variant="pill">');
});

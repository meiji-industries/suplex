import { afterEach, expect, test, vi } from "vitest";

import { animateReorderedAgentRow } from "../src/frontend/components/app/agents-leaderboard.js";

const originalWindow = globalThis.window;
const originalElement = globalThis.Element;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: originalElement });
});

test("only animates rows whose rendered order changes", () => {
  const animate = vi.fn();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });
  class MockElement {}
  Object.defineProperty(MockElement.prototype, "animate", { value: animate });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: MockElement });
  const rows = {
    alpha: new MockElement(),
    bravo: new MockElement(),
    charlie: new MockElement(),
  } as unknown as Record<string, Element>;
  const firstRender: Record<string, { index: number; top: number }> = {
    alpha: { index: 0, top: 0 },
    bravo: { index: 1, top: 36 },
    charlie: { index: 2, top: 72 },
  };

  for (const [id, position] of Object.entries(firstRender)) animateReorderedAgentRow(rows[id]!, undefined, position);
  for (const [id, position] of Object.entries(firstRender)) animateReorderedAgentRow(rows[id]!, position, position);
  expect(animate).not.toHaveBeenCalled();

  const swappedRender: Record<string, { index: number; top: number }> = {
    alpha: { index: 1, top: 36 },
    bravo: { index: 0, top: 0 },
    charlie: { index: 2, top: 72 },
  };
  for (const [id, position] of Object.entries(swappedRender)) animateReorderedAgentRow(rows[id]!, firstRender[id], position);

  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate).toHaveBeenNthCalledWith(1, [{ transform: "translateY(-36px)" }, { transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
  expect(animate).toHaveBeenNthCalledWith(2, [{ transform: "translateY(36px)" }, { transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
});
